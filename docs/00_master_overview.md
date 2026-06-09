# Omni — Master Product Overview

## What Is Omni?

Omni is a Windows desktop AI agent that controls your computer the way a skilled human would. It lives silently in your system tray. You never think about it until you need it. When you need it, you press a hotkey, speak, release, and watch it work.

It is **not** a chatbot. It is **not** a browser extension. It is **not** an automation script. It is an AI that sees your screen, understands what is on it, decides what to do, and then actually does it — clicking, typing, opening apps, switching windows, writing code, posting content, sending emails — exactly as a person would sitting at your keyboard.

**Target Market:** Individuals and small teams who want to automate the repetitive daily computer work that takes up hours of their week.

---

## How the Core Experience Works

### Activation — Walkie-Talkie Style

The entire interaction happens in under 10 seconds for simple tasks.

1. You **hold** `Ctrl + Shift + A` (default mic hotkey — fully customizable in Settings → Hotkeys)
2. A small floating pill appears bottom-right:
   `🎤 [waveform animation] Listening...`
3. You speak:
   *"Go to LinkedIn and write a post about our new product feature. Keep it professional, around 130 words."*
4. You **RELEASE** the keys
5. The pill changes: `⟳ Thinking...`
6. Omni starts working. You watch it happen live:
   ```
   ▶ Opening Chrome...
   ▶ Navigating to LinkedIn...
   ▶ Clicking Write a post...
   ▶ Writing post content...
   ▶ (Pauses) — "Ready to post. Approve?"
   ```
7. You click **Approve** on the floating dialog
8. `✓ Post published.`
9. Pill shows success, auto-hides after 4 seconds. Dashboard logs the task automatically.

**This is the entire user experience.** No window to open. No form to fill. No buttons to click except Approve for risky actions.

---

## Hotkeys

| Action | Default | Configurable? |
|--------|---------|---------------|
| Voice Activation (Mic) | `Ctrl + Shift + A` | ✅ Settings → Hotkeys |
| Text Command Mode | `Ctrl + Shift + T` | ✅ Settings → Hotkeys |
| Emergency Kill Switch | `Esc × 2 (within 500ms)` | ❌ Hardcoded by design |

> **Why not Ctrl+Space?** Windows intercepts `Ctrl+Space` system-wide for the Chinese IME input method switcher. It cannot be overridden by desktop apps. The defaults `Ctrl+Shift+A` and `Ctrl+Shift+T` work reliably on all Windows configurations.

---

## What It Can Do

### Everyday Tasks
- Write and post on LinkedIn, Twitter/X, Instagram
- Compose and send emails via Outlook or Gmail
- Create Word documents, Excel sheets, PDF reports
- Search the web and summarize what it finds
- Schedule calendar events
- Manage files and folders on the PC
- Take screenshots and annotate them
- Copy, organize, and transform clipboard content

### Creative Work
- Open Photoshop, remove backgrounds, batch resize images
- Open Premiere Pro or DaVinci, make basic edits (cut, trim, export)
- Write captions, scripts, blog posts, ad copy from a voice prompt

### Technical Work
- Open VS Code, navigate to any file in the project
- Write functions, components, pages from description
- Run terminal commands, read the output, fix errors
- Commit and push to Git with auto-generated message
- Multi-file edits across an entire codebase

### Communication
- Send Slack messages or Teams messages
- Draft and send WhatsApp messages
- Reply to emails with AI-written responses

### Anything on Screen
If it is on the Windows screen, Omni can interact with it. Uses the full automation hierarchy:

1. **Official API** (e.g. Microsoft Graph for Outlook)
2. **COM/OLE automation** (Office apps)
3. **UIAutomation accessibility tree** (all standard Windows apps)
4. **WinRT OCR + screen coordinates** (text navigation)
5. **Vision model** — reads screenshot, identifies elements, clicks
6. **Asks user** one specific question if genuinely stuck

---

## Version Roadmap

| Version | Goal | Key Features |
|---------|------|--------------|
| **V1** | Ship a working agent | Activation, Voice, Windows control, The Hub, basic memory |
| **V2** | Full power | Deep Mem0 memory, Skills marketplace, Scheduled tasks, Razorpay billing, Wake word |
| **V3** | Platform | Multi-agent, plugin SDK, enterprise features |

---

## Performance Targets (V1)

| Metric | Target |
|--------|--------|
| App launch | < 3 seconds |
| Hotkey to mic active | < 100ms |
| Screen capture | < 50ms |
| OCR | < 500ms |
| AI planning response | < 4 seconds |
| Idle RAM | < 60MB |
| Active task RAM | < 200MB |
| Installer size | < 90MB |
