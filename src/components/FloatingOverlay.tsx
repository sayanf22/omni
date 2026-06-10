/**
 * FloatingOverlay — top-right status card + approval dialog
 *
 * Shows what the agent is doing in a compact card pinned to the top-right.
 * On approval requests: expands to show full action description + Deny/Approve.
 * Auto-hides when idle. The textinput window is hidden once a task starts.
 */
import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Loader2, CheckCircle2, AlertCircle, X, ShieldAlert, Square } from "lucide-react";

type OverlayState = "idle" | "listening" | "thinking" | "working" | "approval" | "success" | "error";

interface PermissionRequest {
  id: string;
  tool: string;
  action: string;
  description: string;
  preview: string | null;
}

const hideWindow = async () => {
  try { await getCurrentWindow().hide(); } catch (_) {}
};

// Hide the text input floating window once a task has been dispatched
const hideTextInput = async () => {
  try {
    const w = new WebviewWindow("textinput");
    await w.hide();
  } catch (_) {}
};

export const FloatingOverlay: React.FC = () => {
  const [state, setState] = useState<OverlayState>("idle");
  const [text, setText] = useState("");
  const [stepNum, setStepNum] = useState(0);
  const [permissionReq, setPermissionReq] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    (async () => {
      // ── Mic start ──────────────────────────────────────────────────────────
      cleanups.push(await listen("hotkey:mic_start", async () => {
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
        setState("listening");
        setText("Listening…");
      }));

      // ── Mic stop (processing) ─────────────────────────────────────────────
      cleanups.push(await listen("hotkey:mic_stop", () => {
        setState("thinking");
        setText("Processing…");
      }));

      // ── Voice transcript received — hide textinput, show overlay ──────────
      cleanups.push(await listen<{ text: string }>("voice:transcript", async (event) => {
        await hideTextInput();
        await getCurrentWindow().show();
        setState("thinking");
        setText(`"${event.payload.text}"`);
        try {
          invoke("run_task", { instruction: event.payload.text, userId: "" });
        } catch (e: any) {
          setState("error");
          setText(e?.toString() || "Failed to start task.");
        }
      }));

      // ── Task started ──────────────────────────────────────────────────────
      cleanups.push(await listen("task:started", async () => {
        await hideTextInput();
        await getCurrentWindow().show();
        setState("thinking");
        setStepNum(0);
      }));

      // ── Step update ───────────────────────────────────────────────────────
      cleanups.push(await listen<any>("task:step", async (event) => {
        await getCurrentWindow().show();
        setState("working");
        setStepNum(event.payload.step_num || 0);
        setText(event.payload.thought || event.payload.description || "Working…");
      }));

      // ── Permission request ────────────────────────────────────────────────
      cleanups.push(await listen<PermissionRequest>("permission:request", async (event) => {
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
        setState("approval");
        setPermissionReq(event.payload);
      }));

      // ── Done ──────────────────────────────────────────────────────────────
      cleanups.push(await listen("task:done", async () => {
        setState("success");
        setText("Done!");
        setTimeout(async () => {
          setState("idle");
          await hideWindow();
        }, 2500);
      }));

      // ── Failed ────────────────────────────────────────────────────────────
      cleanups.push(await listen<any>("task:failed", async (event) => {
        setState("error");
        setText(event.payload?.error || "Task failed.");
        setTimeout(async () => {
          setState("idle");
          await hideWindow();
        }, 4000);
      }));

      // ── Killed ────────────────────────────────────────────────────────────
      cleanups.push(await listen("agent:killed", async () => {
        setState("idle");
        await hideWindow();
      }));
    })();

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const handleApprove = async (approved: boolean) => {
    if (!permissionReq) return;
    try {
      await invoke("approve_request", { id: permissionReq.id, approved });
      setPermissionReq(null);
      setState("working");
      setText("Resuming…");
    } catch (e) { console.error(e); }
  };

  const handleCancel = async () => {
    try { await invoke("cancel_task"); } catch (_) {}
    setState("idle");
    await hideWindow();
  };

  if (state === "idle") return null;

  // ── Determine height based on state ────────────────────────────────────────
  // The overlay window is 320px wide, positioned top-right.
  // We render a card that fills it, expanding/collapsing via AnimatePresence.

  return (
    <AnimatePresence>
      <motion.div
        key={state}
        initial={{ opacity: 0, y: -8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.97 }}
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        style={{
          width: "100%",
          background: "#111113",
          border: state === "approval" ? "1px solid rgba(239,68,68,0.45)" : "1px solid #232327",
          borderRadius: "14px",
          overflow: "hidden",
          boxShadow: "0 16px 40px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.4)",
          userSelect: "none",
        }}
      >
        {/* ── Listening ──────────────────────────────────────────────────────── */}
        {state === "listening" && (
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ position: "relative", width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "rgba(255,255,255,0.04)", animation: "ompulse 1.5s ease-out infinite" }} />
              <Mic style={{ width: 14, height: 14, color: "#f4f4f5" }} />
            </div>
            <div>
              <p style={{ color: "#f4f4f5", fontSize: 12, fontWeight: 700 }}>Listening…</p>
              <p style={{ color: "#52525B", fontSize: 10 }}>Release key when done speaking</p>
            </div>
          </div>
        )}

        {/* ── Thinking ───────────────────────────────────────────────────────── */}
        {state === "thinking" && (
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Loader2 style={{ width: 13, height: 13, color: "#818CF8", animation: "omspin 0.8s linear infinite" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: "#818CF8", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Planning</p>
              <p style={{ color: "#a1a1aa", fontSize: 11, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text || "Analyzing task…"}</p>
            </div>
            <button onClick={handleCancel} style={{ padding: 4, background: "transparent", border: "none", color: "#52525B", cursor: "pointer", borderRadius: 6 }} title="Cancel">
              <X style={{ width: 12, height: 12 }} />
            </button>
          </div>
        )}

        {/* ── Working ────────────────────────────────────────────────────────── */}
        {state === "working" && (
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Loader2 style={{ width: 13, height: 13, color: "#818CF8", animation: "omspin 0.8s linear infinite" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                <span style={{ color: "#f4f4f5", fontSize: 11, fontWeight: 700 }}>Step {stepNum}</span>
                <span style={{ color: "#3f3f46", fontSize: 10 }}>executing</span>
              </div>
              <p style={{ color: "#a1a1aa", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</p>
            </div>
            <button onClick={handleCancel} style={{ flexShrink: 0, padding: "5px 8px", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, color: "#ef4444", fontSize: 10, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
              <Square style={{ width: 9, height: 9, fill: "#ef4444" }} /> Stop
            </button>
          </div>
        )}

        {/* ── Approval ───────────────────────────────────────────────────────── */}
        {state === "approval" && permissionReq && (
          <div style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.35)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                <ShieldAlert style={{ width: 13, height: 13, color: "#ef4444" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ color: "#ef4444", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Permission Required</p>
                <p style={{ color: "#f4f4f5", fontSize: 12, fontWeight: 600, lineHeight: 1.4, wordBreak: "break-word" }}>
                  {permissionReq.description}
                </p>
                {permissionReq.tool && (
                  <span style={{ display: "inline-block", marginTop: 6, padding: "2px 7px", background: "#1e1e22", border: "1px solid #2e2e34", borderRadius: 6, color: "#71717A", fontSize: 10, fontFamily: "monospace" }}>
                    {permissionReq.tool} → {permissionReq.action}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => handleApprove(false)}
                style={{ flex: 1, padding: "7px 0", background: "#1e1e22", border: "1px solid #2e2e34", borderRadius: 9, color: "#f4f4f5", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Deny
              </button>
              <button
                onClick={() => handleApprove(true)}
                style={{ flex: 1, padding: "7px 0", background: "#16a34a", border: "1px solid rgba(22,163,74,0.6)", borderRadius: 9, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >
                Approve
              </button>
            </div>
          </div>
        )}

        {/* ── Success ────────────────────────────────────────────────────────── */}
        {state === "success" && (
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <CheckCircle2 style={{ width: 13, height: 13, color: "#10b981" }} />
            </div>
            <div>
              <p style={{ color: "#10b981", fontSize: 12, fontWeight: 700 }}>Task completed</p>
              <p style={{ color: "#52525B", fontSize: 10, marginTop: 1 }}>Auto-closing in 2s…</p>
            </div>
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────────────────── */}
        {state === "error" && (
          <div style={{ padding: "12px 14px", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
              <AlertCircle style={{ width: 13, height: 13, color: "#ef4444" }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: "#ef4444", fontSize: 12, fontWeight: 700, marginBottom: 2 }}>Error</p>
              <p style={{ color: "#a1a1aa", fontSize: 11, wordBreak: "break-word", lineHeight: 1.4 }}>{text}</p>
            </div>
            <button onClick={async () => { setState("idle"); await hideWindow(); }} style={{ padding: 4, background: "transparent", border: "none", color: "#52525B", cursor: "pointer", borderRadius: 6, flexShrink: 0 }}>
              <X style={{ width: 12, height: 12 }} />
            </button>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export default FloatingOverlay;

// Styles injected for overlay-specific animations
const style = document.createElement("style");
style.textContent = `
  @keyframes omspin  { to { transform: rotate(360deg); } }
  @keyframes ompulse { 0%,100%{opacity:0.4;transform:scale(1)} 50%{opacity:0;transform:scale(1.8)} }
`;
if (typeof document !== "undefined" && !document.getElementById("omni-overlay-styles")) {
  style.id = "omni-overlay-styles";
  document.head.appendChild(style);
}
