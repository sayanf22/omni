# Omni — The Hub Dashboard (Complete Specification)

The Hub is the command center. Inspired by how Wispr Flow built their hub — a warm, data-rich home base that shows everything useful at a glance.

It is **NOT** a settings page. It is **NOT** a list of options. It is a living dashboard that shows what the agent has been doing, what it knows about you, what skills it has, and how much work it has saved you.

---

## Hub Layout

```
┌──────────────────────────────────────────────────────────────┐
│  ◉ Omni Dashboard                         [─] [□] [✕]        │
├──────────────────────┬───────────────────────────────────────┤
│  [Left sidebar]      │  [Main content]                       │
│                      │                                       │
│  ● Home              │   Active page renders here            │
│  ○ Activity          │                                       │
│  ○ Insights          │                                       │
│  ○ Memory            │                                       │
│  ○ Skills            │                                       │
│  ──────────────────  │                                       │
│  ○ Settings          │                                       │
│  ○ Security          │                                       │
│                      │                                       │
│  [User Profile]      │                                       │
└──────────────────────┴───────────────────────────────────────┘
```

**Sidebar:**
- 256px expanded, 64px collapsed.
- Lucide icons for each navigation item.
- Active item: 3px accent left border + `surface2` background.
- Uses Framer Motion for smooth hover and active state transitions.

---

## 1. Home Page

The Hub Home shows everything happening right now and summarizes your usage.

### A. Status Banner
- **Idle State**: Sleek dark card: `"Omni is ready. Hold Ctrl+Shift+A to speak (default hotkey)."`
- **Working State**: Pulse animated indigo border: `"Executing task: Write a LinkedIn post..."` with a live step count and estimated progress.

### B. Quick Command Box
- A centered textarea: `"Type a command here (or hold Ctrl+Shift+A to speak)..."`
- Allows typing instructions directly instead of speaking. Pressing Enter starts the ReAct loop.

### C. Stat Cards (4 Grid Layout)
1. **Tasks Executed**: Total count of completed tasks.
2. **Time Saved**: Total duration saved (tasks count × 2.5 minutes).
3. **Success Rate**: Percentage of tasks completed successfully without errors or cancellation.
4. **Active Provider**: Display name + model of the currently routed AI provider.

### D. Activity Heatmap
- A 14-day grid showing task volume per day.
- Shaded cells from dark (0 tasks) to bright accent (10+ tasks).

### E. Recent Activity Feed
- List of the 5 most recent tasks.
- Shows task description, execution status badge, and timestamp.

---

## 2. Activity Page

A full historical log of every task executed by Omni.

- **Search Bar**: Filter tasks by word matching in their description.
- **Status Filter**: Tabs for `All`, `Completed`, `Failed`, `Cancelled`.
- **Export Button**: Exports the full task history as a CSV file.
- **Expandable Rows**: Clicking any task expands it to reveal step-by-step audit with tool calls and outcomes.

---

## 3. Insights Page

Recharts-driven data visualizations showing **real task data only** — no mock values.

- **Daily Task Volume**: Bar chart of tasks run per day (last 7 days).
- **Productivity Trend**: Line chart of cumulative minutes saved (2.5 min per completed task).
- **Tool Execution Share**: Donut chart showing which tools (mouse, keyboard, screen, etc.) were used in real task steps.
- **Stat Cards**: Real average steps per task, total task count, real success rate.

---

## 4. Memory Page

Shows the user facts Omni has learned and stored via Mem0.

- **Add Custom Fact**: Text area to manually inject a new memory (e.g. "User prefers PowerShell over CMD").
- **Semantic Search**: Search memories with natural language.
- **Memory Cards**: List of all cognitive records — each has a delete button.
- Requires Mem0 Cloud API key OR local self-hosted Mem0 server to be running.

---

## 5. Skills Page

Grid of skills demonstrating what Omni is capable of automating.

- **V1 Skills** (Active): Mouse/Click, Keyboard, OCR/Screen, FileSystem, Clipboard, Browser.
- **V2 Skills** (Marketplace): Slack/Teams, Creative Suite (Photoshop, DaVinci).

---

## 6. Settings Page

Configure AI models, API keys, hotkeys, and app behavior.

### Model Registry
- Add/remove/test AI models (OpenAI, Anthropic, DeepSeek, OpenRouter, Custom endpoint).
- Each model can be assigned Vision / Coding / Writing roles.
- API keys stored securely in Windows Credential Manager (DPAPI).

### Global Hotkeys
- **Voice Activation (Mic)**: Default `Ctrl+Shift+A` — hold to speak, release to send.
- **Text Command Mode**: Default `Ctrl+Shift+T` — opens dashboard to type.
- **Kill Switch**: `Esc × 2` — hardcoded, not configurable.
- All hotkeys can be changed via the "Record" button: click Record, press your desired combo, it saves live.
- Reset to default button available for each hotkey.

> **Note on hotkey conflicts**: `Ctrl+Space` is intercepted by Windows globally for IME switching. Avoid using it. The defaults (`Ctrl+Shift+A` / `Ctrl+Shift+T`) work on all Windows configurations.

### System Integrations
- **ElevenLabs Key**: For Scribe v2 STT and TTS. Falls back to Windows SAPI if not set.
- **Mem0 Config**: Cloud API key or self-hosted URL for cognitive memory.

### Interface
- Dark/Light theme toggle.

---

## 7. Security Page

Operational controls and raw audit logs.

- **Emergency Stop**: Large red button: `"STOP ALL RUNNING TASKS"` to kill all active operations immediately.
- **Audit Table**: Columns for `Time`, `Action Type`, `Tool`, `Outcome`. Shows the last 50 entries.
- **Data Privacy Panel**:
  - **Clear Task Logs**: Removes all tasks from local SQLite.
  - **Delete All Data**: Full wipe of SQLite + all DPAPI keys. Requires typing `"DELETE"` to confirm.
