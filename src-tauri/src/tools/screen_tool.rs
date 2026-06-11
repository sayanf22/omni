use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::screen::capture_full_screen;
use crate::automation::ocr::{ocr_screen_internal, ocr_find_text_coords};
use crate::automation::uia::get_ui_tree_json;
use base64::{Engine as _, engine::general_purpose::STANDARD};

pub struct ScreenTool;

impl ScreenTool {
    pub fn new() -> Self { Self }
}

/// When a vision-capable model is active, call the AI to describe the screenshot
/// instead of using Windows OCR. This is more accurate and reads UI elements,
/// icons, and styled text that Windows OCR misses.
async fn vision_ocr(screenshot_b64: &str) -> anyhow::Result<String> {
    use crate::ai::{call_ai_chat, ChatMessage, TaskType};

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a fast, precise screen reader. Transcribe EVERYTHING visible \
                      in the screenshot: all text, button labels, menu items, input field \
                      contents, links, and headings. Output each item on its own line, \
                      top-to-bottom, left-to-right. Be literal and complete — do not summarize \
                      or interpret. If you see clickable elements, note them.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: "Transcribe all text and UI elements visible on this screen.".to_string(),
        },
    ];

    call_ai_chat(TaskType::Vision, messages, Some(screenshot_b64.to_string())).await
}

#[async_trait::async_trait]
impl Tool for ScreenTool {
    fn name(&self) -> &str { "screen" }

    fn description(&self) -> &str {
        "Read or capture the screen. Actions: \
         'screenshot' (capture screen, returns base64 JPEG for the AI to analyze), \
         'save_screenshot' (capture and SAVE to a PNG/JPG file — provide 'path', or omit to save to Desktop with a timestamp), \
         'ocr' (read all visible text on screen — uses AI vision if available, else Windows OCR), \
         'find_text' (returns {x,y} center coordinates of the given 'query' text so you can click it), \
         'ui_tree' (accessibility element hierarchy as JSON with positions)."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["screenshot", "save_screenshot", "ocr", "find_text", "ui_tree"]
                },
                "query": {
                    "type": "string",
                    "description": "Text to locate on screen (find_text only)"
                },
                "path": {
                    "type": "string",
                    "description": "File path to save the screenshot (save_screenshot only). If omitted, saves to Desktop."
                }
            },
            "required": ["action"]
        })
    }

    fn risk_level(&self, _params: &Value) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(&self, params: Value) -> anyhow::Result<String> {
        let action = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'action'"))?;

        match action {
            "screenshot" => {
                let base64 = capture_full_screen()?;
                Ok(base64)
            }
            "save_screenshot" => {
                let base64 = capture_full_screen()?;
                let bytes = STANDARD.decode(&base64)
                    .map_err(|e| anyhow::anyhow!("Failed to decode screenshot: {}", e))?;
                let path = if let Some(p) = params["path"].as_str() {
                    std::path::PathBuf::from(p)
                } else {
                    let mut desktop = dirs::desktop_dir()
                        .or_else(dirs::home_dir)
                        .unwrap_or_else(|| std::path::PathBuf::from("."));
                    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
                    desktop.push(format!("omni_screenshot_{}.jpg", ts));
                    desktop
                };
                if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
                std::fs::write(&path, &bytes)
                    .map_err(|e| anyhow::anyhow!("Failed to save screenshot to {:?}: {}", path, e))?;
                Ok(format!("Screenshot saved to {}", path.to_string_lossy()))
            }
            "ocr" => {
                // ── Vision-first OCR ─────────────────────────────────────────────
                // If the active model supports vision, take a screenshot and ask the
                // AI to read it — much more accurate than Windows OCR for styled UI,
                // icons, non-Latin text, dark themes, and small fonts.
                let resolved = crate::ai::resolve_active_model(crate::ai::TaskType::Vision)
                    .ok().flatten();
                let has_vision = resolved.as_ref()
                    .map_or(false, |m| crate::ai::client::model_supports_vision(m));

                if has_vision {
                    tracing::info!("screen ocr: using AI vision (model has vision support)");
                    match capture_full_screen() {
                        Ok(b64) => {
                            match vision_ocr(&b64).await {
                                Ok(text) => return Ok(format!("[Vision OCR]\n{}", text)),
                                Err(e) => {
                                    tracing::warn!("Vision OCR failed ({}), falling back to Windows OCR", e);
                                    // Fall through to Windows OCR
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Screenshot failed for vision OCR ({}), falling back", e);
                        }
                    }
                }

                // ── Windows OCR fallback ─────────────────────────────────────────
                tracing::info!("screen ocr: using Windows OCR");
                let text = ocr_screen_internal().await?;
                Ok(text)
            }
            "find_text" => {
                let query = params["query"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'query' parameter for find_text"))?;
                let coords = ocr_find_text_coords(query).await?;
                if let Some((x, y)) = coords {
                    Ok(serde_json::json!({ "x": x, "y": y }).to_string())
                } else {
                    Ok("Text not found on screen".to_string())
                }
            }
            "ui_tree" => {
                let tree = get_ui_tree_json()?;
                Ok(tree.to_string())
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
