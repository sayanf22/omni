use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::storage::keychain::{store_key, get_key, delete_key};
use crate::storage::sqlite::{
    get_unsynced_tasks, mark_synced, get_unsynced_audit_entries, mark_audit_synced,
    CustomModel, get_setting_internal, save_task, Task, save_custom_model_db, save_audit,
    AuditEntry
};
use std::io::{Write, Cursor};
use zip::write::SimpleFileOptions;
use zip::{ZipWriter, CompressionMethod};

pub const SUPABASE_URL: &str = "https://bnejdnufjfeqilatdegl.supabase.co";
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuZWpkbnVmamZlcWlsYXRkZWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MzYxMTYsImV4cCI6MjA5NjUxMjExNn0.Lx4lkw3jjkkkblmDjd3jT46Kf8lY_eIjSSQ5yW0gjAI";

#[derive(Debug, Serialize, Deserialize)]
pub struct SupabaseUser {
    pub id: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SupabaseSession {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub user: SupabaseUser,
}

/// Helper to get the logged-in user's Supabase access token from keychain
fn get_user_token() -> Option<String> {
    get_key("supabase_user_token").ok().flatten()
}

/// Logs in using email and password via Supabase Auth.
/// Stores the session token in the DPAPI keychain.
#[tauri::command]
pub async fn supabase_login(email: String, password: String) -> Result<SupabaseUser, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/v1/token?grant_type=password", SUPABASE_URL);

    let payload = json!({
        "email": email,
        "password": password
    });

    let response = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_ANON_KEY))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("Login failed: {}", err_body));
    }

    let session: SupabaseSession = response.json()
        .await
        .map_err(|e| format!("Failed to parse session: {}", e))?;

    let access_token = session.access_token.ok_or_else(|| "No access token in login response".to_string())?;

    // Store access token in Windows Credential Manager (DPAPI)
    store_key("supabase_user_token", &access_token)
        .map_err(|e| format!("Failed to store auth token: {}", e))?;

    // Store the refresh token — this is what keeps the user logged in for months.
    // Access tokens expire in ~1h; the refresh token is exchanged for new ones.
    if let Some(ref rt) = session.refresh_token {
        store_key("supabase_refresh_token", rt)
            .map_err(|e| format!("Failed to store refresh token: {}", e))?;
    }

    // Store user ID for sync reference
    store_key("supabase_user_id", &session.user.id)
        .map_err(|e| format!("Failed to store user ID: {}", e))?;

    // Derive E2EE encryption key from password and store in DPAPI keychain
    let encryption_key = crate::storage::crypto::derive_encryption_key(&session.user.id, &password);
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let encryption_key_b64 = STANDARD.encode(&encryption_key);
    store_key("supabase_encryption_key", &encryption_key_b64)
        .map_err(|e| format!("Failed to store encryption key: {}", e))?;

    // Download cloud data before returning (custom models, settings, tasks, and memories)
    let _ = download_cloud_data_internal(&access_token, &session.user.id).await;

    Ok(session.user)
}

/// Signs up a new user using email and password via Supabase Auth.
#[tauri::command]
pub async fn supabase_signup(email: String, password: String) -> Result<SupabaseUser, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/v1/signup", SUPABASE_URL);

    let payload = json!({
        "email": email,
        "password": password
    });

    let response = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_ANON_KEY))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("Signup failed: {}", err_body));
    }

    let response_body = response.text().await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Try parsing as SupabaseSession (tokens and nested user object when auto-confirm is on)
    let user = if let Ok(session) = serde_json::from_str::<SupabaseSession>(&response_body) {
        if let Some(ref access_token) = session.access_token {
            store_key("supabase_user_token", access_token)
                .map_err(|e| format!("Failed to store auth token: {}", e))?;
        }
        if let Some(ref rt) = session.refresh_token {
            let _ = store_key("supabase_refresh_token", rt);
        }
        store_key("supabase_user_id", &session.user.id)
            .map_err(|e| format!("Failed to store user ID: {}", e))?;

        session.user
    } else {
        // Fallback: Parse as SupabaseUser directly (email confirmation enabled returns user structure at root)
        let parsed_user: SupabaseUser = serde_json::from_str(&response_body)
            .map_err(|e| format!("Failed to parse user payload: {} (Raw: {})", e, response_body))?;

        store_key("supabase_user_id", &parsed_user.id)
            .map_err(|e| format!("Failed to store user ID: {}", e))?;

        parsed_user
    };

    // Derive E2EE encryption key from password and store in DPAPI keychain
    let encryption_key = crate::storage::crypto::derive_encryption_key(&user.id, &password);
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let encryption_key_b64 = STANDARD.encode(&encryption_key);
    let _ = store_key("supabase_encryption_key", &encryption_key_b64);

    Ok(user)
}

/// Initiates Magic Link / Passwordless login via Supabase Auth.
#[tauri::command]
pub async fn supabase_login_with_otp(email: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/auth/v1/otp", SUPABASE_URL);

    let payload = json!({
        "email": email,
        "create_user": true
    });

    let response = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_ANON_KEY))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("OTP request failed: {}", err_body));
    }

    Ok(())
}

/// Exchange the stored refresh token for a fresh access + refresh token pair.
/// This is the mechanism that keeps users logged in for months without re-entering
/// credentials. Access tokens expire ~1h; refresh tokens are long-lived.
/// Returns the new access token on success.
pub async fn refresh_session_internal() -> Result<String, String> {
    let refresh_token = get_key("supabase_refresh_token").ok().flatten()
        .ok_or_else(|| "No refresh token stored".to_string())?;

    let client = reqwest::Client::new();
    let url = format!("{}/auth/v1/token?grant_type=refresh_token", SUPABASE_URL);
    let payload = json!({ "refresh_token": refresh_token });

    let response = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_ANON_KEY))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error during refresh: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Refresh failed: {}", body));
    }

    let session: SupabaseSession = response.json().await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let access = session.access_token
        .ok_or_else(|| "No access token in refresh response".to_string())?;

    let _ = store_key("supabase_user_token", &access);
    // Refresh tokens are single-use — Supabase returns a NEW one each time. Store it.
    if let Some(rt) = session.refresh_token {
        let _ = store_key("supabase_refresh_token", &rt);
    }
    let _ = store_key("supabase_user_id", &session.user.id);

    Ok(access)
}

/// Tauri command — manually trigger a session refresh. Returns true if successful.
#[tauri::command]
pub async fn refresh_session() -> Result<bool, String> {
    Ok(refresh_session_internal().await.is_ok())
}

/// Retrieves the current Supabase session. On startup this proactively refreshes
/// the access token (best-effort) so the user stays logged in across days/weeks.
#[tauri::command]
pub async fn get_supabase_session() -> Result<Option<SupabaseUser>, String> {
    let user_id = get_key("supabase_user_id").ok().flatten();
    let has_refresh = get_key("supabase_refresh_token").ok().flatten().is_some();

    if let Some(uid) = user_id {
        let mut token_opt = None;
        if has_refresh {
            if let Ok(access) = refresh_session_internal().await {
                token_opt = Some(access);
            }
        }
        if token_opt.is_none() {
            token_opt = get_user_token();
        }

        if let Some(ref tok) = token_opt {
            let _ = download_cloud_data_internal(tok, &uid).await;
        }

        if token_opt.is_some() || has_refresh {
            return Ok(Some(SupabaseUser { id: uid, email: None }));
        }
    }

    // Persistent offline mode fallback
    if let Ok(Some(val)) = get_setting_internal("offline_mode") {
        if val == "true" {
            return Ok(Some(SupabaseUser {
                id: "local-user".to_string(),
                email: Some("local@localhost".to_string()),
            }));
        }
    }
    Ok(None)
}

/// Logs out by clearing all auth keys from the secure keychain.
#[tauri::command]
pub async fn supabase_logout() -> Result<(), String> {
    let _ = delete_key("supabase_user_token");
    let _ = delete_key("supabase_refresh_token");
    let _ = delete_key("supabase_user_id");
    let _ = delete_key("supabase_encryption_key");
    let _ = crate::storage::sqlite::set_setting("offline_mode", "false");
    Ok(())
}

/// Syncs a custom model action to Supabase.
pub async fn sync_model_to_supabase(model: &CustomModel, delete: bool) -> Result<(), String> {
    let token = match get_user_token() {
        Some(t) => t,
        None => return Ok(()), // Not logged in, skip sync
    };
    let user_id = match get_key("supabase_user_id").ok().flatten() {
        Some(uid) => uid,
        None => return Ok(()),
    };

    let client = reqwest::Client::new();

    if delete {
        let url = format!("{}/rest/v1/custom_models?id=eq.{}", SUPABASE_URL, model.id);
        let res = client.delete(&url)
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        
        if !res.status().is_success() {
            return Err(format!("Failed to delete custom model from cloud: {}", res.status()));
        }
    } else {
        let url = format!("{}/rest/v1/custom_models", SUPABASE_URL);
        let payload = json!({
            "id": model.id,
            "user_id": user_id,
            "provider_type": model.provider_type,
            "model_name": model.model_name,
            "display_name": model.display_name,
            "base_url": model.base_url,
            "role_vision": model.role_vision,
            "role_coding": model.role_coding,
            "role_writing": model.role_writing,
            "is_active": model.is_active
        });

        let res = client.post(&url)
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .header("Prefer", "resolution=merge-duplicates")
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            return Err(format!("Failed to upsert custom model to cloud: {}", res.status()));
        }
    }

    Ok(())
}

/// Backend implementation of the SQLite -> Supabase Cloud database Sync Engine.
#[tauri::command]
pub async fn sync_local_to_cloud() -> Result<(), String> {
    // Ensure we have a usable access token; refresh if needed.
    let mut token = match get_user_token() {
        Some(t) => t,
        None => {
            // No access token — try to refresh from the stored refresh token.
            match refresh_session_internal().await {
                Ok(t) => t,
                Err(_) => return Ok(()), // not logged in / can't refresh — skip silently
            }
        }
    };
    let user_id = match get_key("supabase_user_id").ok().flatten() {
        Some(uid) => uid,
        None => return Ok(()),
    };

    let client = reqwest::Client::new();

    fn is_auth_expired(status: u16, body: &str) -> bool {
        status == 401 || body.contains("PGRST303") || body.contains("JWT expired") || body.contains("JWSError")
    }

    // 1. Sync local tasks
    let unsynced_tasks = get_unsynced_tasks().map_err(|e| e.to_string())?;
    for t in unsynced_tasks {
        let url = format!("{}/rest/v1/tasks", SUPABASE_URL);
        let steps_parsed: serde_json::Value = serde_json::from_str(&t.steps_json).unwrap_or(json!([]));
        let payload = json!({
            "id": t.id, "user_id": user_id, "description": t.description,
            "status": t.status, "steps_json": steps_parsed, "outcome": t.outcome,
            "created_at": t.created_at
        });

        let mut response = match client.post(&url)
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .header("Prefer", "resolution=merge-duplicates")
            .json(&payload).send().await
        {
            Ok(r) => r,
            Err(_) => return Ok(()),
        };

        // If the token expired mid-sync, refresh once and retry this row.
        if is_auth_expired(response.status().as_u16(), "") {
            if let Ok(new_token) = refresh_session_internal().await {
                token = new_token;
                response = match client.post(&url)
                    .header("apikey", SUPABASE_ANON_KEY)
                    .header("Authorization", format!("Bearer {}", token))
                    .header("Content-Type", "application/json")
                    .header("Prefer", "resolution=merge-duplicates")
                    .json(&payload).send().await
                {
                    Ok(r) => r,
                    Err(_) => return Ok(()),
                };
            } else {
                // Refresh failed — session truly expired. Clear and signal re-login.
                let _ = delete_key("supabase_user_token");
                let _ = delete_key("supabase_refresh_token");
                return Err("SESSION_EXPIRED".to_string());
            }
        }

        if response.status().is_success() {
            let _ = mark_synced(&t.id);
        } else {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            if is_auth_expired(status, &body) {
                if refresh_session_internal().await.is_err() {
                    let _ = delete_key("supabase_user_token");
                    let _ = delete_key("supabase_refresh_token");
                    return Err("SESSION_EXPIRED".to_string());
                }
            } else {
                tracing::warn!("Task {} sync failed ({})", t.id, status);
            }
        }
    }

    // 2. Sync local audits
    let unsynced_audits = get_unsynced_audit_entries().map_err(|e| e.to_string())?;
    for a in unsynced_audits {
        let url = format!("{}/rest/v1/audit_log", SUPABASE_URL);
        let payload = json!({
            "id": a.id, "user_id": user_id, "action_type": a.action_type,
            "tool_name": a.tool_name, "app_name": a.app_name, "outcome": a.outcome,
            "created_at": a.created_at
        });

        let response = match client.post(&url)
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&payload).send().await
        {
            Ok(r) => r,
            Err(_) => return Ok(()),
        };

        if response.status().is_success() {
            let _ = mark_audit_synced(&a.id);
        } else if is_auth_expired(response.status().as_u16(), &response.text().await.unwrap_or_default()) {
            if refresh_session_internal().await.is_err() {
                let _ = delete_key("supabase_user_token");
                let _ = delete_key("supabase_refresh_token");
                return Err("SESSION_EXPIRED".to_string());
            }
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Storage, Compression & Bidirectional Sync Engine
// ─────────────────────────────────────────────────────────────────────────────

fn get_chroma_db_path() -> String {
    let mut path = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push("Omni");
    path.push("chroma_db");
    let _ = std::fs::create_dir_all(&path);
    path.to_string_lossy().to_string()
}

pub fn compress_string_to_zip(filename: &str, content: &str) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut archive = ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated);
        
        archive.start_file(filename, options)
            .map_err(|e| format!("Failed to start zip file: {}", e))?;
        archive.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write to zip: {}", e))?;
        archive.finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    }
    Ok(cursor.into_inner())
}

pub async fn ensure_bucket_exists(token: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/bucket", SUPABASE_URL);
    let payload = json!({
        "name": "task-logs",
        "public": false,
        "file_size_limit": 52428800
    });

    let _ = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await;

    Ok(())
}

pub async fn upload_task_log_to_storage(token: &str, user_id: &str, task_id: &str, steps_json: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/task-logs/{}/{}.zip", SUPABASE_URL, user_id, task_id);

    let _ = ensure_bucket_exists(token).await;

    let zip_bytes = compress_string_to_zip("task_steps.json", steps_json)?;

    let res = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/zip")
        .header("x-upsert", "true")
        .body(zip_bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Storage task log upload failed ({}): {}", status, err_body));
    }

    Ok(())
}

pub async fn upload_settings_to_storage(token: &str, user_id: &str) -> Result<(), String> {
    let payload = {
        let conn = crate::storage::sqlite::open_db_conn().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;

        let mut map = std::collections::HashMap::new();
        for row in rows {
            if let Ok((k, v)) = row {
                if k != "sidecar_token" {
                    map.insert(k, v);
                }
            }
        }
        serde_json::to_string(&map).map_err(|e| e.to_string())?
    };

    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/task-logs/{}/settings.json", SUPABASE_URL, user_id);

    let _ = ensure_bucket_exists(token).await;

    let res = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("x-upsert", "true")
        .body(payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Storage settings upload failed ({}): {}", status, err_body));
    }

    Ok(())
}

fn add_dir_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    base_path: &std::path::Path,
    current_dir: &std::path::Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries = std::fs::read_dir(current_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            add_dir_to_zip(zip, base_path, &path, options)?;
        } else if path.is_file() {
            let name = path.strip_prefix(base_path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn backup_chroma_db(token: &str, user_id: &str) -> Result<(), String> {
    let chroma_path = get_chroma_db_path();
    let path = std::path::Path::new(&chroma_path);
    if !path.exists() {
        return Ok(());
    }

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated);
        
        let _ = add_dir_to_zip(&mut zip, path, path, options);
        let _ = zip.finish();
    }

    let zip_bytes = cursor.into_inner();
    if zip_bytes.is_empty() {
        return Ok(());
    }

    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/task-logs/{}/chroma_db.zip", SUPABASE_URL, user_id);

    let _ = ensure_bucket_exists(token).await;

    let _res = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/zip")
        .header("x-upsert", "true")
        .body(zip_bytes)
        .send()
        .await;

    Ok(())
}

pub async fn restore_chroma_db(token: &str, user_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/authenticated/task-logs/{}/chroma_db.zip", SUPABASE_URL, user_id);

    let res = match client.get(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    if res.status().is_success() {
        if let Ok(zip_bytes) = res.bytes().await {
            let cursor = std::io::Cursor::new(zip_bytes.to_vec());
            if let Ok(mut archive) = zip::ZipArchive::new(cursor) {
                let chroma_path = get_chroma_db_path();
                let dest = std::path::Path::new(&chroma_path);
                let _ = std::fs::create_dir_all(dest);

                for i in 0..archive.len() {
                    if let Ok(mut file) = archive.by_index(i) {
                        let outpath = match file.enclosed_name() {
                            Some(path) => dest.join(path),
                            None => continue,
                        };

                        if file.name().ends_with('/') {
                            let _ = std::fs::create_dir_all(&outpath);
                        } else {
                            if let Some(p) = outpath.parent() {
                                let _ = std::fs::create_dir_all(p);
                            }
                            if let Ok(mut outfile) = std::fs::File::create(&outpath) {
                                let _ = std::io::copy(&mut file, &mut outfile);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn download_cloud_data_internal(token: &str, user_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();

    // 1. Download settings
    let settings_url = format!("{}/storage/v1/object/authenticated/task-logs/{}/settings.json", SUPABASE_URL, user_id);
    if let Ok(res) = client.get(&settings_url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if res.status().is_success() {
            if let Ok(map) = res.json::<std::collections::HashMap<String, String>>().await {
                for (k, v) in map {
                    let _ = crate::storage::sqlite::save_setting_internal(&k, &v);
                }
            }
        }
    }

    // 2. Download custom models
    let models_url = format!("{}/rest/v1/custom_models?select=*", SUPABASE_URL);
    if let Ok(res) = client.get(&models_url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if res.status().is_success() {
            #[derive(Deserialize)]
            struct CloudModel {
                id: String,
                provider_type: String,
                model_name: String,
                display_name: String,
                base_url: Option<String>,
                role_vision: bool,
                role_coding: bool,
                role_writing: bool,
                is_active: bool,
            }
            if let Ok(cloud_models) = res.json::<Vec<CloudModel>>().await {
                for m in cloud_models {
                    let local_model = CustomModel {
                        id: m.id,
                        provider_type: m.provider_type,
                        model_name: m.model_name,
                        display_name: m.display_name,
                        base_url: m.base_url,
                        role_vision: m.role_vision,
                        role_coding: m.role_coding,
                        role_writing: m.role_writing,
                        is_active: m.is_active,
                    };
                    let _ = save_custom_model_db(&local_model);
                }
            }
        }
    }

    // 3. Download tasks
    let tasks_url = format!("{}/rest/v1/tasks?select=*", SUPABASE_URL);
    if let Ok(res) = client.get(&tasks_url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if res.status().is_success() {
            #[derive(Deserialize)]
            struct CloudTask {
                id: String,
                description: String,
                status: String,
                steps_json: Option<serde_json::Value>,
                outcome: Option<String>,
                created_at: String,
            }
            if let Ok(cloud_tasks) = res.json::<Vec<CloudTask>>().await {
                for t in cloud_tasks {
                    let local_task = Task {
                        id: t.id,
                        description: t.description,
                        status: t.status,
                        steps_json: t.steps_json.map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string()),
                        outcome: t.outcome,
                        created_at: t.created_at,
                        synced_at: Some(chrono::Utc::now().to_rfc3339()),
                    };
                    let _ = save_task(&local_task);
                }
            }
        }
    }

    // 4. Download audits
    let audits_url = format!("{}/rest/v1/audit_log?select=*", SUPABASE_URL);
    if let Ok(res) = client.get(&audits_url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        if res.status().is_success() {
            #[derive(Deserialize)]
            struct CloudAudit {
                id: String,
                action_type: String,
                tool_name: Option<String>,
                app_name: Option<String>,
                outcome: String,
                created_at: String,
            }
            if let Ok(cloud_audits) = res.json::<Vec<CloudAudit>>().await {
                for a in cloud_audits {
                    let local_audit = AuditEntry {
                        id: a.id,
                        action_type: a.action_type,
                        tool_name: a.tool_name,
                        app_name: a.app_name,
                        outcome: a.outcome,
                        created_at: a.created_at,
                    };
                    let _ = save_audit(&local_audit);
                    let _ = mark_audit_synced(&local_audit.id);
                }
            }
        }
    }

    // 5. Restore Chroma DB
    let _ = restore_chroma_db(token, user_id).await;

    // 6. Restore E2EE API keys if we have the encryption key
    if let Some(enc_key) = get_key("supabase_encryption_key").ok().flatten() {
        let _ = restore_api_keys_from_storage(token, user_id, &enc_key).await;
    }

    Ok(())
}

pub async fn sync_all_to_cloud_async(task_id: Option<String>, steps_json: Option<String>) {
    let token = match get_key("supabase_user_token").ok().flatten() {
        Some(t) => t,
        None => return,
    };
    let user_id = match get_key("supabase_user_id").ok().flatten() {
        Some(uid) => uid,
        None => return,
    };

    if let (Some(tid), Some(steps)) = (task_id, steps_json) {
        let _ = upload_task_log_to_storage(&token, &user_id, &tid, &steps).await;
    }

    let _ = upload_settings_to_storage(&token, &user_id).await;
    let _ = backup_chroma_db(&token, &user_id).await;

    // Backup E2EE API keys if we have the encryption key
    if let Some(enc_key) = get_key("supabase_encryption_key").ok().flatten() {
        let _ = backup_api_keys_to_storage(&token, &user_id, &enc_key).await;
    }

    let _ = sync_local_to_cloud().await;
}

pub async fn insert_memory_to_supabase(user_id: &str, memory_type: &str, content: &str) -> Result<(), String> {
    let token = match get_key("supabase_user_token").ok().flatten() {
        Some(t) => t,
        None => return Ok(()),
    };

    let client = reqwest::Client::new();
    let url = format!("{}/rest/v1/memories", SUPABASE_URL);
    let payload = json!({
        "user_id": user_id,
        "memory_type": memory_type,
        "content": content,
        "metadata": {}
    });

    let _ = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await;

    Ok(())
}

pub async fn backup_api_keys_to_storage(token: &str, user_id: &str, encryption_key_b64: &str) -> Result<(), String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    
    let key_bytes = STANDARD.decode(encryption_key_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let mut key = [0u8; 32];
    if key_bytes.len() != 32 {
        return Err("Invalid encryption key length".to_string());
    }
    key.copy_from_slice(&key_bytes);

    let mut secrets_map = std::collections::HashMap::new();

    // 1. Fetch ElevenLabs keys
    if let Ok(Some(k)) = get_key("elevenlabs") {
        secrets_map.insert("elevenlabs".to_string(), k);
    }
    if let Ok(Some(k)) = get_key("elevenlabs_api_key") {
        secrets_map.insert("elevenlabs_api_key".to_string(), k);
    }

    // 2. Fetch Mem0 key
    if let Ok(Some(k)) = get_key("mem0") {
        secrets_map.insert("mem0".to_string(), k);
    }

    // 3. Fetch custom models keys
    if let Ok(models) = crate::storage::sqlite::get_custom_models_db() {
        for m in models {
            if let Ok(Some(k)) = get_key(&m.id) {
                secrets_map.insert(m.id.clone(), k);
            }
        }
    }

    if secrets_map.is_empty() {
        return Ok(()); // Nothing to backup
    }

    let serialized = serde_json::to_string(&secrets_map).map_err(|e| e.to_string())?;
    
    // Encrypt client-side using AES-GCM
    let encrypted_payload = crate::storage::crypto::encrypt_data(&key, &serialized)?;

    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/task-logs/{}/secrets.enc", SUPABASE_URL, user_id);

    let _ = ensure_bucket_exists(token).await;

    let res = client.post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/octet-stream")
        .header("x-upsert", "true")
        .body(encrypted_payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Storage secrets upload failed ({}): {}", status, err_body));
    }

    Ok(())
}

pub async fn restore_api_keys_from_storage(token: &str, user_id: &str, encryption_key_b64: &str) -> Result<(), String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    
    let key_bytes = STANDARD.decode(encryption_key_b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let mut key = [0u8; 32];
    if key_bytes.len() != 32 {
        return Err("Invalid encryption key length".to_string());
    }
    key.copy_from_slice(&key_bytes);

    let client = reqwest::Client::new();
    let url = format!("{}/storage/v1/object/authenticated/task-logs/{}/secrets.enc", SUPABASE_URL, user_id);

    let res = match client.get(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    if res.status().is_success() {
        if let Ok(encrypted_payload) = res.text().await {
            if let Ok(decrypted_json) = crate::storage::crypto::decrypt_data(&key, &encrypted_payload) {
                if let Ok(secrets_map) = serde_json::from_str::<std::collections::HashMap<String, String>>(&decrypted_json) {
                    for (k, v) in secrets_map {
                        let _ = store_key(&k, &v);
                    }
                }
            }
        }
    }
    Ok(())
}

