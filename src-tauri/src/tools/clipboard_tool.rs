use serde_json::Value;
use crate::tools::{Tool, RiskLevel};
use crate::automation::input::set_clipboard_text;
use windows::Win32::System::DataExchange::{OpenClipboard, CloseClipboard, GetClipboardData};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::Foundation::{HWND, HGLOBAL};

pub struct ClipboardTool;

impl ClipboardTool {
    pub fn new() -> Self {
        Self
    }
}

pub fn get_clipboard_text() -> anyhow::Result<String> {
    unsafe {
        OpenClipboard(HWND(std::ptr::null_mut()))
            .map_err(|e| anyhow::anyhow!("Failed to open clipboard: {:?}", e))?;
        
        let handle = GetClipboardData(13); // CF_UNICODETEXT = 13
        if handle.is_err() {
            let _ = CloseClipboard();
            return Ok(String::new());
        }
        let handle_val = handle.unwrap();
        if handle_val.0.is_null() {
            let _ = CloseClipboard();
            return Ok(String::new());
        }

        let hglobal = HGLOBAL(handle_val.0);
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            let _ = CloseClipboard();
            return Err(anyhow::anyhow!("GlobalLock failed"));
        }

        let mut len = 0;
        let mut char_ptr = ptr as *const u16;
        while *char_ptr != 0 {
            len += 1;
            char_ptr = char_ptr.add(1);
        }

        let wide_slice = std::slice::from_raw_parts(ptr as *const u16, len);
        let text = String::from_utf16_lossy(wide_slice);

        let _ = GlobalUnlock(hglobal);
        let _ = CloseClipboard();
        Ok(text)
    }
}

#[async_trait::async_trait]
impl Tool for ClipboardTool {
    fn name(&self) -> &str {
        "clipboard"
    }

    fn description(&self) -> &str {
        "Access system clipboard. Actions: read (returns current text), write (sets clipboard text)."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write"]
                },
                "text": {
                    "type": "string",
                    "description": "Required for write action"
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
            "read" => {
                let text = get_clipboard_text()?;
                Ok(text)
            }
            "write" => {
                let text = params["text"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'text' for write action"))?;
                set_clipboard_text(text)?;
                Ok(format!("Saved text to clipboard (length: {})", text.len()))
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
