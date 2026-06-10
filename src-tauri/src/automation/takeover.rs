//! Takeover: block the user's PHYSICAL mouse + keyboard while the agent is
//! working, so the user can't interfere — while still letting the agent's own
//! synthetic (SendInput) events through. Press Esc twice to take control back.
//!
//! Implementation: low-level Windows hooks (WH_KEYBOARD_LL + WH_MOUSE_LL) on a
//! dedicated thread with a message loop. The hook procs swallow physical events
//! (return 1) when blocking is active, but pass anything with the INJECTED flag
//! (our agent's SendInput) and always watch for the double-Esc escape.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, GetMessageW, PostThreadMessageW,
    HHOOK, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL, WH_MOUSE_LL, LLKHF_INJECTED, LLMHF_INJECTED,
    WM_KEYDOWN, WM_SYSKEYDOWN, WM_QUIT,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

static BLOCK_ACTIVE: AtomicBool = AtomicBool::new(false);
static THREAD_RUNNING: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST_ESC: Mutex<Option<Instant>> = Mutex::new(None);

const VK_ESCAPE: u32 = 0x1B;

/// Store the app handle so hook callbacks can emit events / trigger cancel.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Is physical input currently being blocked?
pub fn is_blocking() -> bool {
    BLOCK_ACTIVE.load(Ordering::SeqCst)
}

// ── Hook callbacks ────────────────────────────────────────────────────────────

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = (kb.flags.0 & LLKHF_INJECTED.0) != 0;

        if !injected {
            let msg = wparam.0 as u32;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;

            // Double-Esc escape hatch — works even while blocking.
            if kb.vkCode == VK_ESCAPE && is_down {
                let mut last = LAST_ESC.lock().unwrap();
                let now = Instant::now();
                let double = last.map_or(false, |t| now.duration_since(t) < Duration::from_millis(600));
                if double {
                    *last = None;
                    drop(last);
                    trigger_escape();
                    return LRESULT(1); // swallow this Esc
                } else {
                    *last = Some(now);
                }
            }

            // While blocking, swallow ALL physical input.
            if BLOCK_ACTIVE.load(Ordering::SeqCst) {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = (ms.flags & LLMHF_INJECTED) != 0;
        if !injected && BLOCK_ACTIVE.load(Ordering::SeqCst) {
            return LRESULT(1); // swallow physical mouse input
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// Called from the keyboard hook when the user double-taps Esc.
fn trigger_escape() {
    BLOCK_ACTIVE.store(false, Ordering::SeqCst);
    // Cancel the running task and tell the UI.
    let _ = crate::agent::planner::cancel_task();
    if let Some(app) = APP.get() {
        let _ = app.emit("agent:killed", serde_json::json!({}));
        let _ = app.emit("takeover:ended", serde_json::json!({}));
    }
    // Stop the hook thread (uninstalls hooks).
    stop_hook_thread();
}

// ── Hook thread lifecycle ──────────────────────────────────────────────────────

fn ensure_hook_thread() {
    if THREAD_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    std::thread::spawn(|| unsafe {
        let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE::default(), 0);
        let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE::default(), 0);
        HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

        // Message loop — required for LL hooks to fire.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            // We don't dispatch; only WM_QUIT (posted by stop) ends the loop.
        }

        if let Ok(h) = kb { let _ = UnhookWindowsHookEx(h); }
        if let Ok(h) = ms { let _ = UnhookWindowsHookEx(h); }
        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        THREAD_RUNNING.store(false, Ordering::SeqCst);
    });
}

fn stop_hook_thread() {
    let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Begin takeover: install hooks (if needed) and block physical input.
pub fn start() {
    if BLOCK_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    ensure_hook_thread();
    BLOCK_ACTIVE.store(true, Ordering::SeqCst);
    if let Some(app) = APP.get() {
        let _ = app.emit("takeover:started", serde_json::json!({}));
    }
}

/// End takeover: stop blocking and uninstall hooks.
pub fn stop() {
    if !BLOCK_ACTIVE.swap(false, Ordering::SeqCst) {
        // not active; still ensure the hook thread is torn down
    }
    stop_hook_thread();
    if let Some(app) = APP.get() {
        let _ = app.emit("takeover:ended", serde_json::json!({}));
    }
}
