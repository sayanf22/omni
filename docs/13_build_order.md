# Omni — Build Order Summary

This document provides the definitive order of execution for building Omni V1. Each step maps to a detailed specification in the corresponding doc file.

---

## Phase 1: Rust Core — OS Automation (Steps 1–5)

| Step | File | What | Doc |
|------|------|------|-----|
| 1 | `automation/screen.rs` | Screen capture (DXGI, GPU-accel, <50ms) | `07_v1_rust_steps_1_to_7.md` |
| 2 | `automation/ocr.rs` | WinRT OCR (free, offline) | `07_v1_rust_steps_1_to_7.md` |
| 3 | `automation/uia.rs` | UIAutomation (accessibility tree) | `07_v1_rust_steps_1_to_7.md` |
| 4 | `automation/input.rs` | Input simulation (mouse + keyboard via enigo) | `07_v1_rust_steps_1_to_7.md` |
| 5 | `automation/process.rs` | Process/window management (Win32) | `07_v1_rust_steps_1_to_7.md` |

## Phase 2: Rust Core — Storage (Steps 6–7)

| Step | File | What | Doc |
|------|------|------|-----|
| 6 | `storage/keychain.rs` | Windows Credential Manager (DPAPI) | `07_v1_rust_steps_1_to_7.md` |
| 7 | `storage/sqlite.rs` | Local SQLite DB | `07_v1_rust_steps_1_to_7.md` |

## Phase 3: Rust Core — AI Brain (Steps 8–10)

| Step | File | What | Doc |
|------|------|------|-----|
| 8 | `ai/providers/*.rs` + `ai/router.rs` | AI provider clients + auto-routing | `08_v1_rust_steps_8_to_14.md` |
| 9 | `agent/planner.rs` | ReAct orchestrator (20-step loop) | `08_v1_rust_steps_8_to_14.md` |
| 10 | `tools/*.rs` | 6 core tools (mouse, keyboard, screen, app, file, clipboard) | `08_v1_rust_steps_8_to_14.md` |

## Phase 4: Rust Core — Security + System (Steps 11–14)

| Step | File | What | Doc |
|------|------|------|-----|
| 11 | `security/permissions.rs` | Permission gate (oneshot channels) | `08_v1_rust_steps_8_to_14.md` |
| 12 | `agent/hotkeys.rs` | Global hotkeys (Ctrl+Space, Esc×2) | `08_v1_rust_steps_8_to_14.md` |
| 13 | `voice/stt.rs` + `voice/tts.rs` | ElevenLabs STT/TTS + SAPI fallback | `08_v1_rust_steps_8_to_14.md` |
| 14 | `commands.rs` | Tauri IPC command registration + events | `08_v1_rust_steps_8_to_14.md` |

## Phase 5: Frontend — Design System (Step 15)

| Step | File | What | Doc |
|------|------|------|-----|
| 15 | `tailwind.config.js` | Color system, typography, border radius | `09_v1_frontend_steps_15_to_27.md` |

## Phase 6: Frontend — App Shell + Pages (Steps 16–23)

| Step | File | What | Doc |
|------|------|------|-----|
| 16 | `App.tsx` + `Sidebar.tsx` | Auth flow + dashboard shell | `09_v1_frontend_steps_15_to_27.md` |
| 17 | `pages/Home.tsx` | Hub home — status, stats, heatmap, feed, command box | `09_v1_frontend_steps_15_to_27.md` |
| 18 | `pages/Activity.tsx` | Full task log with search/filter/export | `09_v1_frontend_steps_15_to_27.md` |
| 19 | `pages/Insights.tsx` | Usage analytics (Recharts) | `09_v1_frontend_steps_15_to_27.md` |
| 20 | `pages/Memory.tsx` | Read-only learned facts | `09_v1_frontend_steps_15_to_27.md` |
| 21 | `pages/Skills.tsx` | Skill grid (placeholder in V1) | `09_v1_frontend_steps_15_to_27.md` |
| 22 | `pages/Settings.tsx` | API keys, hotkeys, voice, app, account | `09_v1_frontend_steps_15_to_27.md` |
| 23 | `pages/Security.tsx` | Emergency stop, audit, permissions, privacy | `09_v1_frontend_steps_15_to_27.md` |

## Phase 7: Frontend — Overlay + Auth (Steps 24–26)

| Step | File | What | Doc |
|------|------|------|-----|
| 24 | `FloatingOverlay.tsx` | Always-on-top overlay (6 states) | `09_v1_frontend_steps_15_to_27.md` |
| 25 | `Login.tsx` + `Onboarding.tsx` | Auth + 4-step onboarding | `09_v1_frontend_steps_15_to_27.md` |
| 26 | `supabase.ts` + `sync.ts` | Supabase client + background sync | `09_v1_frontend_steps_15_to_27.md` |

## Phase 8: Integration (Step 27)

| Step | File | What | Doc |
|------|------|------|-----|
| 27 | `main.rs` | Wire everything: tracing, SQLite, hotkeys, tray, windows | `09_v1_frontend_steps_15_to_27.md` |

---

## After V1 → V2

All V2 features documented in `11_v2_features.md`. Build only after V1 passes all tests in `12_v1_test_checklist.md`.