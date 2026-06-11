use crate::voice::stt::{start_mic_recording, stop_mic_recording};
use crate::voice::tts::speak_text;

#[tauri::command]
pub async fn trigger_mic_start(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    // Show the overlay and switch it to listening state
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.unminimize();
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
        if let Ok(Some(monitor)) = overlay.primary_monitor() {
            let scale = monitor.scale_factor();
            let screen_w = monitor.size().width as f64 / scale;
            let x = (screen_w - 420.0).max(0.0);
            let _ = overlay.set_position(tauri::LogicalPosition::new(x, 40.0));
        }
    }
    // Pre-set live state so polling picks it up even if event is missed
    crate::agent::planner::live_reset();
    crate::agent::planner::live_set_phase("listening", "Listening…");
    let _ = app.emit("hotkey:mic_start", serde_json::json!({}));
    start_mic_recording(app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_mic_stop() -> Result<String, String> {
    stop_mic_recording().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_tts_speak(text: String) -> Result<(), String> {
    speak_text(&text).await.map_err(|e| e.to_string())
}
