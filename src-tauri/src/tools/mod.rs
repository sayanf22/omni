use serde::{Serialize, Deserialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskLevel {
    ReadOnly,
    Low,
    High,
    Critical,
}

#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn params_schema(&self) -> serde_json::Value;
    fn risk_level(&self, params: &serde_json::Value) -> RiskLevel;
    async fn execute(&self, params: serde_json::Value) -> anyhow::Result<String>;
}

pub mod mouse_tool;
pub mod keyboard_tool;
pub mod screen_tool;
pub mod app_tool;
pub mod file_tool;
pub mod clipboard_tool;

pub fn get_all_tools() -> HashMap<String, Box<dyn Tool>> {
    let mut map: HashMap<String, Box<dyn Tool>> = HashMap::new();
    map.insert("mouse".to_string(), Box::new(mouse_tool::MouseTool::new()));
    map.insert("keyboard".to_string(), Box::new(keyboard_tool::KeyboardTool::new()));
    map.insert("screen".to_string(), Box::new(screen_tool::ScreenTool::new()));
    map.insert("app".to_string(), Box::new(app_tool::AppTool::new()));
    map.insert("file".to_string(), Box::new(file_tool::FileTool::new()));
    map.insert("clipboard".to_string(), Box::new(clipboard_tool::ClipboardTool::new()));
    map
}
