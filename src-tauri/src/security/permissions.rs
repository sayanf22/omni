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
    pending_answers: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl PermissionGate {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_answers: Arc::new(Mutex::new(HashMap::new())),
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

        // If cancellation was already requested, don't even wait.
        if crate::agent::planner::is_cancelled() {
            let mut lock = self.pending.lock().await;
            lock.remove(&request.id);
            return false;
        }

        // Broadcast to ALL windows (main + overlay)
        if let Err(e) = app.emit("permission:request", &request) {
            eprintln!("Failed to emit permission request: {:?}", e);
            let mut lock = self.pending.lock().await;
            lock.remove(&request.id);
            return false;
        }

        // Await the user response with a 60-second timeout
        let cancel_notify = crate::agent::planner::cancel_notify_handle();
        tokio::select! {
            res = rx => {
                res.unwrap_or(false)
            }
            _ = cancel_notify.notified() => {
                // User cancelled (Esc×2 / Stop) — abort instantly, never freeze.
                let mut lock = self.pending.lock().await;
                lock.remove(&request.id);
                false
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

    /// Emits a free-text QUESTION to all windows and awaits the user's typed answer.
    /// Returns None if the user cancelled or timed out (5 min for typed answers).
    pub async fn request_answer(
        &self,
        id: String,
        question: String,
        app: &AppHandle,
    ) -> Option<String> {
        let (tx, rx) = oneshot::channel();

        {
            let mut lock = self.pending_answers.lock().await;
            lock.insert(id.clone(), tx);
        }

        // Show the overlay so the user can answer there too
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }

        // If cancellation was already requested, don't even wait.
        if crate::agent::planner::is_cancelled() {
            let mut lock = self.pending_answers.lock().await;
            lock.remove(&id);
            return None;
        }

        // Broadcast the question to ALL windows
        if let Err(e) = app.emit("question:request", serde_json::json!({
            "id": id, "question": question
        })) {
            eprintln!("Failed to emit question request: {:?}", e);
            let mut lock = self.pending_answers.lock().await;
            lock.remove(&id);
            return None;
        }

        // Await the typed answer with a generous 5-minute timeout
        let cancel_notify = crate::agent::planner::cancel_notify_handle();
        tokio::select! {
            res = rx => res.ok().filter(|s| !s.is_empty()),
            _ = cancel_notify.notified() => {
                // User cancelled (Esc×2 / Stop) — abort the wait instantly so the
                // task never freezes parked on an unanswerable question.
                let mut lock = self.pending_answers.lock().await;
                lock.remove(&id);
                None
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
                let mut lock = self.pending_answers.lock().await;
                lock.remove(&id);
                None
            }
        }
    }

    /// Resolves a pending question with the user's typed answer.
    /// An empty string signals cancellation.
    pub async fn submit_answer(&self, id: &str, answer: String) {
        let mut lock = self.pending_answers.lock().await;
        if let Some(tx) = lock.remove(id) {
            let _ = tx.send(answer);
        }
    }

    /// Check if there is currently a pending question request.
    pub async fn has_pending_question(&self) -> bool {
        let lock = self.pending_answers.lock().await;
        !lock.is_empty()
    }
}

#[tauri::command]
pub async fn approve_request(id: String, approved: bool) -> Result<(), String> {
    get_permission_gate().respond(&id, approved).await;
    Ok(())
}

#[tauri::command]
pub async fn answer_question(id: String, answer: String) -> Result<(), String> {
    get_permission_gate().submit_answer(&id, answer).await;
    Ok(())
}
