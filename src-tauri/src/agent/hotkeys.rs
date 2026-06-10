use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use std::sync::Mutex;
use std::time::{Instant, Duration};
use crate::agent::planner::cancel_task;
use crate::storage::sqlite::get_setting_internal;

static LAST_ESC_PRESS: Mutex<Option<Instant>> = Mutex::new(None);

// ── Default hotkeys ──────────────────────────────────────────────────────────
// Ctrl+Space is captured by Windows IME on many systems.
// Default safe choices that work everywhere on Windows:
//   Mic activation  : Ctrl+Shift+A  (configurable)
//   Text command    : Ctrl+Shift+T  (configurable)
//   Kill switch     : Esc × 2       (HARDCODED, non-configurable by design)
pub const DEFAULT_MIC_HOTKEY:  &str = "Ctrl+Shift+A";
pub const DEFAULT_TEXT_HOTKEY: &str = "Ctrl+Shift+T";

// ── Hotkey string → Shortcut parser ─────────────────────────────────────────
/// Parse a user-facing hotkey string like "Ctrl+Shift+A" into a Tauri Shortcut.
/// Supported modifiers: Ctrl, Shift, Alt, Win/Meta/Super
/// Supported keys: any single letter A-Z, digits 0-9, F1-F12,
///                 Space, Tab, Enter, Backspace, Delete, Home, End,
///                 PageUp, PageDown, Up, Down, Left, Right, Insert, Escape
pub fn parse_hotkey(s: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = s.split('+').map(str::trim).collect();
    if parts.is_empty() {
        return None;
    }

    let mut mods = Modifiers::empty();
    let mut key_code: Option<Code> = None;

    for part in &parts {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift"            => mods |= Modifiers::SHIFT,
            "alt"              => mods |= Modifiers::ALT,
            "win" | "meta" | "super" => mods |= Modifiers::META,
            other => {
                key_code = Some(str_to_code(other)?);
            }
        }
    }

    let code = key_code?;
    let modifiers = if mods.is_empty() { None } else { Some(mods) };
    Some(Shortcut::new(modifiers, code))
}

fn str_to_code(s: &str) -> Option<Code> {
    Some(match s {
        "a" => Code::KeyA, "b" => Code::KeyB, "c" => Code::KeyC, "d" => Code::KeyD,
        "e" => Code::KeyE, "f" => Code::KeyF, "g" => Code::KeyG, "h" => Code::KeyH,
        "i" => Code::KeyI, "j" => Code::KeyJ, "k" => Code::KeyK, "l" => Code::KeyL,
        "m" => Code::KeyM, "n" => Code::KeyN, "o" => Code::KeyO, "p" => Code::KeyP,
        "q" => Code::KeyQ, "r" => Code::KeyR, "s" => Code::KeyS, "t" => Code::KeyT,
        "u" => Code::KeyU, "v" => Code::KeyV, "w" => Code::KeyW, "x" => Code::KeyX,
        "y" => Code::KeyY, "z" => Code::KeyZ,
        "0" => Code::Digit0, "1" => Code::Digit1, "2" => Code::Digit2,
        "3" => Code::Digit3, "4" => Code::Digit4, "5" => Code::Digit5,
        "6" => Code::Digit6, "7" => Code::Digit7, "8" => Code::Digit8,
        "9" => Code::Digit9,
        "f1"  => Code::F1,  "f2"  => Code::F2,  "f3"  => Code::F3,
        "f4"  => Code::F4,  "f5"  => Code::F5,  "f6"  => Code::F6,
        "f7"  => Code::F7,  "f8"  => Code::F8,  "f9"  => Code::F9,
        "f10" => Code::F10, "f11" => Code::F11, "f12" => Code::F12,
        "space"     => Code::Space,
        "tab"       => Code::Tab,
        "enter"     => Code::Enter,
        "backspace" => Code::Backspace,
        "delete"    => Code::Delete,
        "home"      => Code::Home,
        "end"       => Code::End,
        "pageup"    => Code::PageUp,
        "pagedown"  => Code::PageDown,
        "up"        => Code::ArrowUp,
        "down"      => Code::ArrowDown,
        "left"      => Code::ArrowLeft,
        "right"     => Code::ArrowRight,
        "insert"    => Code::Insert,
        "escape"    => Code::Escape,
        _ => return None,
    })
}

// ── Load hotkey strings from SQLite settings ─────────────────────────────────
fn load_hotkey_strings() -> (String, String) {
    let mic = get_setting_internal("hotkey_mic")
        .unwrap_or(None)
        .unwrap_or_else(|| DEFAULT_MIC_HOTKEY.to_string());
    let text = get_setting_internal("hotkey_text")
        .unwrap_or(None)
        .unwrap_or_else(|| DEFAULT_TEXT_HOTKEY.to_string());
    (mic, text)
}

// ── Registration ─────────────────────────────────────────────────────────────

/// Register all global shortcuts. Called once on app startup and again
/// after the user changes hotkeys in Settings.
pub fn register_core_shortcuts(app: &AppHandle) -> anyhow::Result<()> {
    let gs = app.global_shortcut();

    let (mic_str, text_str) = load_hotkey_strings();

    let mic_shortcut = parse_hotkey(&mic_str)
        .ok_or_else(|| anyhow::anyhow!("Invalid mic hotkey: '{}'", mic_str))?;
    let text_shortcut = parse_hotkey(&text_str)
        .ok_or_else(|| anyhow::anyhow!("Invalid text hotkey: '{}'", text_str))?;
    // Esc kill-switch is always registered regardless of user config
    let esc_shortcut = Shortcut::new(None, Code::Escape);

    // Unregister any previously registered shortcuts first to avoid conflicts
    let _ = gs.unregister_all();

    gs.register(mic_shortcut)?;
    gs.register(text_shortcut)?;
    gs.register(esc_shortcut)?;

    tracing::info!(
        "Global shortcuts registered: '{}' (mic), '{}' (text), Esc×2 (kill)",
        mic_str, text_str
    );
    Ok(())
}

// ── Tauri command: update hotkeys at runtime ──────────────────────────────────

/// Called from Settings page when the user changes a hotkey.
/// Validates, persists to SQLite, then re-registers all shortcuts live.
#[tauri::command]
pub fn set_hotkey(app: tauri::AppHandle, hotkey_type: String, hotkey_value: String) -> Result<(), String> {
    // Validate the new hotkey can be parsed
    parse_hotkey(&hotkey_value)
        .ok_or_else(|| format!("Invalid hotkey '{}'. Use format: Ctrl+Shift+A", hotkey_value))?;

    // Persist
    let key = match hotkey_type.as_str() {
        "mic"  => "hotkey_mic",
        "text" => "hotkey_text",
        other  => return Err(format!("Unknown hotkey type: '{}'", other)),
    };
    crate::storage::sqlite::set_setting(key, &hotkey_value)
        .map_err(|e| format!("Failed to save hotkey: {}", e))?;

    // Re-register all shortcuts with the new config
    register_core_shortcuts(&app)
        .map_err(|e| format!("Failed to re-register shortcuts: {}", e))?;

    // Notify frontend of the change
    let _ = app.emit("hotkey:updated", serde_json::json!({
        "type": hotkey_type,
        "value": hotkey_value
    }));

    tracing::info!("Hotkey '{}' updated to '{}'", hotkey_type, hotkey_value);
    Ok(())
}

/// Returns the current hotkey strings for display in Settings.
#[tauri::command]
pub fn get_hotkeys() -> Result<serde_json::Value, String> {
    let (mic, text) = load_hotkey_strings();
    Ok(serde_json::json!({
        "mic":  mic,
        "text": text,
        "kill": "Esc × 2  (hardcoded)"
    }))
}

// ── Event handler (called by lib.rs shortcut plugin callback) ────────────────

pub fn handle_shortcut_event(app: &AppHandle, shortcut: Shortcut, state: ShortcutState) {
    let (mic_str, text_str) = load_hotkey_strings();

    // Parse current shortcuts from stored settings for comparison
    let mic_shortcut  = parse_hotkey(&mic_str);
    let text_shortcut = parse_hotkey(&text_str);
    let esc_shortcut  = Shortcut::new(None, Code::Escape);

    if mic_shortcut.map_or(false, |s| s == shortcut) {
        // ── Mic walkie-talkie ─────────────────────────────────────────────────
        if state == ShortcutState::Pressed {
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.show();
                let _ = overlay.set_focus();
            }
            if let Err(e) = crate::voice::stt::start_mic_recording() {
                tracing::error!("Failed to start mic recording: {:?}", e);
            }
            let _ = app.emit("hotkey:mic_start", serde_json::json!({}));

        } else if state == ShortcutState::Released {
            let _ = app.emit("hotkey:mic_stop", serde_json::json!({}));

            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                match crate::voice::stt::stop_mic_recording().await {
                    Ok(transcript) => {
                        let trimmed = transcript.trim().to_string();
                        if !trimmed.is_empty() {
                            tracing::info!("Voice transcript: {}", trimmed);
                            let _ = app_clone.emit("voice:transcript", serde_json::json!({ "text": trimmed }));
                        } else {
                            tracing::warn!("Empty transcript from STT");
                            let _ = app_clone.emit("task:failed", serde_json::json!({
                                "error": "Could not understand speech. Please speak clearly and try again."
                            }));
                        }
                    }
                    Err(e) => {
                        tracing::error!("STT error: {:?}", e);
                        let _ = app_clone.emit("task:failed", serde_json::json!({
                            "error": format!("Voice recognition error: {}", e)
                        }));
                    }
                }
            });
        }

    } else if text_shortcut.map_or(false, |s| s == shortcut) && state == ShortcutState::Pressed {
        // ── Text command mode: show the floating text input window ────────────
        if let Some(text_win) = app.get_webview_window("textinput") {
            let _ = text_win.show();
            let _ = text_win.set_focus();
        } else {
            // Fallback: bring main window to focus
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
        let _ = app.emit("hotkey:text_mode", serde_json::json!({}));

    } else if shortcut == esc_shortcut && state == ShortcutState::Pressed {
        // ── Esc × 2 kill switch — instantly hand control back to the user ─────
        let mut last_press = LAST_ESC_PRESS.lock().unwrap();
        let now = Instant::now();
        if let Some(last) = *last_press {
            if now.duration_since(last) < Duration::from_millis(500) {
                // Release any input block IMMEDIATELY so the user regains control,
                // then cancel the running task.
                crate::automation::process::set_user_input_blocked(false);
                let _ = cancel_task();
                let _ = app.emit("agent:killed", serde_json::json!({}));
                *last_press = None;
                tracing::info!("Kill switch triggered (Esc×2) — input released, task cancelled");
                return;
            }
        }
        *last_press = Some(now);
    }
}
