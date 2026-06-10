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
        "Manage Windows applications. Actions:\n\
         • open — launch an application by name (e.g. 'chrome', 'notepad', 'msedge', 'explorer').\n\
         • open_url — open a URL directly in the default browser (provide 'url' param). FASTEST way to open a website.\n\
         • focus — bring an existing window to the foreground by title fragment.\n\
         • list — list running visible windows (to find what's open).\n\
         • close — terminate a process by name.\n\
         • wait — sleep for 'ms' milliseconds (default 1500). Use after navigation to let pages load."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["open", "open_url", "focus", "list", "close", "wait"]
                },
                "name": {
                    "type": "string",
                    "description": "Application name or exe (for open/focus/close)"
                },
                "url": {
                    "type": "string",
                    "description": "Full URL to open in default browser (for open_url)"
                },
                "ms": {
                    "type": "integer",
                    "description": "Milliseconds to wait (for wait action, default 1500, max 10000)"
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
                match launch_app_internal(name) {
                    Ok(pid) => {
                        // Wait for the app window to be ready
                        tokio::time::sleep(std::time::Duration::from_millis(1800)).await;
                        let _ = focus_window_by_name(name);
                        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                        Ok(format!(
                            "Opened '{}' (PID {}). Window is focused and ready.",
                            name, pid
                        ))
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        // Propagate the error clearly so the AI can tell the user
                        // and optionally offer to open the Store/download page.
                        Err(anyhow::anyhow!(
                            "Could not open '{}': {}",
                            name, msg
                        ))
                    }
                }
            }
            "open_url" => {
                let url = params["url"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'url' for open_url action"))?;
                // Validate URL has a scheme
                let final_url = if url.starts_with("http://") || url.starts_with("https://") {
                    url.to_string()
                } else {
                    format!("https://{}", url)
                };
                // Use Windows ShellExecute to open URL in default browser — works with any browser
                let status = std::process::Command::new("cmd")
                    .args(["/c", "start", "", &final_url])
                    .status()
                    .map_err(|e| anyhow::anyhow!("Failed to open URL: {}", e))?;
                if !status.success() {
                    return Err(anyhow::anyhow!("cmd /c start failed for URL: {}", final_url));
                }
                // Give the browser time to open and start loading
                tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                Ok(format!(
                    "Opened '{}' in the default browser. \
                     Wait a moment for the page to load, then use 'screen' ocr or screenshot to read it. \
                     If the page isn't loaded yet, use app 'wait' with ms=2000.",
                    final_url
                ))
            }
            "focus" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for focus action"))?;
                focus_window_by_name(name)?;
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                Ok(format!("Focused window matching '{}'. It is now the active window.", name))
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
            "wait" => {
                let ms = params["ms"].as_u64().unwrap_or(1500).min(10_000);
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                Ok(format!("Waited {}ms.", ms))
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
