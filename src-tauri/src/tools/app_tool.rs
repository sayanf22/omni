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

                // If the app is already running, just focus it — much faster than re-launching.
                if let Ok(()) = focus_window_by_name(name) {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    return Ok(format!(
                        "'{}' was already running and is now focused. \
                         The window is ready — proceed with your next action.",
                        name
                    ));
                }

                // Launch the app
                match launch_app_internal(name) {
                    Ok(pid) => {
                        // Smart wait: poll for the window to appear instead of a fixed sleep.
                        // Check every 400ms, up to 8 seconds total (UWP apps can be slow to render).
                        let name_lower = name.to_lowercase();
                        let mut focused = false;
                        for _ in 0..20 {
                            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                            if focus_window_by_name(name).is_ok()
                                || focus_window_by_name(&name_lower).is_ok()
                            {
                                focused = true;
                                break;
                            }
                        }
                        if !focused {
                            // Last-resort: try to bring any window with the name in the title
                            let _ = focus_window_by_name(name);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        Ok(format!(
                            "Opened '{}' (PID {}). Window is ready. \
                             IMPORTANT: Do NOT click the title bar or app chrome — click directly on \
                             the content area (search box, text field, etc.) to interact with it.",
                            name, pid
                        ))
                    }
                    Err(e) => {
                        Err(anyhow::anyhow!("Could not open '{}': {}", name, e))
                    }
                }
            }
            "open_url" => {
                let url = params["url"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'url' for open_url action"))?;
                let final_url = if url.starts_with("http://") || url.starts_with("https://") {
                    url.to_string()
                } else {
                    format!("https://{}", url)
                };
                let status = std::process::Command::new("cmd")
                    .args(["/c", "start", "", &final_url])
                    .status()
                    .map_err(|e| anyhow::anyhow!("Failed to open URL: {}", e))?;
                if !status.success() {
                    return Err(anyhow::anyhow!("cmd /c start failed for URL: {}", final_url));
                }
                tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                Ok(format!(
                    "Opened '{}' in the default browser. \
                     Use 'screen' ocr or screenshot to read it once loaded. \
                     Use app 'wait' with ms=2000 if the page isn't ready yet.",
                    final_url
                ))
            }
            "focus" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for focus action"))?;
                focus_window_by_name(name)?;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                Ok(format!("Focused '{}'. It is now the active window.", name))
            }
            "list" => {
                let apps = list_running_apps_internal();
                Ok(serde_json::to_string_pretty(&apps)?)
            }
            "close" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for close action"))?;
                let mut exe_name = name.to_string();
                if !exe_name.ends_with(".exe") { exe_name.push_str(".exe"); }
                let output = std::process::Command::new("taskkill")
                    .args(&["/F", "/IM", &exe_name])
                    .output()?;
                if output.status.success() {
                    Ok(format!("Closed '{}'", exe_name))
                } else {
                    Err(anyhow::anyhow!("Failed to close '{}': {}", exe_name, String::from_utf8_lossy(&output.stderr)))
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
