use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::input::{
    mouse_click_internal, mouse_right_click, mouse_double_click, mouse_scroll, human_move
};

pub struct MouseTool;

impl MouseTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl Tool for MouseTool {
    fn name(&self) -> &str {
        "mouse"
    }

    fn description(&self) -> &str {
        "Simulate mouse actions on the system. Options: click, right_click, double_click, scroll, move. Requires x and y coordinates."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["click", "right_click", "double_click", "scroll", "move"]
                },
                "x": { "type": "integer" },
                "y": { "type": "integer" },
                "direction": {
                    "type": "string",
                    "enum": ["up", "down", "left", "right"],
                    "description": "Used only for scroll"
                },
                "amount": {
                    "type": "integer",
                    "description": "Scroll ticks, used only for scroll"
                }
            },
            "required": ["action", "x", "y"]
        })
    }

    fn risk_level(&self, _params: &Value) -> RiskLevel {
        RiskLevel::Low
    }

    async fn execute(&self, params: Value) -> anyhow::Result<String> {
        let action = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'action'"))?;
        let x = params["x"].as_i64().ok_or_else(|| anyhow::anyhow!("Missing 'x'"))? as i32;
        let y = params["y"].as_i64().ok_or_else(|| anyhow::anyhow!("Missing 'y'"))? as i32;

        match action {
            "click" => {
                mouse_click_internal(x, y)?;
                Ok("Clicked mouse left button".to_string())
            }
            "right_click" => {
                mouse_right_click(x, y)?;
                Ok("Clicked mouse right button".to_string())
            }
            "double_click" => {
                mouse_double_click(x, y)?;
                Ok("Double clicked mouse left button".to_string())
            }
            "move" => {
                human_move(x, y)?;
                Ok("Moved mouse pointer".to_string())
            }
            "scroll" => {
                let dir = params["direction"].as_str().unwrap_or("down");
                let amount = params["amount"].as_i64().unwrap_or(3) as i32;
                mouse_scroll(x, y, dir, amount)?;
                Ok(format!("Scrolled mouse {} by {}", dir, amount))
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
