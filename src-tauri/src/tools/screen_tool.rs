use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::screen::capture_full_screen;
use crate::automation::ocr::{ocr_screen_internal, ocr_find_text_coords};
use crate::automation::uia::get_ui_tree_json;

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
        "Retrieve screen information. Actions: screenshot (returns Base64 JPEG), ocr (full screen text detection), find_text (returns center coordinates of target string), ui_tree (accessibility hierarchy JSON)."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["screenshot", "ocr", "find_text", "ui_tree"]
                },
                "query": {
                    "type": "string",
                    "description": "Used only for find_text"
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
