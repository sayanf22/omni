# Omni — Windows Desktop AI Agent

Omni is a Windows desktop AI agent that controls your computer like a human operator. It lives in your system tray. You hold a hotkey, speak, release, and watch it execute — clicking, typing, navigating, writing code, posting content, sending emails — all on screen in real time.

**Not a chatbot. Not a browser extension. A real computer-use agent.**

---

## Quick Start

### Prerequisites
- Windows 10/11 (64-bit)
- [Rust + MSVC toolchain](https://rustup.rs)
- [Node.js 22 LTS](https://nodejs.org)
- [Visual Studio Build Tools 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe) with "Desktop development with C++"

### Install & Run
```bash
git clone https://github.com/sayanf22/omni.git
cd omni
npm install
npm run tauri dev
```

### Build for Production
```bash
npm run tauri build
```

---

## Hotkeys

| Action | Default | Customizable? |
|--------|---------|---------------|
| **Voice Activation** (hold to speak, release to send) | `Ctrl + Shift + A` | ✅ Settings → Hotkeys |
| **Text Command Mode** (type instead of speak) | `Ctrl + Shift + T` | ✅ Settings → Hotkeys |
| **Emergency Kill Switch** (stops everything) | `Esc × 2` within 500ms | ❌ Fixed by design |

> `Ctrl+Space` is **not used** — Windows intercepts it globally for IME switching and it cannot be overridden by desktop apps.

**Changing hotkeys:** Go to Settings → Global Hotkeys → click "Record" → press your desired key combo → it saves and activates instantly.

---

## APIs Required

| API | Required? | Purpose |
|-----|-----------|---------|
| **OpenAI API Key** | ✅ Required | Core agent vision + reasoning (GPT-4o mini) |
| **ElevenLabs API Key** | Optional | Scribe v2 STT (150ms) + natural TTS. Falls back to Windows SAPI if not set. |
| **Anthropic API Key** | Optional | Claude for coding tasks |
| **DeepSeek API Key** | Optional | Cheaper writing/text tasks |
| **Mem0 API Key** | Optional | Cloud cognitive memory. Local self-hosted mode works without it. |

Enter your OpenAI key in the Onboarding wizard on first launch. Everything else can be configured later in Settings.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| App shell | Tauri v2 + Rust |
| UI | React 18 + TypeScript + Tailwind CSS |
| Screen capture | DXGI (`windows-capture` crate) — GPU-accelerated, <50ms |
| OCR | Windows WinRT OcrEngine — free, offline |
| Input simulation | `enigo` crate — mouse + keyboard |
| UI accessibility | `uiautomation` crate — Win32 accessibility tree |
| AI models | GPT-4o mini (vision), Claude Haiku 4.5 (coding), DeepSeek V4 Flash (writing) |
| Voice STT | ElevenLabs Scribe v2 → Windows SAPI fallback |
| Voice TTS | ElevenLabs TTS → Windows SAPI fallback |
| Memory | Mem0 Cloud API or self-hosted OSS + Supabase pgvector |
| Local DB | SQLite (`rusqlite`) |
| Cloud DB | Supabase (auth + task sync + vector memory) |
| Key storage | Windows Credential Manager (DPAPI) |

---

## Architecture

```
User speaks → Alt held → MCI records audio
             ↓ released
         ElevenLabs Scribe v2 STT (or Windows SAPI)
             ↓
         voice:transcript event → FloatingOverlay → run_task()
             ↓
         ReAct Loop (up to 20 steps):
           screenshot → AI decides → tool call → observe → repeat
             ↓
         Permission gate for high-risk actions (file delete, post, etc.)
             ↓
         task:done → Mem0 saves outcome → SQLite → Supabase sync
```

---

## Features

### V1 (Current)
- ✅ Global hotkeys with full runtime configurability
- ✅ Walkie-talkie voice activation (ElevenLabs Scribe v2 / SAPI fallback)
- ✅ ReAct agent loop with 20-step limit
- ✅ 6 automation tools: mouse, keyboard, screen, app, file, clipboard
- ✅ Permission gates for all destructive actions
- ✅ Esc × 2 kill switch
- ✅ Hub dashboard: Home, Activity, Insights, Memory, Skills, Settings, Security
- ✅ Supabase auth (email/password + magic link)
- ✅ SQLite local storage + Supabase cloud sync
- ✅ Windows DPAPI key storage
- ✅ Mem0 memory integration (Cloud + self-hosted)
- ✅ Multi-provider AI routing (OpenAI, Anthropic, DeepSeek, OpenRouter, Custom)

### V2 (Planned)
- Full Mem0 + pgvector semantic memory
- Skills marketplace (LinkedIn, Calendar, Photoshop, etc.)
- Background task scheduler
- Wake word (`whisper.cpp` offline)
- Razorpay billing (Free / Pro ₹999 / Pro+ ₹1999)

---

## Security

- All API keys stored exclusively in Windows Credential Manager (DPAPI encrypted)
- Keys never written to files, environment variables, or any database
- Screen content never sent to Omni servers — goes only to your own AI provider
- Row Level Security on all Supabase tables
- Permission dialog + preview for every destructive action
- Full audit log with CSV export

---

## License

MIT
