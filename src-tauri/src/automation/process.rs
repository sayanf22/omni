use serde::{Serialize, Deserialize};
use std::path::PathBuf;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, IsWindowVisible, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow, SW_RESTORE
};
use windows::Win32::Foundation::{HWND, LPARAM, BOOL};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub hwnd: isize,
    pub pid: u32,
    pub exe_name: String,
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<AppInfo>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut text = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut text);
        if len > 0 {
            let title = String::from_utf16_lossy(&text[..len as usize]);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            
            list.push(AppInfo {
                name: title,
                hwnd: hwnd.0 as isize,
                pid,
                exe_name: String::new(), // Optional: query EXE name in future
            });
        }
    }
    BOOL::from(true)
}

/// Retrieves a list of running visible windows with titles.
pub fn list_running_apps_internal() -> Vec<AppInfo> {
    let mut list = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_windows_callback), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

/// Searches and launches an application by name.
pub fn launch_app_internal(name: &str) -> anyhow::Result<u32> {
    let name_lower = name.to_lowercase();
    let mut exe_path = None;

    if name_lower.contains("chrome") {
        exe_path = Some(PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
    } else if name_lower.contains("notepad") {
        exe_path = Some(PathBuf::from(r"C:\Windows\System32\notepad.exe"));
    } else if name_lower.contains("explorer") {
        exe_path = Some(PathBuf::from(r"C:\Windows\explorer.exe"));
    } else if name_lower.contains("cmd") {
        exe_path = Some(PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    }

    if exe_path.is_none() {
        let search_paths = vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
            PathBuf::from(r"C:\Windows\System32"),
            dirs::data_dir().unwrap_or_default(),
            dirs::home_dir().map(|p| p.join("Desktop")).unwrap_or_default(),
        ];

        for root in search_paths {
            if root.exists() {
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() && path.extension().map_or(false, |ext| ext == "exe") {
                            let file_name = path.file_stem().unwrap_or_default().to_string_lossy().to_lowercase();
                            if file_name.contains(&name_lower) {
                                exe_path = Some(path);
                                break;
                            }
                        }
                    }
                }
            }
            if exe_path.is_some() {
                break;
            }
        }
    }

    let final_path = exe_path.unwrap_or_else(|| PathBuf::from(name));
    let child = std::process::Command::new(&final_path)
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to spawn process {:?}: {}", final_path, e))?;

    Ok(child.id())
}

/// Sets the focus to a window matching the specified name.
pub fn focus_window_by_name(name: &str) -> anyhow::Result<()> {
    unsafe {
        let mut hwnd = HWND(std::ptr::null_mut());
        let name_lower = name.to_lowercase();
        let list = list_running_apps_internal();
        
        for app in list {
            if app.name.to_lowercase().contains(&name_lower) {
                hwnd = HWND(app.hwnd as _);
                break;
            }
        }

        if hwnd.0.is_null() {
            return Err(anyhow::anyhow!("Window not found: {}", name));
        }

        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
        Ok(())
    }
}

/// Retrieves the active window info.
pub fn get_active_window() -> AppInfo {
    // Basic fallback or active window mapping
    AppInfo {
        name: get_focused_window_name(),
        hwnd: 0,
        pid: 0,
        exe_name: String::new(),
    }
}

/// Retrieves the name of the currently focused window.
fn get_focused_window_name() -> String {
    super::uia::get_focused_window_name()
}

/// Checks if an app matching the specified name is running.
pub fn is_app_running(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    let list = list_running_apps_internal();
    list.iter().any(|app| app.name.to_lowercase().contains(&name_lower))
}

/// Tauri IPC wrappers
#[tauri::command]
pub fn launch_app(name: String) -> Result<(), String> {
    launch_app_internal(&name).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_window(name: String) -> Result<(), String> {
    focus_window_by_name(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_running_apps() -> Vec<AppInfo> {
    list_running_apps_internal()
}
