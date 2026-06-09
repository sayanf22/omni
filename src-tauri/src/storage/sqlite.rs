use rusqlite::{Connection, params};
use std::path::PathBuf;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomModel {
    pub id: String,
    pub provider_type: String,
    pub model_name: String,
    pub display_name: String,
    pub base_url: Option<String>,
    pub role_vision: bool,
    pub role_coding: bool,
    pub role_writing: bool,
    pub is_active: bool,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub status: String,
    pub steps_json: String,
    pub outcome: Option<String>,
    pub created_at: String,
    pub synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub action_type: String,
    pub tool_name: Option<String>,
    pub app_name: Option<String>,
    pub outcome: String,
    pub created_at: String,
}

/// Retrieves the local SQLite database file path.
pub fn get_db_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("Omni");
    let _ = std::fs::create_dir_all(&path);
    path.push("local.db");
    path
}

/// Initializes the local SQLite database schema.
pub fn init_db() -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)
        .map_err(|e| anyhow::anyhow!("Failed to open DB: {:?}", e))?;

    conn.execute("PRAGMA journal_mode=WAL;", [])
        .map_err(|e| anyhow::anyhow!("Failed to enable WAL mode: {:?}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_tasks (
            id TEXT PRIMARY KEY,
            description TEXT,
            status TEXT,
            steps_json TEXT,
            outcome TEXT,
            created_at TEXT,
            synced_at TEXT
        )",
        [],
    ).map_err(|e| anyhow::anyhow!("Failed to create local_tasks table: {:?}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_audit (
            id TEXT PRIMARY KEY,
            action_type TEXT,
            tool_name TEXT,
            app_name TEXT,
            outcome TEXT,
            created_at TEXT,
            synced_at TEXT
        )",
        [],
    ).map_err(|e| anyhow::anyhow!("Failed to create local_audit table: {:?}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )",
        [],
    ).map_err(|e| anyhow::anyhow!("Failed to create settings table: {:?}", e))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_models (
            id TEXT PRIMARY KEY,
            provider_type TEXT NOT NULL,
            model_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            base_url TEXT,
            role_vision INTEGER DEFAULT 0,
            role_coding INTEGER DEFAULT 0,
            role_writing INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL
        )",
        [],
    ).map_err(|e| anyhow::anyhow!("Failed to create custom_models table: {:?}", e))?;

    Ok(())
}

/// Saves a task record (insert or replace).
pub fn save_task(task: &Task) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute(
        "INSERT OR REPLACE INTO local_tasks (id, description, status, steps_json, outcome, created_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            task.id,
            task.description,
            task.status,
            task.steps_json,
            task.outcome,
            task.created_at,
            task.synced_at,
        ],
    )?;
    Ok(())
}

/// Retrieves the most recent tasks.
pub fn get_recent_tasks_internal(limit: i32) -> anyhow::Result<Vec<Task>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare(
        "SELECT id, description, status, steps_json, outcome, created_at, synced_at
         FROM local_tasks ORDER BY created_at DESC LIMIT ?1",
    )?;
    let task_iter = stmt.query_map([limit], |row| {
        Ok(Task {
            id: row.get(0)?,
            description: row.get(1)?,
            status: row.get(2)?,
            steps_json: row.get(3)?,
            outcome: row.get(4)?,
            created_at: row.get(5)?,
            synced_at: row.get(6)?,
        })
    })?;

    let mut tasks = Vec::new();
    for task in task_iter {
        tasks.push(task?);
    }
    Ok(tasks)
}

/// Retrieves all tasks that haven't been synced to the cloud database.
pub fn get_unsynced_tasks() -> anyhow::Result<Vec<Task>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare(
        "SELECT id, description, status, steps_json, outcome, created_at, synced_at
         FROM local_tasks WHERE synced_at IS NULL",
    )?;
    let task_iter = stmt.query_map([], |row| {
        Ok(Task {
            id: row.get(0)?,
            description: row.get(1)?,
            status: row.get(2)?,
            steps_json: row.get(3)?,
            outcome: row.get(4)?,
            created_at: row.get(5)?,
            synced_at: row.get(6)?,
        })
    })?;

    let mut tasks = Vec::new();
    for task in task_iter {
        tasks.push(task?);
    }
    Ok(tasks)
}

/// Marks a task as synced by setting its synced_at timestamp.
pub fn mark_synced(task_id: &str) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE local_tasks SET synced_at = ?1 WHERE id = ?2",
        params![now, task_id],
    )?;
    Ok(())
}

/// Saves an audit log entry.
pub fn save_audit(entry: &AuditEntry) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute(
        "INSERT OR REPLACE INTO local_audit (id, action_type, tool_name, app_name, outcome, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            entry.id,
            entry.action_type,
            entry.tool_name,
            entry.app_name,
            entry.outcome,
            entry.created_at,
        ],
    )?;
    Ok(())
}

/// Retrieves recent audit log entries.
pub fn get_audit_log_internal(limit: i32) -> anyhow::Result<Vec<AuditEntry>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare(
        "SELECT id, action_type, tool_name, app_name, outcome, created_at
         FROM local_audit ORDER BY created_at DESC LIMIT ?1",
    )?;
    let audit_iter = stmt.query_map([limit], |row| {
        Ok(AuditEntry {
            id: row.get(0)?,
            action_type: row.get(1)?,
            tool_name: row.get(2)?,
            app_name: row.get(3)?,
            outcome: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut audits = Vec::new();
    for entry in audit_iter {
        audits.push(entry?);
    }
    Ok(audits)
}

/// Sets a local setting key-value pair.
pub fn set_setting(key: &str, value: &str) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value, now],
    )?;
    Ok(())
}

/// Retrieves a local setting value.
pub fn get_setting_internal(key: &str) -> anyhow::Result<Option<String>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([key])?;
    if let Some(row) = rows.next()? {
        let val: String = row.get(0)?;
        Ok(Some(val))
    } else {
        Ok(None)
    }
}

/// Writes a local setting value — usable from internal non-command code (e.g. sidecar manager).
pub fn save_setting_internal(key: &str, value: &str) -> anyhow::Result<()> {
    set_setting(key, value)
}

/// Clears all local task, audit, and settings data.
pub fn clear_all_data() -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute("DELETE FROM local_tasks", [])?;
    conn.execute("DELETE FROM local_audit", [])?;
    conn.execute("DELETE FROM settings", [])?;
    conn.execute("DELETE FROM custom_models", [])?;
    Ok(())
}

pub fn save_custom_model_db(model: &CustomModel) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute(
        "INSERT OR REPLACE INTO custom_models (id, provider_type, model_name, display_name, base_url, role_vision, role_coding, role_writing, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            model.id,
            model.provider_type,
            model.model_name,
            model.display_name,
            model.base_url,
            model.role_vision as i32,
            model.role_coding as i32,
            model.role_writing as i32,
            model.is_active as i32,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn delete_custom_model_db(id: &str) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute("DELETE FROM custom_models WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_custom_models_db() -> anyhow::Result<Vec<CustomModel>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare(
        "SELECT id, provider_type, model_name, display_name, base_url, role_vision, role_coding, role_writing, is_active FROM custom_models ORDER BY created_at DESC"
    )?;
    let model_iter = stmt.query_map([], |row| {
        Ok(CustomModel {
            id: row.get(0)?,
            provider_type: row.get(1)?,
            model_name: row.get(2)?,
            display_name: row.get(3)?,
            base_url: row.get(4)?,
            role_vision: row.get::<_, i32>(5)? != 0,
            role_coding: row.get::<_, i32>(6)? != 0,
            role_writing: row.get::<_, i32>(7)? != 0,
            is_active: row.get::<_, i32>(8)? != 0,
        })
    })?;
    let mut models = Vec::new();
    for model in model_iter {
        models.push(model?);
    }
    Ok(models)
}

pub fn get_active_model_for_role_db(role: &str) -> anyhow::Result<Option<CustomModel>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let query = match role {
        "vision" => "SELECT id, provider_type, model_name, display_name, base_url, role_vision, role_coding, role_writing, is_active FROM custom_models WHERE role_vision = 1 AND is_active = 1 LIMIT 1",
        "coding" => "SELECT id, provider_type, model_name, display_name, base_url, role_vision, role_coding, role_writing, is_active FROM custom_models WHERE role_coding = 1 AND is_active = 1 LIMIT 1",
        "writing" => "SELECT id, provider_type, model_name, display_name, base_url, role_vision, role_coding, role_writing, is_active FROM custom_models WHERE role_writing = 1 AND is_active = 1 LIMIT 1",
        _ => return Ok(None),
    };
    let mut stmt = conn.prepare(query)?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        Ok(Some(CustomModel {
            id: row.get(0)?,
            provider_type: row.get(1)?,
            model_name: row.get(2)?,
            display_name: row.get(3)?,
            base_url: row.get(4)?,
            role_vision: row.get::<_, i32>(5)? != 0,
            role_coding: row.get::<_, i32>(6)? != 0,
            role_writing: row.get::<_, i32>(7)? != 0,
            is_active: row.get::<_, i32>(8)? != 0,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_unsynced_audit_entries() -> anyhow::Result<Vec<AuditEntry>> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    let mut stmt = conn.prepare(
        "SELECT id, action_type, tool_name, app_name, outcome, created_at
         FROM local_audit WHERE synced_at IS NULL",
    )?;
    let audit_iter = stmt.query_map([], |row| {
        Ok(AuditEntry {
            id: row.get(0)?,
            action_type: row.get(1)?,
            tool_name: row.get(2)?,
            app_name: row.get(3)?,
            outcome: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;

    let mut audits = Vec::new();
    for entry in audit_iter {
        audits.push(entry?);
    }
    Ok(audits)
}

pub fn mark_audit_synced(audit_id: &str) -> anyhow::Result<()> {
    let path = get_db_path();
    let conn = Connection::open(&path)?;
    conn.execute(
        "UPDATE local_audit SET synced_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), audit_id],
    )?;
    Ok(())
}

/// Tauri IPC wrappers
#[tauri::command]
pub fn get_recent_tasks(limit: i32) -> Result<Vec<Task>, String> {
    get_recent_tasks_internal(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_audit_log(limit: i32) -> Result<Vec<AuditEntry>, String> {
    get_audit_log_internal(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_setting(key: String, value: String) -> Result<(), String> {
    set_setting(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_setting(key: String) -> Result<Option<String>, String> {
    get_setting_internal(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_all_local_data() -> Result<(), String> {
    clear_all_data().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_custom_model(model: CustomModel) -> Result<(), String> {
    save_custom_model_db(&model).map_err(|e| e.to_string())?;
    let _ = super::supabase::sync_model_to_supabase(&model, false).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_custom_model(id: String) -> Result<(), String> {
    let models = get_custom_models_db().map_err(|e| e.to_string())?;
    if let Some(m) = models.iter().find(|m| m.id == id) {
        let _ = super::supabase::sync_model_to_supabase(m, true).await;
    }
    delete_custom_model_db(&id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_custom_models() -> Result<Vec<CustomModel>, String> {
    get_custom_models_db().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_active_model_for_role(role: String) -> Result<Option<CustomModel>, String> {
    get_active_model_for_role_db(&role).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_unsynced_local_tasks() -> Result<Vec<Task>, String> {
    get_unsynced_tasks().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_task_synced_local(task_id: String) -> Result<(), String> {
    mark_synced(&task_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_unsynced_local_audit() -> Result<Vec<AuditEntry>, String> {
    get_unsynced_audit_entries().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_audit_synced_local(audit_id: String) -> Result<(), String> {
    mark_audit_synced(&audit_id).map_err(|e| e.to_string())
}

