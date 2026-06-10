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
         • open — launch an app by name (e.g. 'whatsapp', 'chrome', 'notepad'). Auto-maximizes it. If already running, focuses+maximizes it.\n\
         • open_url — open a URL directly in the default browser. FASTEST way to open a website.\n\
         • focus — bring an existing window to the front AND maximize it by title fragment.\n\
         • maximize — same as focus: bring a window to front and maximize it (use if a window is behind others or minimized).\n\
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
                    "enum": ["open", "open_url", "focus", "maximize", "list", "close", "wait"]
                },
                "name": {
                    "type": "string",
                    "description": "Application name or window title fragment (for open/focus/maximize/close)"
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
                        // Check every 250ms, up to ~6s (most apps appear in <2s).
                        let name_lower = name.to_lowercase();
                        let mut focused = false;
                        for _ in 0..24 {
                            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                            if focus_window_by_name(name).is_ok()
                                || focus_window_by_name(&name_lower).is_ok()
                            {
                                focused = true;
                                break;
                            }
                        }
                        if !focused {
                            let _ = focus_window_by_name(name);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        Ok(format!(
                            "Opened '{}' (PID {}). Window is focused and maximized. \
                             Click directly on content (search box, field) — not the title bar.",
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
            "focus" | "maximize" => {
                let name = params["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'name' for focus/maximize action"))?;
                focus_window_by_name(name)?;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                Ok(format!("Focused and maximized '{}'. It is now the active, full-screen window.", name))
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
