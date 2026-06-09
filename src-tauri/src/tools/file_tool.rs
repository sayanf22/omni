use serde_json::Value;
use std::fs;
use std::path::Path;
use crate::tools::{Tool, RiskLevel};

pub struct FileTool;

impl FileTool {
    pub fn new() -> Self {
        Self
    }

    fn search_dir_recursive(dir: &Path, query: &str, results: &mut Vec<String>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // Prevent searching system directories
                    let name = path.file_name().unwrap_or_default().to_string_lossy();
                    if name.starts_with('.') || name == "node_modules" || name == "target" || name == "AppData" {
                        continue;
                    }
                    Self::search_dir_recursive(&path, query, results);
                } else if path.is_file() {
                    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    if file_name.contains(query) {
                        results.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl Tool for FileTool {
    fn name(&self) -> &str {
        "file"
    }

    fn description(&self) -> &str {
        "Perform file system operations. Actions: read, write, create_folder, move, delete, search, list. All paths must be absolute."
    }

    fn params_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write", "create_folder", "move", "delete", "search", "list"]
                },
                "path": {
                    "type": "string",
                    "description": "Absolute path to file or directory"
                },
                "content": {
                    "type": "string",
                    "description": "Required for write action"
                },
                "destination": {
                    "type": "string",
                    "description": "Required for move action"
                },
                "query": {
                    "type": "string",
                    "description": "Required for search action (sub-string matching on filenames)"
                }
            },
            "required": ["action"]
        })
    }

    fn risk_level(&self, params: &Value) -> RiskLevel {
        let action = params["action"].as_str().unwrap_or("read");
        match action {
            "delete" => RiskLevel::High,
            "write" | "create_folder" | "move" => RiskLevel::Low,
            _ => RiskLevel::ReadOnly,
        }
    }

    async fn execute(&self, params: Value) -> anyhow::Result<String> {
        let action = params["action"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'action'"))?;

        match action {
            "read" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                let path = Path::new(path_str);
                let content = fs::read_to_string(path)?;
                Ok(content)
            }
            "write" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                let content = params["content"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'content' for write action"))?;
                let path = Path::new(path_str);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(path, content)?;
                Ok(format!("Successfully wrote file: {}", path_str))
            }
            "create_folder" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                fs::create_dir_all(Path::new(path_str))?;
                Ok(format!("Successfully created folder: {}", path_str))
            }
            "move" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                let dest_str = params["destination"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'destination' for move action"))?;
                fs::rename(Path::new(path_str), Path::new(dest_str))?;
                Ok(format!("Moved {} to {}", path_str, dest_str))
            }
            "delete" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                let path = Path::new(path_str);
                if path.is_file() {
                    fs::remove_file(path)?;
                    Ok(format!("Deleted file: {}", path_str))
                } else if path.is_dir() {
                    fs::remove_dir_all(path)?;
                    Ok(format!("Deleted directory: {}", path_str))
                } else {
                    Err(anyhow::anyhow!("Path does not exist: {}", path_str))
                }
            }
            "list" => {
                let path_str = params["path"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'path'"))?;
                let path = Path::new(path_str);
                let entries = fs::read_dir(path)?;
                let mut list = Vec::new();
                for entry in entries.flatten() {
                    let path_name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = entry.path().is_dir();
                    list.push(serde_json::json!({
                        "name": path_name,
                        "type": if is_dir { "directory" } else { "file" }
                    }));
                }
                Ok(serde_json::to_string_pretty(&list)?)
            }
            "search" => {
                let path_str = params["path"].as_str().unwrap_or("C:/Users");
                let query = params["query"].as_str().ok_or_else(|| anyhow::anyhow!("Missing 'query' for search"))?.to_lowercase();
                let mut results = Vec::new();
                Self::search_dir_recursive(Path::new(path_str), &query, &mut results);
                Ok(serde_json::to_string_pretty(&results)?)
            }
            _ => Err(anyhow::anyhow!("Unknown action: {}", action))
        }
    }
}
