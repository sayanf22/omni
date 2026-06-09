# Omni — V2 Features (Complete Specification)

**Goal:** Deep memory, Skills marketplace, Advanced analytics, Background scheduling, and Razorpay Billing.

> V1 must be fully working and tested before starting V2.

---

## V2-1: Full Mem0 Memory System

- Mem0 open source integrated with Supabase pgvector backend.
- All three memory tiers fully active.
- Before every task: **top 5 relevant memories** injected automatically.
- After every task: new user facts extracted and saved by AI.
- Memory page: fully interactive — **view, edit, delete** any stored fact.
- Semantic search: `"Show me memories about LinkedIn"`.
- Cross-device sync when user has multiple PCs.

### Implementation
- Mem0 Cloud API or self-hosted Mem0 OSS with Supabase pgvector.
- Rust wrapper calls Mem0 API for add/search/delete.
- Frontend Memory page upgraded with edit/delete buttons.

---

## V2-2: Skills Marketplace

### Built-in Free Skills (active in V2)

| Skill | Description |
|-------|-------------|
| Social Media | LinkedIn, Twitter/X, Instagram |
| Documents | Word, PDF, Excel creation and editing |
| Calendar | Outlook + Google Calendar |
| Screenshots | Capture, annotate, save/share |
| Clipboard Manager | History with semantic search |
| Advanced Browser | Web research, data extraction, multi-tab workflows |

### Premium Skills (paid, in-app purchase)

| Skill | Description |
|-------|-------------|
| Photoshop | Background removal, batch resize, filters |
| Video Editing | Premiere Pro / DaVinci basic automation |
| CRM | Notion, Airtable, HubSpot |
| Messaging | Slack, Teams, WhatsApp |
| Invoice | Create, send, track |

### Implementation
- Skills page: real install/uninstall functionality.
- Each skill = a module with its own tools registered in the orchestrator.
- Enable/disable toggle per skill.

---

## V2-3: Advanced VS Code Coding

- Reads full project file tree before acting.
- Multi-file edits in one task.
- Run terminal commands, read output, fix errors automatically.
- Git: stage, commit with auto-generated message, push.
- Create new components/pages from description.
- Fix TypeScript/Python/linting errors end-to-end.

---

## V2-4: Background Task Scheduler

- Support for recurring tasks (e.g. `"Run this every Monday at 9am"`).
- Uses Tokio background scheduler.
- Queue multiple tasks to run sequentially.
- Scheduled tasks shown in Hub Home as upcoming items.
- Enable/disable schedules from Activity/Home page.

---

## V2-5: Wake Word (Offline, Opt-in)

- Say `"Omni"` without pressing keys to trigger walkie-talkie mode.
- Uses `whisper.cpp` tiny model running locally on the CPU (no API cost, offline).
- User explicitly enables this from Settings with a clear privacy notice.
- Microphone is active only for local wake word detection until triggered.

---

## V2-6: Plans & Billing — Razorpay

- **Free Tier**: 50 tasks/month.
- **Pro Tier (₹999/month)**: unlimited tasks + all free skills.
- **Pro+ Tier (₹1999/month)**: unlimited + all premium skills.
- Razorpay Subscriptions handled via Supabase Edge Function webhooks.
- Plan status stored in `subscriptions` table.
- Task counter tracked in SQLite and validated against Supabase database, displaying upgrade modal on limit.

---

## V2-7: Voice Upgrades

- **Conversational Mode**: stay in voice conversation after task completes for follow-up questions.
- **Interrupt mid-task**: say "stop" or "cancel" to trigger immediate kill switch.
- **Multi-language**: ElevenLabs auto-detects user's spoken language.
- **Voice cloning**: user sets their preferred ElevenLabs voice ID or custom cloned voice.