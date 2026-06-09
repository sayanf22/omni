use enigo::{Enigo, Settings, Direction, Key, Keyboard, Mouse, Axis};
use windows::Win32::System::DataExchange::{OpenClipboard, CloseClipboard, SetClipboardData, EmptyClipboard};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::Foundation::{HWND, HANDLE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, MOUSEINPUT, INPUT_MOUSE,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

/// Sets the clipboard content to the specified text using the Win32 API.
pub fn set_clipboard_text(text: &str) -> anyhow::Result<()> {
    unsafe {
        OpenClipboard(HWND(std::ptr::null_mut()))
            .map_err(|e| anyhow::anyhow!("Failed to open clipboard: {:?}", e))?;
        EmptyClipboard()
            .map_err(|e| anyhow::anyhow!("Failed to empty clipboard: {:?}", e))?;

        let wide_str: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let size = wide_str.len() * 2;
        
        let handle = GlobalAlloc(GMEM_MOVEABLE, size)
            .map_err(|e| anyhow::anyhow!("GlobalAlloc failed: {:?}", e))?;
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            let _ = CloseClipboard();
            return Err(anyhow::anyhow!("GlobalLock failed"));
        }
        
        std::ptr::copy_nonoverlapping(wide_str.as_ptr(), ptr as *mut u16, wide_str.len());
        let _ = GlobalUnlock(handle);

        SetClipboardData(13, HANDLE(handle.0)) // CF_UNICODETEXT = 13
            .map_err(|e| anyhow::anyhow!("SetClipboardData failed: {:?}", e))?;

        CloseClipboard()
            .map_err(|e| anyhow::anyhow!("Failed to close clipboard: {:?}", e))?;
        Ok(())
    }
}

/// Helper function to map a string representation of a key to the Enigo Key enum.
fn map_key(key_str: &str) -> Option<Key> {
    match key_str.to_lowercase().as_str() {
        "enter" => Some(Key::Return),
        "escape" => Some(Key::Escape),
        "tab" => Some(Key::Tab),
        "backspace" => Some(Key::Backspace),
        "delete" => Some(Key::Delete),
        "up" | "uparrow" => Some(Key::UpArrow),
        "down" | "downarrow" => Some(Key::DownArrow),
        "left" | "leftarrow" => Some(Key::LeftArrow),
        "right" | "rightarrow" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "space" => Some(Key::Space),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "ctrl" | "control" => Some(Key::Control),
        "alt" => Some(Key::Alt),
        "shift" => Some(Key::Shift),
        "win" | "super" | "meta" => Some(Key::Meta),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        s if s.len() == 1 => Some(Key::Unicode(s.chars().next().unwrap())),
        _ => None,
    }
}

/// Convert logical screen coordinates to normalized absolute (0..65535) for SendInput.
fn to_normalized(x: i32, y: i32) -> anyhow::Result<(i32, i32)> {
    unsafe {
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        if screen_w == 0 || screen_h == 0 {
            return Err(anyhow::anyhow!("Could not get screen dimensions"));
        }
        let norm_x = (x * 65535) / screen_w + 1;
        let norm_y = (y * 65535) / screen_h + 1;
        Ok((norm_x, norm_y))
    }
}

/// Simulates a left mouse click at (x, y) using Win32 SendInput — fast, no Enigo overhead.
pub fn mouse_click_internal(x: i32, y: i32) -> anyhow::Result<()> {
    let (nx, ny) = to_normalized(x, y)?;
    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
        ];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != 3 {
            return Err(anyhow::anyhow!("SendInput failed: sent {} of 3 events", sent));
        }
    }
    Ok(())
}

/// Simulates a right mouse click at (x, y) using Win32 SendInput.
pub fn mouse_right_click(x: i32, y: i32) -> anyhow::Result<()> {
    let (nx, ny) = to_normalized(x, y)?;
    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
        ];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != 3 {
            return Err(anyhow::anyhow!("SendInput right-click failed: sent {} of 3 events", sent));
        }
    }
    Ok(())
}

/// Simulates a double left mouse click at (x, y) using Win32 SendInput.
pub fn mouse_double_click(x: i32, y: i32) -> anyhow::Result<()> {
    let (nx, ny) = to_normalized(x, y)?;
    unsafe {
        let inputs = [
            // Move
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            // First click down
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            // First click up
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            // Second click down
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
            // Second click up
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
        ];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != 5 {
            return Err(anyhow::anyhow!("SendInput double-click failed: sent {} of 5 events", sent));
        }
    }
    Ok(())
}

/// Moves the mouse to (x, y) using Win32 SendInput.
pub fn mouse_move_to(x: i32, y: i32) -> anyhow::Result<()> {
    let (nx, ny) = to_normalized(x, y)?;
    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, time: 0, dwExtraInfo: 0 } },
            },
        ];
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != 1 {
            return Err(anyhow::anyhow!("SendInput move failed: sent {} of 1 event", sent));
        }
    }
    Ok(())
}

/// Simulates mouse scrolling (still uses Enigo since scroll isn't trivially replaced with SendInput wheel normalization).
pub fn mouse_scroll(x: i32, y: i32, dir: &str, amount: i32) -> anyhow::Result<()> {
    // Move to position first via SendInput
    mouse_move_to(x, y)?;

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("Failed to init Enigo: {:?}", e))?;

    let axis = match dir.to_lowercase().as_str() {
        "horizontal" | "left" | "right" => Axis::Horizontal,
        _ => Axis::Vertical,
    };

    let final_amount = if dir.eq_ignore_ascii_case("up") || dir.eq_ignore_ascii_case("left") {
        -amount
    } else {
        amount
    };

    enigo.scroll(final_amount, axis)
        .map_err(|e| anyhow::anyhow!("Failed to scroll: {:?}", e))?;
    Ok(())
}

/// Types text directly or fallback to clipboard paste if length > 100.
pub fn type_text_internal(text: &str) -> anyhow::Result<()> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("Failed to init Enigo: {:?}", e))?;
    if text.len() > 100 {
        set_clipboard_text(text)?;
        enigo.key(Key::Control, Direction::Press)
            .map_err(|e| anyhow::anyhow!("Failed to press Ctrl: {:?}", e))?;
        enigo.key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| anyhow::anyhow!("Failed to click v: {:?}", e))?;
        enigo.key(Key::Control, Direction::Release)
            .map_err(|e| anyhow::anyhow!("Failed to release Ctrl: {:?}", e))?;
    } else {
        enigo.text(text)
            .map_err(|e| anyhow::anyhow!("Failed to type text: {:?}", e))?;
    }
    Ok(())
}

/// Simulates a single key press.
pub fn press_key_internal(key_name: &str) -> anyhow::Result<()> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("Failed to init Enigo: {:?}", e))?;
    if let Some(key) = map_key(key_name) {
        enigo.key(key, Direction::Click)
            .map_err(|e| anyhow::anyhow!("Failed to click key: {:?}", e))?;
        Ok(())
    } else {
        Err(anyhow::anyhow!("Unsupported key: {}", key_name))
    }
}

/// Simulates pressing a combination of keys (hotkey).
pub fn press_hotkey_internal(keys: Vec<String>) -> anyhow::Result<()> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| anyhow::anyhow!("Failed to init Enigo: {:?}", e))?;
    let mut mapped_keys = Vec::new();
    for k in &keys {
        if let Some(key) = map_key(k) {
            mapped_keys.push(key);
        } else {
            return Err(anyhow::anyhow!("Unsupported key in hotkey combo: {}", k));
        }
    }

    // Press all modifiers
    for key in &mapped_keys {
        enigo.key(*key, Direction::Press)
            .map_err(|e| anyhow::anyhow!("Failed to press key: {:?}", e))?;
    }

    // Release all modifiers in reverse order
    for key in mapped_keys.iter().rev() {
        enigo.key(*key, Direction::Release)
            .map_err(|e| anyhow::anyhow!("Failed to release key: {:?}", e))?;
    }

    Ok(())
}

/// Tauri IPC wrappers
#[tauri::command]
pub fn mouse_click(x: i32, y: i32) -> Result<(), String> {
    mouse_click_internal(x, y).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    type_text_internal(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn press_key(key: String) -> Result<(), String> {
    press_key_internal(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn press_hotkey(keys: Vec<String>) -> Result<(), String> {
    press_hotkey_internal(keys).map_err(|e| e.to_string())
}
