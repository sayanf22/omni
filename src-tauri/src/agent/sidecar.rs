use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use crate::storage::sqlite::{save_setting_internal};

// How long to wait for the sidecar to become healthy before giving up.
const HEALTH_CHECK_TIMEOUT_SECS: u64 = 30;
// How often to poll the health endpoint once the sidecar is running.
const HEALTH_POLL_INTERVAL_SECS: u64 = 5;
// The local address the sidecar binds to.
const SIDECAR_HEALTH_URL: &str = "http://127.0.0.1:8000/health";
// The name registered under bundle.externalBin in tauri.conf.json.
const SIDECAR_NAME: &str = "mem0-server";

/// Shared state tracking whether the sidecar is alive.
#[derive(Debug, Default)]
pub struct SidecarState {
    pub running: Mutex<bool>,
}

/// Spawn the Mem0 Python sidecar, capture its token from stdout,
/// save the token to SQLite, then start the health-check supervisor loop.
///
/// Call this inside the Tauri `.setup()` closure.
pub fn launch_sidecar(app: &AppHandle) {
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut attempt = 0u32;

        loop {
            attempt += 1;
            let backoff_secs = (2u64.pow(attempt.min(6))).min(60);

            match try_spawn_sidecar(&app_handle).await {
                Ok(token) => {
                    attempt = 0; // reset on success

                    // Persist token so memory.rs can include it in requests.
                    if let Err(e) = save_setting_internal("sidecar_token", &token) {
                        eprintln!("[sidecar] Failed to save token to SQLite: {e}");
                    } else {
                        eprintln!("[sidecar] Token saved. Sidecar is healthy.");
                    }

                    // Update shared state.
                    if let Some(state) = app_handle.try_state::<SidecarState>() {
                        *state.running.lock().unwrap() = true;
                    }

                    // Start wake-word listener in background (non-blocking).
                    // Small delay to let the sidecar fully initialize all routes.
                    let wake_app   = app_handle.clone();
                    let wake_token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        poll_wake_word_sse(wake_app, wake_token).await;
                    });

                    // Run health-check supervisor.
                    supervise_sidecar(&app_handle).await;

                    // supervise_sidecar only returns if the sidecar died.
                    eprintln!("[sidecar] Sidecar unhealthy — will restart in {backoff_secs}s.");
                    if let Some(state) = app_handle.try_state::<SidecarState>() {
                        *state.running.lock().unwrap() = false;
                    }
                }
                Err(e) => {
                    eprintln!("[sidecar] Spawn failed (attempt {attempt}): {e}. Retrying in {backoff_secs}s.");
                }
            }

            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        }
    });
}

/// Attempt to spawn the sidecar binary and extract the SIDECAR_TOKEN from its stdout.
async fn try_spawn_sidecar(app: &AppHandle) -> Result<String, String> {
    // Retrieve Supabase credentials from DPAPI to pass as env vars (never hardcode them).
    // Override via keychain is supported; otherwise falls back to default compiled-in public credentials.
    let supabase_url = crate::storage::keychain::get_key("supabase_url")
        .unwrap_or(None)
        .unwrap_or_else(|| crate::storage::supabase::SUPABASE_URL.to_string());
    let supabase_key = crate::storage::keychain::get_key("supabase_anon_key")
        .unwrap_or(None)
        .unwrap_or_else(|| crate::storage::supabase::SUPABASE_ANON_KEY.to_string());

    let shell = app.shell();

    // Build the sidecar command with environment variables.
    // The binary must be registered in tauri.conf.json under bundle.externalBin.
    // During dev, fall back to running the Python script directly.
    let sidecar_cmd = shell
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("Sidecar binary not found ({SIDECAR_NAME}): {e}. Is it registered in tauri.conf.json externalBin?"))?
        .env("SUPABASE_URL", &supabase_url)
        .env("SUPABASE_KEY", &supabase_key)
        .env("MEM0_CHROMA_PATH", get_chroma_db_path())
        .env("PORT", "8000");

    let (mut rx, _child) = sidecar_cmd.spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    // Read stdout lines until we find SIDECAR_TOKEN=<value>
    let token = tokio::time::timeout(
        Duration::from_secs(HEALTH_CHECK_TIMEOUT_SECS),
        async {
            while let Some(event) = rx.recv().await {
                if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[sidecar stdout] {text}");
                    if let Some(tok) = text.strip_prefix("SIDECAR_TOKEN=") {
                        return Ok(tok.trim().to_string());
                    }
                } else if let tauri_plugin_shell::process::CommandEvent::Stderr(line) = event {
                    eprintln!("[sidecar stderr] {}", String::from_utf8_lossy(&line));
                } else if let tauri_plugin_shell::process::CommandEvent::Error(e) = event {
                    return Err(format!("Sidecar process error: {e}"));
                } else if matches!(event, tauri_plugin_shell::process::CommandEvent::Terminated(_)) {
                    return Err("Sidecar terminated before emitting token".to_string());
                }
            }
            Err("Stdout closed without emitting token".to_string())
        }
    )
    .await
    .map_err(|_| format!("Timed out waiting for sidecar to emit token after {HEALTH_CHECK_TIMEOUT_SECS}s"))?;

    // Wait a moment then confirm health endpoint is up.
    tokio::time::sleep(Duration::from_millis(500)).await;
    wait_for_healthy(HEALTH_CHECK_TIMEOUT_SECS).await
        .map_err(|e| format!("Sidecar spawned but health check failed: {e}"))?;

    token
}

/// Poll GET /health until it returns 200 or the timeout elapses.
async fn wait_for_healthy(timeout_secs: u64) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        match client.get(SIDECAR_HEALTH_URL).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("Health check timed out after {timeout_secs}s"));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Poll the health endpoint every HEALTH_POLL_INTERVAL_SECS seconds.
/// Returns when 3 consecutive failures are detected (sidecar is down).
async fn supervise_sidecar(app: &AppHandle) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sidecar] Failed to build HTTP client for supervisor: {e}");
            return;
        }
    };

    let mut consecutive_failures = 0u32;
    const MAX_FAILURES: u32 = 3;

    loop {
        tokio::time::sleep(Duration::from_secs(HEALTH_POLL_INTERVAL_SECS)).await;

        // If the app is being torn down, stop supervising.
        if app.try_state::<SidecarState>().is_none() {
            return;
        }

        match client.get(SIDECAR_HEALTH_URL).send().await {
            Ok(r) if r.status().is_success() => {
                consecutive_failures = 0;
            }
            _ => {
                consecutive_failures += 1;
                eprintln!("[sidecar] Health check failed ({consecutive_failures}/{MAX_FAILURES}).");
                if consecutive_failures >= MAX_FAILURES {
                    eprintln!("[sidecar] Sidecar is down — triggering restart.");
                    // Clear the stale token.
                    let _ = save_setting_internal("sidecar_token", "");
                    return;
                }
            }
        }
    }
}

/// Returns the platform-specific path for ChromaDB storage.
fn get_chroma_db_path() -> String {
    let mut path = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push("Omni");
    path.push("chroma_db");
    let _ = std::fs::create_dir_all(&path);
    path.to_string_lossy().to_string()
}

/// Poll the sidecar's `/wake` SSE endpoint and emit `wake:detected` Tauri events.
/// Auto-reconnects if the connection drops (sidecar restart, network hiccup).
async fn poll_wake_word_sse(app: AppHandle, token: String) {
    use tauri::Emitter;
    use futures_util::StreamExt;

    let url = "http://127.0.0.1:8000/wake";
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(0)) // no timeout — SSE is long-lived
        .build()
    {
        Ok(c) => c,
        Err(e) => { tracing::error!("[wake] Failed to build client: {e}"); return; }
    };

    // Retry outer loop — reconnects after drop or error
    loop {
        let resp = match client
            .get(url)
            .header("X-Sidecar-Token", &token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!("[wake] Cannot connect ({e}), retrying in 10s…");
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };

        tracing::info!("[wake] Connected to wake-word SSE stream");
        let mut stream = resp.bytes_stream();
        let mut permanent_stop = false;

        while let Some(chunk) = stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => { tracing::warn!("[wake] SSE chunk error: {e}"); break; }
            };

            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                if !line.starts_with("data: ") { continue; }
                match line.trim_start_matches("data: ").trim() {
                    "detected" => {
                        tracing::info!("[wake] Wake word detected — starting mic recording");
                        if let Some(overlay) = app.get_webview_window("overlay") {
                            let _ = overlay.show();
                            let _ = overlay.set_always_on_top(true);
                        }
                        let _ = app.emit("wake:detected", serde_json::json!({}));
                        crate::agent::planner::live_reset();
                        crate::agent::planner::live_set_phase("listening", "Hey Omni — say your command…");
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = crate::voice::stt::start_mic_recording(app2) {
                                tracing::error!("[wake] start_mic_recording failed: {e}");
                            }
                        });
                    }
                    "disabled" => {
                        tracing::info!("[wake] Wake word disabled by server config");
                        permanent_stop = true; break;
                    }
                    "unavailable" | "error" => {
                        tracing::warn!("[wake] Wake word unavailable in sidecar (openWakeWord/PyAudio missing)");
                        permanent_stop = true; break;
                    }
                    _ => {}
                }
            }
            if permanent_stop { break; }
        }

        if permanent_stop {
            tracing::info!("[wake] Shutting down wake-word SSE poller (permanent stop).");
            break;
        }
        tracing::info!("[wake] SSE stream ended — reconnecting in 8s…");
        tokio::time::sleep(Duration::from_secs(8)).await;
    }
}
