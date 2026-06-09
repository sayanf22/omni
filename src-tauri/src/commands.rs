use crate::voice::stt::{start_mic_recording, stop_mic_recording};
use crate::voice::tts::speak_text;

#[tauri::command]
pub async fn trigger_mic_start() -> Result<(), String> {
    start_mic_recording().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_mic_stop() -> Result<String, String> {
    stop_mic_recording().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_tts_speak(text: String) -> Result<(), String> {
    speak_text(&text).await.map_err(|e| e.to_string())
}
