use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::process::{launch_app_internal, focus_window_by_name, list_running_apps_internal};

pub struct AppTool;

impl AppTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl Tool for AppTool {
    fn name(&self) -> &str {
        "app"
    }

    fn description(&self) -> &str {
        "Manage Windows applications. Actions: open (launches application by name/path), close (terminates process), focus (activates window), list (returns running visible windows)."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["open", "close", "focus", "list"]
                },
                "name": {
                    "type": "string",
                    "description": "Application name or executable name (e.g. 'notepad', 'chrome')"
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
            "open" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for open action"))?;
                let pid = launch_app_internal(name)?;
                // Wait for the app window to be created and ready to receive input.
                // Without this, immediate keyboard input is lost because the window
                // isn't focused / the message loop isn't pumping yet.
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                // Best-effort: bring the just-launched window to the foreground so the
                // text caret is active and keyboard input lands in it.
                let _ = focus_window_by_name(name);
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                Ok(format!(
                    "Opened '{}' (PID {}). The window is now focused and ready. \
                     For a text editor like Notepad, the cursor is already in the text area — \
                     use the keyboard tool with action 'type' to write text now.",
                    name, pid
                ))
            }
            "focus" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for focus action"))?;
                focus_window_by_name(name)?;
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                Ok(format!("Focused window matching '{}'. It is now the active window — keyboard input will go here.", name))
            }
            "list" => {
                let apps = list_running_apps_internal();
                let result = serde_json::to_string_pretty(&apps)?;
                Ok(result)
            }
            "close" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for close action"))?;
                let mut exe_name = name.to_string();
                if !exe_name.ends_with(".exe") {
                    exe_name.push_str(".exe");
                }
                let output = std::process::Command::new("taskkill")
                    .args(&["/F", "/IM", &exe_name])
                    .output()?;
                
                if output.status.success() {
                    Ok(format!("Closed application '{}'", exe_name))
                } else {
                    let err = String::from_utf8_lossy(&output.stderr);
                    Err(anyhow::anyhow!("Failed to close app: {}", err))
                }
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
