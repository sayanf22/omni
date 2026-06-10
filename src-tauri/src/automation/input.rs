use enigo::{Enigo, Settings, Direction, Key, Keyboard, Mouse, Axis};
use windows::Win32::System::DataExchange::{OpenClipboard, CloseClipboard, SetClipboardData, EmptyClipboard};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::Foundation::{HWND, HANDLE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, MOUSEINPUT, INPUT_MOUSE,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, GetCursorPos, SM_CXSCREEN, SM_CYSCREEN};
use windows::Win32::Foundation::POINT;

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

/// Returns the current cursor position in screen pixels, or (0,0) on failure.
fn current_cursor_pos() -> (i32, i32) {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p).is_ok() {
            (p.x, p.y)
        } else {
            (0, 0)
        }
    }
}

/// Tiny, dependency-free xorshift PRNG seeded from the system clock. Used only
/// for generating natural mouse jitter — cryptographic quality is not required.
struct Rng(u64);
impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15)
            | 1;
        Rng(seed)
    }
    /// Next f64 in [0.0, 1.0).
    fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        // 53-bit mantissa for a uniform double.
        ((x >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

/// Moves the mouse from its current position to (dest_x, dest_y) along a natural,
/// curved, human-like path using the **WindMouse** algorithm (gravity + wind
/// forces). This avoids the dead-straight, instantaneous jumps that make
/// automation obvious. Tuned to stay fast (sub-second) while looking organic.
///
/// Reference: Ben Land's WindMouse (ben.land/post/2021/04/25/windmouse-human-mouse-movement).
pub fn human_move(dest_x: i32, dest_y: i32) -> anyhow::Result<()> {
    let (start_x, start_y) = current_cursor_pos();
    let total_dist = (((dest_x - start_x).pow(2) + (dest_y - start_y).pow(2)) as f64).sqrt();

    // Very short hops don't need a curve — snap directly.
    if total_dist < 4.0 {
        return mouse_move_to(dest_x, dest_y);
    }

    // WindMouse tuning constants.
    let g_0: f64 = 9.0;   // gravity — pulls toward the target
    let w_0: f64 = 3.0;   // wind — random perturbation magnitude
    let mut m_0: f64 = 18.0; // max step size (higher = faster)
    let d_0: f64 = 12.0;  // distance at which wind/step start damping
    let sqrt3 = 3.0_f64.sqrt();
    let sqrt5 = 5.0_f64.sqrt();

    let mut rng = Rng::new();
    let (mut cx, mut cy) = (start_x as f64, start_y as f64);
    let (mut vx, mut vy) = (0.0_f64, 0.0_f64);
    let (mut wx, mut wy) = (0.0_f64, 0.0_f64);
    let (mut last_x, mut last_y) = (start_x, start_y);

    // Safety cap so a pathological case can never spin forever / block too long.
    let max_iters = 600;
    let mut iters = 0;

    loop {
        iters += 1;
        if iters > max_iters {
            break;
        }
        let dx = dest_x as f64 - cx;
        let dy = dest_y as f64 - cy;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist < 1.0 {
            break;
        }

        let w_mag = w_0.min(dist);
        if dist >= d_0 {
            wx = wx / sqrt3 + (2.0 * rng.next_f64() - 1.0) * w_mag / sqrt5;
            wy = wy / sqrt3 + (2.0 * rng.next_f64() - 1.0) * w_mag / sqrt5;
        } else {
            wx /= sqrt3;
            wy /= sqrt3;
            if m_0 < 3.0 {
                m_0 = rng.next_f64() * 3.0 + 3.0;
            } else {
                m_0 /= sqrt5;
            }
        }

        vx += wx + g_0 * dx / dist;
        vy += wy + g_0 * dy / dist;
        let v_mag = (vx * vx + vy * vy).sqrt();
        if v_mag > m_0 {
            let v_clip = m_0 / 2.0 + rng.next_f64() * m_0 / 2.0;
            vx = (vx / v_mag) * v_clip;
            vy = (vy / v_mag) * v_clip;
        }

        cx += vx;
        cy += vy;
        let mx = cx.round() as i32;
        let my = cy.round() as i32;
        if mx != last_x || my != last_y {
            let _ = mouse_move_to(mx, my);
            last_x = mx;
            last_y = my;
            // Brief, slightly randomized pause for a natural cadence.
            let pause = 1 + (rng.next_f64() * 2.0) as u64;
            std::thread::sleep(std::time::Duration::from_millis(pause));
        }
    }

    // Land precisely on the target.
    mouse_move_to(dest_x, dest_y)
}

/// Simulates a left mouse click at (x, y). The cursor first glides to the target
/// along a natural WindMouse path, then clicks via Win32 SendInput.
pub fn mouse_click_internal(x: i32, y: i32) -> anyhow::Result<()> {
    let _ = human_move(x, y);
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

/// Simulates a right mouse click at (x, y). Glides naturally to the target first.
pub fn mouse_right_click(x: i32, y: i32) -> anyhow::Result<()> {
    let _ = human_move(x, y);
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

/// Simulates a double left mouse click at (x, y). Glides naturally to the target first.
pub fn mouse_double_click(x: i32, y: i32) -> anyhow::Result<()> {
    let _ = human_move(x, y);
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
