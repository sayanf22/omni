# Omni — V1 Frontend Build Steps 15–27 (UI + Auth + main.rs)

---

## STEP 15: Tailwind Config

### Colors (Dark Theme)

```js
colors: {
  bg:             "#0A0A0D",    // dark background
  surface:        "#111116",    // card backgrounds
  surface2:       "#18181F",    // nested cards
  surface3:       "#1E1E28",    // hover states
  border:         "#252532",    // card borders
  "border-light": "#30303F",    // subtle borders
  accent:         "#6366F1",    // indigo — primary CTA color
  "accent-hover": "#818CF8",
  "accent-dim":   "#312E81",    // muted accent backgrounds
  text:           "#F1F1F8",    // primary text
  "text-secondary": "#9494B8",  // secondary text
  "text-muted":   "#5C5C7A",    // muted/labels
  success:        "#34D399",    // green
  warning:        "#FBBF24",    // amber
  error:          "#F87171",    // red
  "error-dim":    "#7F1D1D",    // error backgrounds
}
```

### Other Tokens

```js
borderRadius: {
  sm: "6px",
  DEFAULT: "10px",
  md: "12px",
  lg: "16px",
  xl: "20px",
}

fontFamily: {
  sans: ["Inter", "system-ui", "sans-serif"],
}
```

**Load Inter font from Google Fonts in `index.html`.**

---

## STEP 16: App Shell

**File:** `src/App.tsx`

### Auth Flow
```
Check Supabase auth on load:
  No auth           → <LoginPage />
  Auth + no OpenAI  → <OnboardingPage />
  Ready             → <DashboardShell />
```

### DashboardShell
- Frameless window. Custom title bar (draggable region).
- Left: `<Sidebar />` (256px expanded, 64px collapsed)
- Right: `<Outlet />` (React Router page content)

### Sidebar Navigation (Lucide Icons)

| Icon | Label | Route |
|------|-------|-------|
| LayoutDashboard | Home | `/` |
| ListTodo | Activity | `/activity` |
| BarChart2 | Insights | `/insights` |
| Brain | Memory | `/memory` |
| Blocks | Skills | `/skills` |
| *(separator)* | | |
| Settings | Settings | `/settings` |
| ShieldCheck | Security | `/security` |

---

## STEP 17: Home Page

**File:** `src/pages/Home.tsx`

- Render live status banner (Idle / Thinking / Working).
- Center a quick command input bar for text commands.
- Render 4 stat cards in a responsive grid.
- Integrate the contribution activity heatmap.
- Render a short feed of the last 5 tasks with status badges.

---

## STEP 18: Activity Page

**File:** `src/pages/Activity.tsx`

- Render search input and filter buttons (All, Completed, Failed, Cancelled).
- Implement list of historical tasks retrieved via `get_recent_tasks()`.
- Clicking a task expands the row to show:
  - Timestamps, duration, model type, token usage.
  - Step-by-step history listing which tool was run, the query, the result, and a thumbnail of the screen at that moment.
- Add "Export CSV" button.

---

## STEP 19: Insights Page

**File:** `src/pages/Insights.tsx`

- Render 3 Recharts components:
  - Daily tasks run (Bar chart).
  - Time saved weekly trend (Line chart).
  - Application usage distribution (Donut chart).
- Retrieve raw data by scanning the SQLite history.

---

## STEP 20: Memory Page

**File:** `src/pages/Memory.tsx`

- Query SQLite settings and task logs to display facts Omni has learned.
- Show cards categorized into: Preferences, Style, and Project Paths.
- In V1, this page is read-only. Shows a banner: `"Memories are learned automatically. Manual editing coming in V2."`

---

## STEP 21: Skills Page

**File:** `src/pages/Skills.tsx`

- Render a grid of cards representing automated capabilities.
- Free skills are badged as `"Active"`.
- Premium skills (Photoshop, Slack, etc.) are badged as `"V2 Marketplace"`.

---

## STEP 22: Settings Page

**File:** `src/pages/Settings.tsx`

- **API Keys Form**: Renders text inputs for OpenAI, Anthropic, DeepSeek, and ElevenLabs keys. Saves to Windows Credential Manager via `save_api_key` IPC. Has a "Test Key" button that triggers a simple call to the provider.
- **Autostart**: Toggle switch to save setting for launch-on-boot.
- **Voice Configurations**: Select voice models for ElevenLabs or Windows SAPI.
- **Autostart/Startup Toggle**: Registry updater in Rust backend.

---

## STEP 23: Security Page

**File:** `src/pages/Security.tsx`

- Render a large red button: `"⬛ STOP ALL TASKS"`.
- Table showing the security audit logs (`get_audit_log`).
- Buttons to `"Clear local database"` and `"Delete all data"` (prompts the user to type "DELETE").

---

## STEP 24: Floating Overlay

**File:** `src/components/overlay/FloatingOverlay.tsx`

A tiny transparent overlay window configured in `tauri.conf.json`.
- Listens to Tauri IPC events (e.g. `hotkey:mic_start`, `task:step`, `permission:request`).
- Renders the states:
  - **Listening**: Waves animation with amber glow.
  - **Thinking**: Indigo pulsing spinner.
  - **Working**: List of active step descriptions + a stop button.
  - **Approval**: Displays high-risk actions (e.g. email draft preview or folder deletion path list) with Approve/Cancel buttons. Awaits the user's action and calls `approve_request` to resume or abort the Rust thread.
  - **Success/Error**: Flashes checkmark or X mark before auto-hiding.

---

## STEP 25: Login & Onboarding

**File:** `src/pages/Login.tsx` & `src/pages/Onboarding.tsx`

- **Login**: Auth screen with Magic Link and Google OAuth via Supabase client.
- **Onboarding**: A 4-step walkthrough for new users:
  1. *Welcome*: Brief tour of the app.
  2. *Permissions*: Guide user to grant screen/window permissions.
  3. *AI Key*: Prompt for OpenAI API key to get started.
  4. *Complete*: Quick start guide (remind user of `Ctrl + Space` hotkey).

---

## STEP 26: Supabase & Sync Clients

**Files:** `src/lib/supabase.ts` & `src/lib/sync.ts`

- Initialize Supabase client using environment variables or settings.
- Implement a background loop in Rust that runs every 5 minutes:
  - Calls `get_unsynced_tasks()` to retrieve SQLite records.
  - Upserts them into Supabase via IPC.
  - Marks those records as synced locally in SQLite using `mark_synced(id)`.

---

## STEP 27: Rust main.rs Integration

**File:** `src-tauri/src/main.rs`

The final integration file that stitches all backend modules together.
1. Initializes logging (`tracing_subscriber`).
2. Opens the local SQLite database connection.
3. Sets up the tray icon with context menu (Open Dashboard, Exit).
4. Sets up global shortcut listener (using `tauri-plugin-global-shortcut`) for `Ctrl+Space` and `Esc×2`.
5. Spawns windows (`main` and `overlay`) in a hidden state on startup.
6. Registers all Tauri IPC commands (`take_screenshot`, `run_task`, `approve_request`, etc.).
7. Enters the main loop.