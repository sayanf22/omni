# Omni — V1 Rust Build Steps 1–7 (OS Layer + Storage)

All Rust code lives in `src-tauri/src/`. This document covers Steps 1–7: the foundational OS automation and local storage layer.

---

## STEP 1: Screen Capture

**File:** `src-tauri/src/automation/screen.rs`

**Crate:** `windows-capture` (Windows Graphics Capture API, GPU-accelerated)

### Functions

```rust
/// Captures full screen, encodes as JPEG 85%, returns base64 string.
/// Target: <50ms. Never write to disk.
pub fn capture_full_screen() -> anyhow::Result<String>

/// Same but for a specific region.
pub fn capture_region(x: i32, y: i32, w: u32, h: u32) -> anyhow::Result<String>

/// Tauri IPC wrapper
#[tauri::command]
fn take_screenshot() -> Result<String, String>
```

### DPI Handling
- All coords use **physical pixels**
- Use `GetDpiForSystem()` for scaling
- Formula: `physical = logical × (dpi / 96.0)`

---

## STEP 2: WinRT OCR

**File:** `src-tauri/src/automation/ocr.rs`

**Tech:** Windows WinRT OCR via `windows-rs`. **FREE. OFFLINE. No API needed.**

### Functions

```rust
/// Converts JPEG bytes → Windows SoftwareBitmap → OcrEngine → returns text string.
pub fn ocr_image_bytes(jpeg_bytes: &[u8]) -> anyhow::Result<String>

/// Captures screen then OCRs it.
pub fn ocr_screen() -> anyhow::Result<String>

/// OCR with bounding boxes. Find text (partial match). Return center coords.
pub fn ocr_find_text_coords(text: &str) -> anyhow::Result<Option<(i32, i32)>>
```

All functions have `#[tauri::command]` wrappers.

---

## STEP 3: UIAutomation

**File:** `src-tauri/src/automation/uia.rs`

**Crate:** `uiautomation`

### Functions

```rust
pub fn get_focused_window_name() -> String

/// JSON: {name, control_type, bounding_rect:{x,y,w,h}, value, children[]}
/// Max 4 levels deep.
pub fn get_ui_tree_json() -> anyhow::Result<serde_json::Value>

pub fn find_element(search_text: &str) -> anyhow::Result<Option<ElementInfo>>

/// Prefer UIAutomation InvokePattern, fall back to mouse click.
pub fn click_element_by_name(name: &str) -> anyhow::Result<()>
```

### Struct

```rust
struct ElementInfo {
    name: String,
    control_type: String,
    rect: Rect,
    value: String,
}
```

---

## STEP 4: Input Simulation

**File:** `src-tauri/src/automation/input.rs`

**Crate:** `enigo`

### Functions

```rust
pub fn mouse_click(x: i32, y: i32) -> anyhow::Result<()>
pub fn mouse_right_click(x: i32, y: i32) -> anyhow::Result<()>
pub fn mouse_double_click(x: i32, y: i32) -> anyhow::Result<()>
pub fn mouse_move_to(x: i32, y: i32) -> anyhow::Result<()>
pub fn mouse_scroll(x: i32, y: i32, dir: &str, amount: i32) -> anyhow::Result<()>

/// If text >100 chars: use clipboard paste (set clipboard → Ctrl+V).
/// Short text: type directly.
pub fn type_text(text: &str) -> anyhow::Result<()>

/// Accepts: enter, escape, tab, backspace, delete, up, down, left, right,
///          home, end, f1-f12, space, pageup, pagedown
pub fn press_key(key: &str) -> anyhow::Result<()>

/// ["ctrl","c"] → hold Ctrl, press C, release all.
/// Modifiers: ctrl, alt, shift, win
pub fn press_hotkey(keys: Vec<String>) -> anyhow::Result<()>
```

All coords: convert logical → physical via DPI scale.

---

## STEP 5: Process Manager

**File:** `src-tauri/src/automation/process.rs`

### Functions

```rust
/// EnumWindows + GetWindowText. Visible, titled windows only.
pub fn list_running_apps() -> Vec<AppInfo>

/// Search: Start Menu shell:AppsFolder → Program Files → Desktop shortcuts
pub fn launch_app(name: &str) -> anyhow::Result<u32>

/// SetForegroundWindow + ShowWindow(SW_RESTORE if minimized)
pub fn focus_window_by_name(name: &str) -> anyhow::Result<()>

pub fn get_active_window() -> AppInfo

pub fn is_app_running(name: &str) -> bool
```

### Struct

```rust
struct AppInfo {
    name: String,
    hwnd: isize,
    pid: u32,
    exe_name: String,
}
```

---

## STEP 6: Credential Manager

**File:** `src-tauri/src/storage/keychain.rs`

**Tech:** Windows Credential Manager via `windows-rs` (DPAPI encrypted)

### Functions

```rust
/// Target: "Omni/{name}" with CRED_TYPE_GENERIC + CredWriteW
pub fn store_key(name: &str, value: &str) -> anyhow::Result<()>

/// CredReadW → UTF-8 string
pub fn get_key(name: &str) -> anyhow::Result<Option<String>>

pub fn delete_key(name: &str) -> anyhow::Result<()>

pub fn has_key(name: &str) -> bool
```

### Keys stored
- `openai_api_key`
- `anthropic_api_key`
- `elevenlabs_api_key`
- `deepseek_api_key`
- `supabase_user_token`

**NEVER log key values. On error: return generic message only.**

All functions have `#[tauri::command]` wrappers.

---

## STEP 7: SQLite

**File:** `src-tauri/src/storage/sqlite.rs`

**Path:** `%APPDATA%\Omni\local.db`

### Schema

```sql
CREATE TABLE local_tasks (
    id TEXT PRIMARY KEY,
    description TEXT,
    status TEXT,
    steps_json TEXT,
    outcome TEXT,
    created_at TEXT,
    synced_at TEXT
);

CREATE TABLE local_audit (
    id TEXT PRIMARY KEY,
    action_type TEXT,
    tool_name TEXT,
    app_name TEXT,
    outcome TEXT,
    created_at TEXT
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
);
```

### Functions

```rust
pub fn save_task(task: &Task) -> anyhow::Result<()>
pub fn get_recent_tasks(limit: i32) -> anyhow::Result<Vec<Task>>
pub fn get_unsynced_tasks() -> anyhow::Result<Vec<Task>>
pub fn mark_synced(task_id: &str) -> anyhow::Result<()>
pub fn save_audit(entry: &AuditEntry) -> anyhow::Result<()>
pub fn get_audit_log(limit: i32) -> anyhow::Result<Vec<AuditEntry>>
pub fn set_setting(key: &str, value: &str) -> anyhow::Result<()>
pub fn get_setting(key: &str) -> anyhow::Result<Option<String>>
pub fn clear_all_data() -> anyhow::Result<()>
```

All functions have `#[tauri::command]` wrappers.