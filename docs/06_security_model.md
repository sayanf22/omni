# Omni — Security Model (Complete Specification)

---

## API Key Security

| Rule | Detail |
|------|--------|
| Storage | **Windows Credential Manager** (DPAPI encrypted) |
| Never in | Files, environment variables, SQLite, or database |
| Logging | **NEVER** log key values. On error: return generic message only |
| Transmission | Keys go directly to the AI provider the user chose with their own key |
| Screen content | **Never** sent to Omni servers. Goes only to the AI provider |

---

## Permission Gates

Every high-risk action requires explicit user approval before execution:

| Action | Gate |
|--------|------|
| Delete files | Shows file list, asks confirm |
| Send email | Shows preview, asks confirm |
| Post publicly | Shows content, asks confirm |
| Financial action | Requires typed **"CONFIRM"** |
| Unclear instruction | Asks one specific question |

### Implementation
- Uses `tokio::sync::oneshot` channels to pause execution
- Emit `permission:request` to frontend → await response
- Timeout: 60 seconds → auto-deny
- File: `src-tauri/src/security/permissions.rs`

---

## Kill Switch

**Esc × 2** (within 500ms) → cancels everything immediately.

- Not changeable by the user
- Stops all running tasks
- Emits `agent:killed` event
- Logs the interruption to audit

---

## Data Privacy

| Data Type | Where |
|-----------|-------|
| Task data | Stored locally in SQLite + optionally synced to Supabase (user's account) |
| Screen content | Never leaves the machine except to the AI provider |
| User facts/memories | Supabase (user's own account) |
| API keys | Windows Credential Manager only |

**Guarantees:**
- No ads
- No tracking
- No data sold. Ever.

---

## Audit & Control (Security Page)

### Emergency Stop
- Large red button: **"⬛ STOP ALL TASKS"**
- Stops everything immediately, logs the interruption

### Audit Log
- Full table: Time | Action | App/Tool | Result
- Last 200 entries, searchable
- **[Export CSV]** button
- Color-coded: green = success, red = failed/denied, grey = cancelled

### Privacy Controls
- **[Clear task history]** — clears all tasks from local + Supabase
- **[Delete all my data]** — full wipe, requires typing "DELETE"
- Both: confirmation dialogs