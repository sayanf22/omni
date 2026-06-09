# Omni — V1 Rust Build Steps 8–14 (AI Brain + Security + Voice + IPC)

---

## STEP 8: AI Provider Clients + Router

**Files:** `src-tauri/src/ai/mod.rs`, `src-tauri/src/ai/client.rs`

### Task Type Detection
```rust
pub fn detect_task_type(instruction: &str) -> TaskType
// coding keywords → TaskType::Coding
// writing keywords → TaskType::Writing
// default          → TaskType::Vision
```

### Supported Providers
| Provider | Base URL | Notes |
|----------|----------|-------|
| openai | `https://api.openai.com/v1` | Default vision model |
| anthropic | `https://api.anthropic.com/v1` | Uses `x-api-key` header, separate system prompt |
| openrouter | `https://openrouter.ai/api/v1` | Adds app headers |
| deepseek | `https://api.deepseek.com/v1` | OpenAI-compatible |
| custom | user-supplied URL | Any OpenAI-compatible endpoint |

### Rate Limiter
- Token bucket: 15 burst, 0.1 refill/sec (configurable via SQLite settings)
- Keys: `rate_limit_max`, `rate_limit_refill`

---

## STEP 9: ReAct Agent Planner

**File:** `src-tauri/src/agent/planner.rs`

```rust
#[tauri::command]
pub async fn run_task(instruction: String, user_id: String, app: tauri::AppHandle) -> Result<String, String>

#[tauri::command]
pub fn cancel_task() -> Result<(), String>
```

### Loop Flow
1. Take screenshot
2. Call AI with system prompt + memories + screenshot
3. Parse JSON response:
   - `{"done": true, "result": "..."}` → finish
   - `{"question": "..."}` → permission gate (approval required)
   - `{"thought": "...", "tool": "name", "params": {...}}` → execute tool
4. High-risk tools (delete, etc.) → permission gate before execution
5. Append result to message history
6. Repeat up to 20 steps

### Events emitted via `app.emit()` (broadcasts to ALL windows)
| Event | Payload |
|-------|---------|
| `task:started` | `{ task_id, instruction }` |
| `task:step` | `{ step_num, thought, tool, description, success }` |
| `task:done` | `{ task_id, result }` |
| `task:failed` | `{ task_id, error, step_num }` |
| `task:killed` | `{}` |
| `permission:request` | `{ id, tool, action, description, preview }` |

---

## STEP 10: Tools

**File:** `src-tauri/src/tools/`

| Tool | Actions | Risk |
|------|---------|------|
| `mouse` | click, right_click, double_click, move, scroll | Low |
| `keyboard` | type, key, hotkey | Low |
| `screen` | screenshot, ocr, find_text, ui_tree | ReadOnly |
| `app` | open, close, focus, list | Low |
| `file` | read, write, create_folder, move, delete, search, list | delete=High |
| `clipboard` | read, write | Low |

---

## STEP 11: Permission Gate

**File:** `src-tauri/src/security/permissions.rs`

```rust
pub async fn request_approval(&self, request: PendingApproval, app: &AppHandle) -> bool
```

- Shows overlay window before emitting
- `app.emit("permission:request", ...)` broadcasts to ALL windows (main + overlay)
- 60-second auto-deny timeout
- `approve_request(id, approved)` Tauri command resolves the oneshot channel

---

## STEP 12: Global Hotkeys

**File:** `src-tauri/src/agent/hotkeys.rs`

### Default Hotkeys
| Action | Default | Configurable |
|--------|---------|-------------|
| Voice Mic | `Ctrl+Shift+A` | ✅ via `set_hotkey` command |
| Text Mode | `Ctrl+Shift+T` | ✅ via `set_hotkey` command |
| Kill Switch | `Esc × 2` | ❌ hardcoded |

### Why not Ctrl+Space?
Windows globally intercepts `Ctrl+Space` for Chinese IME switching. It cannot be overridden by any user-space application on Windows 10/11.

### Tauri Commands
```rust
#[tauri::command]
pub fn set_hotkey(app: AppHandle, hotkey_type: String, hotkey_value: String) -> Result<(), String>
// hotkey_type: "mic" | "text"
// hotkey_value: e.g. "Ctrl+Shift+A", "Alt+F9", "Ctrl+Shift+Space"
// Validates → persists to SQLite → re-registers all shortcuts live

#[tauri::command]
pub fn get_hotkeys() -> Result<serde_json::Value, String>
// Returns: { mic: "Ctrl+Shift+A", text: "Ctrl+Shift+T", kill: "Esc × 2 (hardcoded)" }
```

### Hotkey String Format
`"Modifier1+Modifier2+Key"` — e.g. `"Ctrl+Shift+A"`, `"Alt+F9"`, `"Ctrl+Alt+Space"`
Supported modifiers: `Ctrl`, `Shift`, `Alt`, `Win`
Supported keys: A-Z, 0-9, F1-F12, Space, Tab, Enter, Backspace, Delete, Home, End, PageUp, PageDown, Up, Down, Left, Right, Insert, Escape

### Walkie-Talkie Flow
- **Press**: `start_mic_recording()` called directly in Rust + `hotkey:mic_start` emitted + overlay shown
- **Release**: `stop_mic_recording()` → ElevenLabs Scribe v2 or Windows SAPI → `voice:transcript` emitted
- Frontend catches `voice:transcript` → calls `run_task` automatically

---

## STEP 13: Voice STT + TTS

**Files:** `src-tauri/src/voice/stt.rs`, `src-tauri/src/voice/tts.rs`

### STT Flow
1. Record via Windows MCI (PowerShell `mciSendString`) to `%TEMP%\omni_input.wav`
2. If ElevenLabs key present → POST to `https://api.elevenlabs.io/v1/speech-to-text` (model: `scribe_v2`)
3. Fallback → Windows SAPI `SpeechRecognitionEngine` (offline, free)

### TTS Flow
1. If ElevenLabs key present → `eleven_turbo_v2_5` model, Rachel voice by default
2. Audio bytes played via `rodio` in a background thread
3. Fallback → Windows SAPI `SpeechSynthesizer` (offline, free)

---

## STEP 14: Tauri IPC Command Registration

**File:** `src-tauri/src/lib.rs`

All commands registered in `tauri::generate_handler![...]`:

**Automation**: `take_screenshot`, `ocr_screen`, `find_text_on_screen`, `get_ui_tree`, `mouse_click`, `type_text`, `press_key`, `press_hotkey`, `launch_app`, `focus_window`, `list_running_apps`

**Storage**: `save_api_key`, `get_api_key`, `has_api_key`, `delete_api_key`, `get_recent_tasks`, `get_audit_log`, `save_setting`, `get_setting`, `clear_all_local_data`, `save_custom_model`, `delete_custom_model`, `get_custom_models`, `get_active_model_for_role`, `get_unsynced_local_tasks`, `mark_task_synced_local`, `get_unsynced_local_audit`, `mark_audit_synced_local`

**Agent**: `run_task`, `cancel_task`, `approve_request`

**AI**: `test_model_connection`

**Voice**: `trigger_mic_start`, `trigger_mic_stop`, `trigger_tts_speak`

**Memory**: `get_all_memories`, `delete_memory_item`, `search_memory_items`, `add_custom_memory_item`, `get_sidecar_status`

**Hotkeys**: `set_hotkey`, `get_hotkeys`

**Auth/Sync**: `supabase_login`, `supabase_signup`, `supabase_login_with_otp`, `get_supabase_session`, `supabase_logout`, `sync_local_to_cloud`
