# Omni — Complete Tech Stack

> One choice per layer. No alternatives. No debates.

## Stack Table

| Layer | Choice | Why |
|-------|--------|-----|
| App framework | **Tauri v2.10.x** | Rust backend, 6MB installer, ~50MB idle RAM |
| UI | **React 18 + TypeScript** | Mature, large ecosystem |
| Styling | **Tailwind CSS + shadcn/ui** | Fast, accessible, consistent |
| Animations | **Framer Motion** | Production-grade micro-interactions |
| State | **Zustand** | Lightweight, no boilerplate |
| Automation | **Rust + windows-rs** | Direct Win32/UIAutomation/COM access |
| Screen capture | **DXGI (windows-capture crate)** | GPU-accelerated, <50ms |
| OCR | **Windows WinRT OCR** | Free, offline, built into Windows |
| Input sim | **enigo crate** | Battle-tested, cross-platform |
| AI primary | **GPT-4o mini (OpenAI)** | Cheap, vision, trusted |
| AI coding | **Claude Haiku 4.5** | Best computer use scores |
| AI writing | **DeepSeek V4 Flash** | Cheapest for text |
| STT | **ElevenLabs Scribe v2** | 150ms latency, 90+ languages |
| TTS | **ElevenLabs TTS** | Natural voice |
| STT fallback | **Windows SAPI** | Free, built-in, offline |
| TTS fallback | **Windows SAPI** | Free, built-in, offline |
| Memory | **Mem0 + Supabase pgvector** | 90% token savings |
| Local DB | **SQLite (rusqlite)** | Zero config, reliable |
| Cloud DB | **Supabase (postgres)** | Auth + sync + vector search |
| Payments (V2) | **Razorpay** | India-native, Supabase-compatible |
| Installer | **NSIS via Tauri bundler** | Standard Windows installer |
| Updates | **Tauri built-in updater** | Silent, background |

---

## Absolute Rules

- **Rust** for all automation, OS interaction, AI calls, voice handling
- **React/TypeScript** for all UI
- **No Python** anywhere
- **No Electron**
- **No local LLM**
- API keys go in **Windows Credential Manager ONLY** — never files, env vars, or SQLite
- No payment code in V1 — Supabase schema already has Razorpay fields (NULL)
- AI models: GPT-4o mini (primary), Claude Haiku 4.5 (coding), DeepSeek V4 Flash (text)
- **NOT Gemini. Never Gemini.**

---

## Dependency Setup (Build Prerequisites)

### 1. Visual Studio Build Tools 2022
- URL: https://aka.ms/vs/17/release/vs_BuildTools.exe
- Select: **Desktop development with C++**
- Ensure: MSVC v143, Windows 11 SDK (10.0.22621+)
- Restart PC after install

### 2. Rust via rustup
- URL: https://rustup.rs
- Run: `rustup default stable-x86_64-pc-windows-msvc`

### 3. Node.js 22 LTS
- URL: https://nodejs.org

### 4. Tauri CLI
```bash
npm install -g @tauri-apps/cli@latest
npx tauri --version  # should show 2.10.x
```

### 5. Create Project
```bash
npm create tauri-app@latest omni -- --template react-ts
cd omni
npm install
```

### 6. Frontend Dependencies
```bash
npm install @tauri-apps/api
npm install @tauri-apps/plugin-global-shortcut
npm install @tauri-apps/plugin-shell @tauri-apps/plugin-process
npm install @tauri-apps/plugin-store @tauri-apps/plugin-notification
npm install @tauri-apps/plugin-window-state
npm install tailwindcss @tailwindcss/forms postcss autoprefixer
npx tailwindcss init -p
npm install @radix-ui/react-dialog @radix-ui/react-tabs @radix-ui/react-tooltip
npm install @radix-ui/react-switch @radix-ui/react-scroll-area
npm install class-variance-authority clsx tailwind-merge
npm install lucide-react framer-motion zustand
npm install @supabase/supabase-js
npm install react-hook-form zod @hookform/resolvers
npm install recharts date-fns immer
```

### 7. Rust Dependencies (src-tauri/Cargo.toml)

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-shell = "2"
tauri-plugin-process = "2"
tauri-plugin-store = "2"
tauri-plugin-notification = "2"
tauri-plugin-window-state = "2"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json", "stream", "multipart"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
image = { version = "0.25", features = ["jpeg", "png"] }
base64 = "0.22"
toml = "0.8"
dirs = "5"
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
sysinfo = "0.30"
rodio = "0.19"
tokio-tungstenite = { version = "0.21", features = ["native-tls"] }
async-trait = "0.1"
sha2 = "0.10"

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.58", features = [
  "Win32_Foundation",
  "Win32_UI_Accessibility",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_WindowsAndMessaging",
  "Win32_System_Com",
  "Win32_Graphics_Gdi",
  "Win32_Storage_FileSystem",
  "Win32_System_Registry",
  "Win32_Security_Credentials",
  "Win32_System_Threading",
  "Win32_System_ProcessStatus",
  "Foundation",
  "Media_Ocr",
  "Globalization",
  "Graphics_Imaging",
  "Storage_Streams",
]}
windows-capture = "1.4"
uiautomation = "0.5"
enigo = { version = "0.2", features = ["serde"] }
```