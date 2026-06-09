use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingApproval {
    pub id: String,
    pub tool: String,
    pub action: String,
    pub description: String,
    pub preview: Option<String>,
}

use std::sync::OnceLock;

pub fn get_permission_gate() -> &'static PermissionGate {
    static GATE: OnceLock<PermissionGate> = OnceLock::new();
    GATE.get_or_init(PermissionGate::new)
}

pub struct PermissionGate {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl PermissionGate {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Emits a permission request to ALL windows (main + overlay) and awaits user approval.
    pub async fn request_approval(
        &self,
        request: PendingApproval,
        app: &AppHandle,
    ) -> bool {
        let (tx, rx) = oneshot::channel();

        {
            let mut lock = self.pending.lock().await;
            lock.insert(request.id.clone(), tx);
        }

        // Show the overlay window so the user sees the approval dialog
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }

        // Broadcast to ALL windows (main + overlay)
        if let Err(e) = app.emit("permission:request", &request) {
            eprintln!("Failed to emit permission request: {:?}", e);
            let mut lock = self.pending.lock().await;
            lock.remove(&request.id);
            return false;
        }

        // Await the user response with a 60-second timeout
        tokio::select! {
            res = rx => {
                res.unwrap_or(false)
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                let mut lock = self.pending.lock().await;
                lock.remove(&request.id);
                false
            }
        }
    }

    /// Resolves a pending approval with the user's response.
    pub async fn respond(&self, id: &str, approved: bool) {
        let mut lock = self.pending.lock().await;
        if let Some(tx) = lock.remove(id) {
            let _ = tx.send(approved);
        }
    }
}

#[tauri::command]
pub async fn approve_request(id: String, approved: bool) -> Result<(), String> {
    get_permission_gate().respond(&id, approved).await;
    Ok(())
}
