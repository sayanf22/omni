# Omni — V1 Test Checklist & Installation

---

## Installation (V1)

| Spec | Target |
|------|--------|
| Format | Single `.exe` installer |
| Size | ~80MB |
| Developer tools required | **No** |
| Flow | Click → install → sign in → enter API key → use |
| Autostart | Auto-starts with Windows (toggleable) |
| Updates | Background silent updates (Tauri built-in updater) |

---

## V1 Test Checklist

### Installation & Auth
- [ ] Install runs cleanly, no errors.
- [ ] Login via magic link works.
- [ ] Login via Google OAuth works.
- [ ] Onboarding saves OpenAI key to Credential Manager.

### Hub Dashboard
- [ ] Hub shows correct layout (status banner, stats, heatmap, feed, command box).
- [ ] Hub Home shows tasks in activity feed after each run.
- [ ] Activity page shows full task with all steps expanded.
- [ ] Insights shows charts (may be mostly empty at first).
- [ ] Memory page shows learned facts (or placeholder).
- [ ] Skills page shows grid with installed/locked badges.
- [ ] Settings saves and retrieves API keys correctly (test button works).
- [ ] Security audit log shows every action.

### Agent Core
- [ ] Ctrl+Space held → overlay shows Listening.
- [ ] Speak "open notepad" → release → Notepad opens.
- [ ] Speak "type hello world in notepad" → text appears.
- [ ] Speak "go to google.com in chrome" → Chrome opens, navigates.
- [ ] Speak "delete the file test.txt from Desktop" → shows approval dialog.
- [ ] Approve → file deleted and logged.
- [ ] Cancel → nothing deleted, logged as denied.

### Safety & Control
- [ ] Esc × 2 → task stops immediately.
- [ ] Emergency stop button works.
- [ ] Permission dialog appears for all high-risk actions.
- [ ] 60-second timeout on unanswered permission → auto-deny.

### System Behavior
- [ ] App minimizes to tray on close.
- [ ] System tray icon appears with context menu (Open / Quit).
- [ ] Tasks sync to Supabase (check dashboard).

### Performance Targets
- [ ] Idle RAM: < 60MB.
- [ ] Active task RAM: < 200MB.
- [ ] App launch: < 3 seconds.
- [ ] Hotkey to microphone active: < 100ms.
- [ ] Screen capture: < 50ms.
- [ ] OCR: < 500ms.
- [ ] AI planning response: < 4 seconds.
- [ ] Installer size: < 90MB.

---

## Project Directory Tree

The following is the definitive file structure for the Omni application.

```
d:/Projects with IDE/ai/
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── src/
│   ├── main.tsx
│   ├── index.css
│   ├── App.tsx
│   ├── lib/
│   │   ├── supabase.ts
│   │   └── sync.ts
│   ├── store/
│   │   └── useAppStore.ts
│   ├── components/
│   │   ├── custom/
│   │   │   └── TitleBar.tsx
│   │   ├── dashboard/
│   │   │   └── Sidebar.tsx
│   │   └── overlay/
│   │       └── FloatingOverlay.tsx
│   └── pages/
│       ├── Home.tsx
│       ├── Activity.tsx
│       ├── Insights.tsx
│       ├── Memory.tsx
│       ├── Skills.tsx
│       ├── Settings.tsx
│       ├── Security.tsx
│       ├── Login.tsx
│       └── Onboarding.tsx
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/
    │   └── default.json
    └── src/
        ├── main.rs
        ├── commands.rs
        ├── automation/
        │   ├── mod.rs
        │   ├── screen.rs
        │   ├── ocr.rs
        │   ├── uia.rs
        │   ├── input.rs
        │   └── process.rs
        ├── storage/
        │   ├── mod.rs
        │   ├── keychain.rs
        │   └── sqlite.rs
        ├── ai/
        │   ├── mod.rs
        │   ├── router.rs
        │   └── providers/
        │       ├── mod.rs
        │       ├── openai.rs
        │       ├── claude.rs
        │       └── deepseek.rs
        ├── agent/
        │   ├── mod.rs
        │   ├── planner.rs
        │   └── hotkeys.rs
        ├── security/
        │   ├── mod.rs
        │   └── permissions.rs
        ├── voice/
        │   ├── mod.rs
        │   ├── stt.rs
        │   └── tts.rs
        └── tools/
            ├── mod.rs
            ├── mouse_tool.rs
            ├── keyboard_tool.rs
            ├── screen_tool.rs
            ├── app_tool.rs
            ├── file_tool.rs
            └── clipboard_tool.rs
```