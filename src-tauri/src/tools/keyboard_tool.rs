use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::input::{type_text_internal, press_key_internal, press_hotkey_internal};

pub struct KeyboardTool;

impl KeyboardTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl Tool for KeyboardTool {
    fn name(&self) -> &str {
        "keyboard"
    }

    fn description(&self) -> &str {
        "Simulate keyboard typing or key presses. Options: type, key, hotkey."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["type", "key", "hotkey"]
                },
                "text": {
                    "type": "string",
                    "description": "For 'type' action"
                },
                "key": {
                    "type": "string",
                    "description": "For 'key' action (e.g., 'enter', 'escape', 'tab')"
                },
                "keys": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "For 'hotkey' action (e.g., ['ctrl', 'c'])"
                }
            },
            "required": ["action"]
        })
    }

    fn risk_level(&self, _params: &Value) -> RiskLevel {
        RiskLevel::Low
    }

    async fn execute(&self, params: Value) -> anyhow::Result<String> {
        let action = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'action'"))?;

        match action {
            "type" => {
                let text = params["text"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'text' for type action"))?;
                type_text_internal(text)?;
                Ok(format!("Typed text: {}", text))
            }
            "key" => {
                let key = params["key"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'key' for key action"))?;
                press_key_internal(key)?;
                Ok(format!("Pressed key: {}", key))
            }
            "hotkey" => {
                let keys_value = params["keys"].as_array().ok_or_else(|| anyhow::anyhow!("Missing 'keys' array for hotkey action"))?;
                let mut keys = Vec::new();
                for k in keys_value {
                    let k_str = k.as_str().ok_or_else(|| anyhow::anyhow!("Invalid key in array"))?;
                    keys.push(k_str.to_string());
                }
                press_hotkey_internal(keys.clone())?;
                Ok(format!("Pressed hotkey combination: {:?}", keys))
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
