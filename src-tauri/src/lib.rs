pub mod automation;
pub mod storage;
pub mod ai;
pub mod agent;
pub mod security;
pub mod voice;
pub mod commands;
pub mod tools;

// Imports from automation
use automation::screen::take_screenshot;
use automation::ocr::{ocr_screen, find_text_on_screen};
use automation::uia::get_ui_tree;
use automation::input::{mouse_click, type_text, press_key, press_hotkey};
use automation::process::{launch_app, focus_window, list_running_apps, get_running_windows, set_input_blocked};

// Imports from storage
use storage::keychain::{save_api_key, get_api_key, has_api_key, delete_api_key};
use storage::sqlite::{
    get_recent_tasks, get_audit_log, save_setting, get_setting, clear_all_local_data, init_db,
    save_custom_model, delete_custom_model, get_custom_models, get_active_model_for_role,
    get_unsynced_local_tasks, mark_task_synced_local, get_unsynced_local_audit, mark_audit_synced_local,
    force_cancel_task, cleanup_orphaned_tasks
};
use storage::supabase::{
    supabase_login, supabase_signup, supabase_login_with_otp, get_supabase_session, supabase_logout, sync_local_to_cloud, refresh_session
};

// Imports from other modules
use security::permissions::{approve_request, answer_question};
use agent::planner::{run_task, cancel_task, get_live_state};
use agent::sidecar::SidecarState;
use ai::{test_model_connection, test_stored_model};
use ai::client::{probe_model_vision, probe_model_audio, probe_model_video, detect_model_reasoning};
use ai::memory::{get_all_memories, delete_memory_item, search_memory_items, add_custom_memory_item};
use commands::{trigger_mic_start, trigger_mic_stop, trigger_tts_speak};
use voice::stt::{get_stt_status, download_whisper, start_voice_test};
use voice::tts::{test_elevenlabs_key, download_piper, piper_installed};
use agent::hotkeys::{set_hotkey, get_hotkeys};
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::WindowEvent;

/// Returns the sidecar health status. Used by the frontend Memory/Settings pages
/// to indicate whether the local Mem0 engine is available.
#[tauri::command]
fn get_sidecar_status(state: tauri::State<SidecarState>) -> bool {
    *state.running.lock().unwrap()
}

/// Returns the current working directory of the application process.
#[tauri::command]
fn get_current_working_dir() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging (tracing subscriber) writing JSON to file in %APPDATA%\Omni\logs\omni.jsonl
    let mut log_dir = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    log_dir.push("Omni");
    log_dir.push("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    log_dir.push("omni.jsonl");

    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&log_dir)
    {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(file))
            .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
            .json()
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
    } else {
        let subscriber = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
    }

    tracing::info!("Starting Omni Agent application");

    // Initialize SQLite database
    if let Err(e) = init_db() {
        tracing::error!("Failed to initialize local SQLite database: {:?}", e);
    }

    // Clean up any tasks stuck in "running" from a previous crash/restart
    match storage::sqlite::cleanup_orphaned_tasks() {
        Ok(n) if n > 0 => tracing::info!("Cleaned up {} orphaned running task(s)", n),
        _ => {}
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                agent::hotkeys::handle_shortcut_event(app, shortcut.clone(), event.state);
            })
            .build()
        )
        .manage(SidecarState::default())
        .setup(|app| {
            // Provide the takeover module with an app handle (for events + escape).
            crate::automation::takeover::set_app(app.handle().clone());

            // Register Ctrl+Space and Ctrl+Shift+Space global shortcuts
            if let Err(e) = agent::hotkeys::register_core_shortcuts(&app.handle()) {
                tracing::error!("Failed to register global shortcuts: {:?}", e);
            }

            // Launch the Mem0 Python sidecar (auto-managed lifecycle).
            // In development, if OMNI_DEV_MODE=1 is set, we assume the server is already
            // running manually and skip spawning — just mark it as running.
            let is_dev_mode = std::env::var("OMNI_DEV_MODE").unwrap_or_default() == "1";
            if is_dev_mode {
                tracing::info!("[sidecar] DEV_MODE: skipping sidecar spawn, assuming manual server at :8000.");
                if let Some(state) = app.handle().try_state::<SidecarState>() {
                    *state.running.lock().unwrap() = true;
                }
            } else {
                agent::sidecar::launch_sidecar(&app.handle());
            }

            // Create context menu for system tray
            let open_i = MenuItemBuilder::new("Open Dashboard").id("open").build(app)?;
            let exit_i = MenuItemBuilder::new("Exit").id("exit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open_i, &exit_i]).build()?;

            // Build system tray
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "exit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Show main window on start to display Onboarding / Login
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // Position the overlay window at the top-right corner of the primary monitor
            // 20px margin from right and top edges.
            if let Some(overlay) = app.get_webview_window("overlay") {
                if let Ok(monitor) = overlay.primary_monitor() {
                    if let Some(monitor) = monitor {
                        let screen_w = monitor.size().width as i32;
                        let scale = monitor.scale_factor();
                        let logical_screen_w = (screen_w as f64 / scale) as i32;
                        // Position 40px from the right edge, 40px from top (avoids taskbar/system chrome)
                        let overlay_w = 400_i32;
                        let margin_right = 20_i32;
                        let margin_top = 40_i32;
                        let x = logical_screen_w - overlay_w - margin_right;
                        let y = margin_top;
                        let _ = overlay.set_position(tauri::LogicalPosition::new(x, y));
                    }
                }
                // Apply native Windows Acrylic blur effect to the overlay window.
                // This composites the translucent card glass over the real desktop below.
                #[cfg(target_os = "windows")]
                {
                    use tauri::window::{Effect, EffectState, EffectsBuilder};
                    let _ = overlay.set_effects(
                        EffectsBuilder::new()
                            .effect(Effect::Acrylic)
                            .state(EffectState::Active)
                            .build(),
                    );
                }
            }

            // Apply native Acrylic to the text input overlay too
            if let Some(textinput) = app.get_webview_window("textinput") {
                #[cfg(target_os = "windows")]
                {
                    use tauri::window::{Effect, EffectState, EffectsBuilder};
                    let _ = textinput.set_effects(
                        EffectsBuilder::new()
                            .effect(Effect::Acrylic)
                            .state(EffectState::Active)
                            .build(),
                    );
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            take_screenshot,
            ocr_screen,
            find_text_on_screen,
            get_ui_tree,
            mouse_click,
            type_text,
            press_key,
            press_hotkey,
            launch_app,
            focus_window,
            list_running_apps,
            set_input_blocked,
            get_running_windows,
            save_api_key,
            get_api_key,
            has_api_key,
            delete_api_key,
            get_recent_tasks,
            get_audit_log,
            save_setting,
            get_setting,
            clear_all_local_data,
            save_custom_model,
            delete_custom_model,
            get_custom_models,
            get_active_model_for_role,
            get_unsynced_local_tasks,
            mark_task_synced_local,
            get_unsynced_local_audit,
            mark_audit_synced_local,
            approve_request,
            answer_question,
            run_task,
            cancel_task,
            get_live_state,
            test_model_connection,
            test_stored_model,
            probe_model_vision,
            trigger_mic_start,
            trigger_mic_stop,
            trigger_tts_speak,
            get_stt_status,
            download_whisper,
            start_voice_test,
            test_elevenlabs_key,
            download_piper,
            piper_installed,
            get_all_memories,
            delete_memory_item,
            search_memory_items,
            add_custom_memory_item,
            get_sidecar_status,
            get_current_working_dir,
            supabase_login,
            supabase_signup,
            supabase_login_with_otp,
            get_supabase_session,
            supabase_logout,
            sync_local_to_cloud,
            set_hotkey,
            get_hotkeys,
            probe_model_audio,
            probe_model_video,
            detect_model_reasoning,
            force_cancel_task,
            cleanup_orphaned_tasks,
            refresh_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
