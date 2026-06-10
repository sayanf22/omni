use serde::{Serialize, Deserialize};
use serde_json::json;
use crate::storage::keychain::{store_key, get_key, delete_key};
use crate::storage::sqlite::{
    get_unsynced_tasks, mark_synced, get_unsynced_audit_entries, mark_audit_synced,
    CustomModel, get_setting_internal
};

const SUPABASE_URL: &str = "https://bnejdnufjfeqilatdegl.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJuZWpkbnVmamZlcWlsYXRkZWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MzYxMTYsImV4cCI6MjA5NjUxMjExNn0.Lx4lkw3jjkkkblmDjd3jT46Kf8lY_eIjSSQ5yW0gjAI";

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

    // Store token in Windows Credential Manager securely (DPAPI keychain wrapper)
    store_key("supabase_user_token", &access_token)
        .map_err(|e| format!("Failed to store auth token: {}", e))?;
    
    // Store user ID for sync reference
    store_key("supabase_user_id", &session.user.id)
        .map_err(|e| format!("Failed to store user ID: {}", e))?;

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

/// Retrieves the current Supabase session info if logged in (by checking keychain) or in persistent offline mode.
#[tauri::command]
pub async fn get_supabase_session() -> Result<Option<SupabaseUser>, String> {
    let token = get_user_token();
    let user_id = get_key("supabase_user_id").ok().flatten();

    if let (Some(_), Some(uid)) = (token, user_id) {
        // Return active session info
        Ok(Some(SupabaseUser {
            id: uid,
            email: None, // We don't cache email, but UID is enough for the store
        }))
    } else {
        // Fallback to persistent offline mode if set by the user
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
}

/// Logs out by clearing keys from the secure keychain and resetting offline mode.
#[tauri::command]
pub async fn supabase_logout() -> Result<(), String> {
    let _ = delete_key("supabase_user_token");
    let _ = delete_key("supabase_user_id");
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
    let token = match get_user_token() {
        Some(t) => t,
        None => return Ok(()), // not logged in — silently skip, no spam
    };
    let user_id = match get_key("supabase_user_id").ok().flatten() {
        Some(uid) => uid,
        None => return Ok(()),
    };

    let client = reqwest::Client::new();

    // Helper: detect an expired/invalid session from a Supabase response body/status.
    fn is_auth_expired(status: u16, body: &str) -> bool {
        status == 401
            || body.contains("PGRST303")
            || body.contains("JWT expired")
            || body.contains("JWSError")
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

        let response = match client.post(&url)
            .header("apikey", SUPABASE_ANON_KEY)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .header("Prefer", "resolution=merge-duplicates")
            .json(&payload).send().await
        {
            Ok(r) => r,
            Err(_) => return Ok(()), // network down — skip quietly, retry next cycle
        };

        let status = response.status().as_u16();
        if response.status().is_success() {
            let _ = mark_synced(&t.id);
        } else {
            let body = response.text().await.unwrap_or_default();
            if is_auth_expired(status, &body) {
                // Session expired — clear stale token and stop. Avoids log spam.
                // The user will be prompted to log in again; sync resumes after that.
                let _ = delete_key("supabase_user_token");
                tracing::warn!("Cloud sync paused: session expired. Please sign in again.");
                return Err("SESSION_EXPIRED".to_string());
            }
            tracing::warn!("Task {} sync failed ({})", t.id, status);
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

        let status = response.status().as_u16();
        if response.status().is_success() {
            let _ = mark_audit_synced(&a.id);
        } else {
            let body = response.text().await.unwrap_or_default();
            if is_auth_expired(status, &body) {
                let _ = delete_key("supabase_user_token");
                return Err("SESSION_EXPIRED".to_string());
            }
        }
    }

    Ok(())
}
