# Omni â€” Floating Overlay (Complete Specification)

The floating overlay is a small separate Tauri window that floats above everything while the agent works. It NEVER covers the content the agent is working on â€” stays in the corner.

---

## Window Properties

| Property | Value |
|----------|-------|
| `always_on_top` | `true` |
| `skip_taskbar` | `true` |
| `decorations` | `false` |
| `transparent` | `true` |
| Default size | 300 Ã— 60px |
| Expanded size | 300 Ã— 180px (for approval dialogs) |
| Default position | Bottom-right, 24px from edges |
| Draggable | Yes â€” user can drag to any corner |
| Position memory | Saved to localStorage |

---

## State Machine

Implemented with Framer Motion `AnimatePresence`.

| State | Visual | Behavior |
|-------|--------|----------|
| **HIDDEN** | Not visible | Default when agent idle |
| **LISTENING** | ðŸŽ¤ waveform animation | Mic active, amber glow. Shown when Ctrl+Space held. |
| **THINKING** | Spinner | "Working on it..." (grey) |
| **WORKING** | â–¶ pulsing dot | Current step text updating live + **[âœ•]** stop button (white) |
| **DONE** | âœ“ checkmark | Result text, green. Auto-hides after 4 seconds. |
| **ERROR** | âœ• X mark | Error message + **[Try again]** button, red. Auto-hides after 8 seconds. |
| **APPROVAL** | Expanded (180px) | Action description + preview + **[Cancel]** **[Approve]** buttons |

---

## Tauri Event Subscriptions

| Event | Overlay Action |
|-------|---------------|
| `hotkey:mic_start` | â†’ LISTENING state |
| `hotkey:mic_stop` | â†’ THINKING state |
| `task:started` | â†’ WORKING state |
| `task:step` | Update step text in WORKING state |
| `task:done` | â†’ DONE state (auto-hide 4s) |
| `task:failed` | â†’ ERROR state (auto-hide 8s) |
| `permission:request` | â†’ APPROVAL state (expand) |

---

## Implementation

**File:** `src/components/overlay/FloatingOverlay.tsx`

Rendered as a separate Tauri window, not inside the main Hub.
