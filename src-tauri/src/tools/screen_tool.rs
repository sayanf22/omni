use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::screen::capture_full_screen;
use crate::automation::ocr::{ocr_screen_internal, ocr_find_text_coords};
use crate::automation::uia::get_ui_tree_json;
use base64::{Engine as _, engine::general_purpose::STANDARD};

pub struct ScreenTool;

impl ScreenTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl Tool for ScreenTool {
    fn name(&self) -> &str {
        "screen"
    }

    fn description(&self) -> &str {
        "Read or capture the screen. Actions: \
         'screenshot' (capture screen, returns base64 JPEG for the AI to analyze), \
         'save_screenshot' (capture and SAVE to a PNG/JPG file — provide 'path', or omit to save to Desktop with a timestamp), \
         'ocr' (read all visible text on screen), \
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

    fn risk_level(&self, _params: &Value) -> RiskLevel {
        RiskLevel::ReadOnly
    }

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

                // Resolve target path: explicit 'path' or Desktop\omni_screenshot_<ts>.jpg
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

                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&path, &bytes)
                    .map_err(|e| anyhow::anyhow!("Failed to save screenshot to {:?}: {}", path, e))?;

                Ok(format!("Screenshot saved to {}", path.to_string_lossy()))
            }
            "ocr" => {
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
