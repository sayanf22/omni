/**
 * FloatingOverlay — top-right liquid-glass agent status card
 *
 * • Liquid glass / frosted design: backdrop-filter blur + layered gradients
 * • Shows live step-by-step history of what the agent is doing
 * • Expandable log — up to 5 recent steps shown
 * • Approval dialog with deny/approve
 * • Smooth framer-motion transitions
 * • Dynamically resizes the Tauri window to fit content
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, Loader2, CheckCircle2, AlertCircle, X,
  ShieldAlert, Square, ChevronDown, ChevronUp,
  Zap, Brain, MousePointer2, Keyboard, Eye, FileText, Clipboard
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

type OverlayState = "idle" | "listening" | "thinking" | "working" | "approval" | "question" | "success" | "error";

interface StepEntry {
  step_num: number;
  thought: string;
  tool: string | null;
  description: string;
  success: boolean;
  ts: number;
}

interface PermissionRequest {
  id: string;
  tool: string;
  action: string;
  description: string;
  preview: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const win = () => getCurrentWindow();

const hideWindow = async () => {
  try { await win().hide(); } catch (_) {}
};

const hideTextInput = async () => {
  try { await new WebviewWindow("textinput").hide(); } catch (_) {}
};

const setWindowHeight = async (h: number) => {
  try {
    const inner = await win().innerSize();
    // Clamp to a sane visible range so the window can never collapse to nothing.
    const clamped = Math.max(56, Math.min(620, Math.round(h)));
    await win().setSize({ type: "Logical", width: inner.width || 360, height: clamped } as any);
  } catch (_) {}
};

// Tool name → icon mapping
const toolIcon = (tool: string | null) => {
  if (!tool) return <Zap size={10} />;
  const t = tool.toLowerCase();
  if (t === "mouse")     return <MousePointer2 size={10} />;
  if (t === "keyboard")  return <Keyboard size={10} />;
  if (t === "screen")    return <Eye size={10} />;
  if (t === "app")       return <Brain size={10} />;
  if (t === "file")      return <FileText size={10} />;
  if (t === "clipboard") return <Clipboard size={10} />;
  return <Zap size={10} />;
};

// ── Liquid glass style helpers ────────────────────────────────────────────────

const glassCard: React.CSSProperties = {
  background: "linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%)",
  backdropFilter: "blur(28px) saturate(180%)",
  WebkitBackdropFilter: "blur(28px) saturate(180%)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 20,
  boxShadow: [
    "0 0 0 0.5px rgba(255,255,255,0.06)",
    "0 8px 32px rgba(0,0,0,0.55)",
    "0 2px 8px rgba(0,0,0,0.35)",
    "inset 0 1px 0 rgba(255,255,255,0.10)",
  ].join(", "),
  overflow: "hidden",
  userSelect: "none",
};

const glassInner: React.CSSProperties = {
  background: "rgba(16,16,22,0.97)",
};

// ── Live audio waveform (WisperFlow-style) ────────────────────────────────────
// Always gently animating while listening (so you can SEE it's live), and the
// bars jump up with your voice level.
const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const bars = 11;
  const shape = [0.4, 0.6, 0.8, 0.95, 1.0, 1.0, 1.0, 0.95, 0.8, 0.6, 0.4];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height: 26 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = 4;            // idle minimum height
        const max = 24;
        const h = Math.max(base, Math.min(max, base + lvl * (max - base) * shape[i]));
        return (
          <span
            key={i}
            className="omni-wavebar"
            style={{
              width: 3,
              height: h,
              borderRadius: 3,
              background: "linear-gradient(180deg, #a78bfa, #38bdf8)",
              transition: "height 80ms cubic-bezier(0.4,0,0.2,1)",
              animationDelay: `${i * 0.09}s`,
              // When the user is speaking, reduce the idle shimmer (real motion dominates)
              animationDuration: lvl > 0.1 ? "0.5s" : "1.1s",
            }}
          />
        );
      })}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const FloatingOverlay: React.FC = () => {
  const [state, setState] = useState<OverlayState>("idle");
  const [headerText, setHeaderText] = useState("");
  const [heard, setHeard] = useState("");   // what the user said / typed — stays visible
  const [steps, setSteps] = useState<StepEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [permReq, setPermReq] = useState<PermissionRequest | null>(null);
  const [question, setQuestion] = useState<{ id: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [audioLevel, setAudioLevel] = useState(0); // 0..1 live mic level for the waveform
  const [controlling, setControlling] = useState(false); // agent has taken over input
  const cardRef = useRef<HTMLDivElement>(null);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Paint THIS window's document solid dark. The overlay window is opaque
  // (transparent WebView2 windows fail to composite reliably on Windows, which
  // is why the floating panel wasn't showing on the PC). Each Tauri window has
  // its own document, so this only affects the overlay — not the main dashboard.
  useEffect(() => {
    document.documentElement.style.background = "#0a0a0f";
    document.documentElement.style.margin = "0";
    document.body.style.background = "#0a0a0f";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  // Sync window height to card content height
  const syncHeight = useCallback(() => {
    requestAnimationFrame(() => {
      const h = cardRef.current?.getBoundingClientRect().height ?? 0;
      if (h > 0) setWindowHeight(h + 12); // 12px padding for transparency edge
    });
  }, []);

  useEffect(() => { syncHeight(); }, [state, steps.length, expanded, permReq, question, heard, syncHeight]);

  // Clear any pending auto-hide
  const clearAutoHide = () => {
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  };

  const scheduleHide = (ms: number) => {
    clearAutoHide();
    autoHideTimer.current = setTimeout(async () => {
      setState("idle");
      setSteps([]);
      setHeard("");
      await hideWindow();
    }, ms);
  };

  const show = async () => {
    clearAutoHide();
    await win().show();
  };

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    (async () => {
      // Mic start
      cleanups.push(await listen("hotkey:mic_start", async () => {
        await show();
        setState("listening");
        setHeaderText("Listening…");
        setHeard("");
        setSteps([]);
      }));

      // Live mic level for the reactive waveform
      cleanups.push(await listen<number>("voice:level", (e) => {
        setAudioLevel(typeof e.payload === "number" ? e.payload : 0);
      }));

      // Takeover state — agent has blocked physical input
      cleanups.push(await listen("takeover:started", () => setControlling(true)));
      cleanups.push(await listen("takeover:ended", () => setControlling(false)));

      // Mic test finished (from Settings) — show briefly then hide.
      cleanups.push(await listen("voice:test_result", async () => {
        setState("idle");
        setHeard("");
        await hideWindow();
      }));

      // Mic stop
      cleanups.push(await listen("hotkey:mic_stop", () => {
        setState("thinking");
        setHeaderText("Transcribing what you said…");
      }));

      // Voice transcript — show EXACTLY what was heard (the BACKEND runs the task,
      // so we only display here; no run_task call to avoid running it twice).
      cleanups.push(await listen<{ text: string }>("voice:transcript", async (e) => {
        await hideTextInput();
        await show();
        const said = (e.payload.text || "").trim();
        setHeard(said);
        setState("thinking");
        setHeaderText("Understood — starting…");
        setSteps([]);
      }));

      // Task started
      cleanups.push(await listen<any>("task:started", async (e) => {
        await hideTextInput();
        await show();
        setState("thinking");
        const instr = (e.payload?.instruction || "").trim();
        if (instr) setHeard(instr);   // also covers typed commands
        setHeaderText("Planning…");
        setSteps([]);
        setExpanded(false);
      }));

      // Step update — append to history
      cleanups.push(await listen<any>("task:step", async (e) => {
        await show();
        setState("working");
        const entry: StepEntry = {
          step_num: e.payload.step_num || 0,
          thought: e.payload.thought || "",
          tool: e.payload.tool || null,
          description: e.payload.description || "",
          success: e.payload.success !== false,
          ts: Date.now(),
        };
        setSteps((prev) => {
          // Keep last 20 steps max to avoid memory growth
          const next = [...prev, entry].slice(-20);
          return next;
        });
        setHeaderText(entry.thought || entry.description || "Working…");
      }));

      // Permission request
      cleanups.push(await listen<PermissionRequest>("permission:request", async (e) => {
        await show();
        await win().setFocus();
        setState("approval");
        setPermReq(e.payload);
      }));

      // Free-text question — morph into chat input mode
      cleanups.push(await listen<{ id: string; question: string }>("question:request", async (e) => {
        await show();
        await win().setFocus();
        setQuestion(e.payload);
        setAnswer("");
        setState("question");
      }));

      // Done
      cleanups.push(await listen<any>("task:done", async (e) => {
        setState("success");
        setHeaderText(e.payload?.result || "Task completed.");
        scheduleHide(4000);
      }));

      // Failed
      cleanups.push(await listen<any>("task:failed", async (e) => {
        setState("error");
        setHeaderText(e.payload?.error || "Task failed.");
        scheduleHide(5000);
      }));

      // Killed / cancelled
      cleanups.push(await listen("agent:killed", async () => {
        setState("idle");
        setSteps([]);
        setHeard("");
        await hideWindow();
      }));
    })();

    return () => {
      cleanups.forEach((fn) => fn());
      clearAutoHide();
    };
  }, []);

  const handleApprove = async (approved: boolean) => {
    if (!permReq) return;
    try {
      await invoke("approve_request", { id: permReq.id, approved });
      setPermReq(null);
      setState("working");
      setHeaderText("Resuming…");
    } catch (e) { console.error(e); }
  };

  const handleSubmitAnswer = async () => {
    if (!question) return;
    const ans = answer.trim();
    if (!ans) return;
    try {
      await invoke("answer_question", { id: question.id, answer: ans });
      setQuestion(null);
      setAnswer("");
      setState("working");
      setHeaderText("Got it, continuing…");
    } catch (e) { console.error(e); }
  };

  const handleCancel = async () => {
    try { await invoke("cancel_task"); } catch (_) {}
    setState("idle");
    setSteps([]);
    await hideWindow();
  };

  if (state === "idle") return null;

  // Visible steps: show last 4 when collapsed, all when expanded
  const visibleSteps = expanded ? steps : steps.slice(-4);

  // ── State indicator config ──────────────────────────────────────────────────
  const stateConfig = {
    listening: { color: "#a78bfa", bg: "rgba(167,139,250,0.15)", border: "rgba(167,139,250,0.3)", label: "Listening", icon: <Mic size={13} /> },
    thinking:  { color: "#818CF8", bg: "rgba(129,140,248,0.15)", border: "rgba(129,140,248,0.3)", label: "Thinking",  icon: <Loader2 size={13} className="animate-spin" /> },
    working:   { color: "#38bdf8", bg: "rgba(56,189,248,0.15)",  border: "rgba(56,189,248,0.3)",  label: "Working",   icon: <Loader2 size={13} className="animate-spin" /> },
    approval:  { color: "#f87171", bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.35)", label: "Approval", icon: <ShieldAlert size={13} /> },
    question:  { color: "#38bdf8", bg: "rgba(56,189,248,0.15)",  border: "rgba(56,189,248,0.35)", label: "Question", icon: <Mic size={13} /> },
    success:   { color: "#34d399", bg: "rgba(52,211,153,0.15)",  border: "rgba(52,211,153,0.3)",  label: "Done",      icon: <CheckCircle2 size={13} /> },
    error:     { color: "#f87171", bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", label: "Error",     icon: <AlertCircle size={13} /> },
  } as const;

  const cfg = stateConfig[state as keyof typeof stateConfig] ?? stateConfig.thinking;

  return (
    <div ref={cardRef} style={{ padding: "6px", boxSizing: "border-box", background: "#0a0a0f", borderRadius: 22 }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.34, 1.2, 0.64, 1] }}
        style={{ ...glassCard, width: "100%" }}
      >
        <div style={glassInner}>

          {/* ── "Agent is controlling" banner ──────────────────────────────── */}
          {controlling && (
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "7px 12px",
              background: "linear-gradient(135deg, rgba(248,113,113,0.18), rgba(168,85,247,0.12))",
              borderBottom: "1px solid rgba(248,113,113,0.25)",
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", background: "#f87171",
                boxShadow: "0 0 8px #f87171", flexShrink: 0,
                animation: "ompulse 1.4s ease-in-out infinite",
              }} />
              <span style={{ color: "#fca5a5", fontSize: 10.5, fontWeight: 700, flex: 1 }}>
                Agent is controlling your PC
              </span>
              <span style={{
                color: "rgba(255,255,255,0.55)", fontSize: 9, fontWeight: 600,
                padding: "2px 6px", borderRadius: 6,
                background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)",
              }}>
                Esc Esc to stop
              </span>
            </div>
          )}

          {/* ── Header bar ─────────────────────────────────────────────────── */}
          <div style={{
            padding: "10px 12px 8px",
            display: "flex", alignItems: "center", gap: 9,
            borderBottom: steps.length > 0 ? "1px solid rgba(255,255,255,0.06)" : undefined,
          }}>
            {/* Status pill */}
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "3px 8px 3px 6px",
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 99,
              flexShrink: 0,
            }}>
              <span style={{ color: cfg.color, display: "flex", alignItems: "center" }}>
                {cfg.icon}
              </span>
              <span style={{ color: cfg.color, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em" }}>
                {cfg.label}
              </span>
            </div>

            {/* Header text OR live waveform when listening */}
            {state === "listening" ? (
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Waveform level={audioLevel} />
              </div>
            ) : (
              <p style={{
                flex: 1, minWidth: 0,
                color: "rgba(255,255,255,0.75)",
                fontSize: 11, fontWeight: 500,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                lineHeight: 1.3,
              }}>
                {headerText}
              </p>
            )}

            {/* Controls */}
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {(state === "working" || state === "thinking") && (
                <button
                  onClick={handleCancel}
                  title="Stop task"
                  style={{
                    display: "flex", alignItems: "center", gap: 3,
                    padding: "3px 7px",
                    background: "rgba(248,113,113,0.15)",
                    border: "1px solid rgba(248,113,113,0.3)",
                    borderRadius: 8,
                    color: "#f87171",
                    fontSize: 10, fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  <Square size={8} fill="#f87171" /> Stop
                </button>
              )}
              {(state === "success" || state === "error") && (
                <button
                  onClick={async () => { setState("idle"); setSteps([]); await hideWindow(); }}
                  title="Dismiss"
                  style={{
                    padding: "3px 6px",
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 7, color: "rgba(255,255,255,0.4)",
                    cursor: "pointer", display: "flex", alignItems: "center",
                  }}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          </div>

          {/* ── "You said" transcript bubble — shows what was heard/typed ─────── */}
          <AnimatePresence initial={false}>
            {heard && (state === "thinking" || state === "working" || state === "question" || state === "approval") && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div style={{ padding: "2px 12px 8px" }}>
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 7,
                    padding: "8px 10px",
                    background: "linear-gradient(135deg, rgba(56,189,248,0.10), rgba(129,140,248,0.06))",
                    border: "1px solid rgba(56,189,248,0.22)",
                    borderRadius: 12,
                  }}>
                    <Mic size={12} style={{ color: "#38bdf8", flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{
                        color: "rgba(255,255,255,0.45)", fontSize: 8.5, fontWeight: 700,
                        textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 2,
                      }}>
                        You said
                      </p>
                      <p style={{
                        color: "rgba(255,255,255,0.92)", fontSize: 12, fontWeight: 500,
                        lineHeight: 1.45, wordBreak: "break-word",
                      }}>
                        {heard}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Step history ────────────────────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {steps.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div style={{ padding: "6px 10px 4px" }}>
                  {/* Toggle expand/collapse */}
                  {steps.length > 4 && (
                    <button
                      onClick={() => setExpanded((e) => !e)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 4, padding: "3px 0 5px",
                        background: "transparent", border: "none",
                        color: "rgba(255,255,255,0.3)", fontSize: 9, fontWeight: 600,
                        cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                      }}
                    >
                      {expanded ? <><ChevronUp size={9} /> Show less</> : <><ChevronDown size={9} /> Show all {steps.length} steps</>}
                    </button>
                  )}

                  {/* Step rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {visibleSteps.map((s, i) => (
                      <motion.div
                        key={s.ts}
                        initial={{ opacity: 0, x: 6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.14, delay: i * 0.02 }}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 7,
                          padding: "5px 7px",
                          background: s.success
                            ? "rgba(255,255,255,0.03)"
                            : "rgba(248,113,113,0.07)",
                          border: s.success
                            ? "1px solid rgba(255,255,255,0.06)"
                            : "1px solid rgba(248,113,113,0.2)",
                          borderRadius: 10,
                        }}
                      >
                        {/* Step number */}
                        <span style={{
                          flexShrink: 0, width: 16, height: 16,
                          borderRadius: "50%",
                          background: s.success ? "rgba(56,189,248,0.15)" : "rgba(248,113,113,0.15)",
                          border: s.success ? "1px solid rgba(56,189,248,0.3)" : "1px solid rgba(248,113,113,0.3)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 8, fontWeight: 800,
                          color: s.success ? "#38bdf8" : "#f87171",
                        }}>
                          {s.step_num}
                        </span>

                        {/* Content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {s.thought && (
                            <p style={{
                              color: "rgba(255,255,255,0.65)", fontSize: 10, fontWeight: 500,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              marginBottom: 1,
                            }}>
                              {s.thought}
                            </p>
                          )}
                          {s.description && s.description !== s.thought && (
                            <p style={{
                              color: s.success ? "rgba(255,255,255,0.35)" : "#f87171",
                              fontSize: 9, lineHeight: 1.4,
                              overflow: "hidden", textOverflow: "ellipsis",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                            }}>
                              {s.description}
                            </p>
                          )}
                        </div>

                        {/* Tool badge */}
                        {s.tool && (
                          <span style={{
                            flexShrink: 0,
                            display: "flex", alignItems: "center", gap: 3,
                            padding: "2px 5px",
                            background: "rgba(255,255,255,0.05)",
                            border: "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 5,
                            color: "rgba(255,255,255,0.4)",
                            fontSize: 8, fontWeight: 600, textTransform: "uppercase",
                          }}>
                            {toolIcon(s.tool)}
                            {s.tool}
                          </span>
                        )}
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Approval dialog ─────────────────────────────────────────────── */}
          <AnimatePresence>
            {state === "approval" && permReq && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div style={{
                  padding: "10px 12px 12px",
                  borderTop: "1px solid rgba(248,113,113,0.2)",
                }}>
                  <p style={{
                    color: "#f87171", fontSize: 9, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6,
                  }}>
                    Permission Required
                  </p>
                  <p style={{
                    color: "rgba(255,255,255,0.8)", fontSize: 11, lineHeight: 1.5,
                    wordBreak: "break-word", marginBottom: 8,
                  }}>
                    {permReq.description}
                  </p>
                  {permReq.tool && (
                    <span style={{
                      display: "inline-block", marginBottom: 10,
                      padding: "2px 8px",
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 6, color: "rgba(255,255,255,0.4)",
                      fontSize: 9, fontFamily: "monospace",
                    }}>
                      {permReq.tool} → {permReq.action}
                    </span>
                  )}
                  <div style={{ display: "flex", gap: 7 }}>
                    <button
                      onClick={() => handleApprove(false)}
                      style={{
                        flex: 1, padding: "7px 0",
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 11, color: "rgba(255,255,255,0.6)",
                        fontSize: 11, fontWeight: 700, cursor: "pointer",
                      }}
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => handleApprove(true)}
                      style={{
                        flex: 1, padding: "7px 0",
                        background: "linear-gradient(135deg, rgba(52,211,153,0.3), rgba(16,185,129,0.2))",
                        border: "1px solid rgba(52,211,153,0.4)",
                        borderRadius: 11, color: "#34d399",
                        fontSize: 11, fontWeight: 700, cursor: "pointer",
                      }}
                    >
                      Approve ✓
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Question chat (morphs in smoothly) ──────────────────────────── */}
          <AnimatePresence>
            {state === "question" && question && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.34, 1.1, 0.64, 1] }}
              >
                <div style={{
                  padding: "12px 12px 14px",
                  borderTop: "1px solid rgba(56,189,248,0.2)",
                  background: "linear-gradient(180deg, rgba(56,189,248,0.05), transparent)",
                }}>
                  {/* The question */}
                  <motion.p
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 }}
                    style={{
                      color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: 600,
                      lineHeight: 1.45, marginBottom: 10, wordBreak: "break-word",
                    }}
                  >
                    {question.question}
                  </motion.p>

                  {/* Chat input */}
                  <motion.div
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.12 }}
                    style={{ position: "relative", display: "flex", gap: 7 }}
                  >
                    <input
                      autoFocus
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleSubmitAnswer(); }
                      }}
                      placeholder="Type your answer…"
                      style={{
                        flex: 1,
                        background: "rgba(255,255,255,0.06)",
                        border: "1px solid rgba(56,189,248,0.3)",
                        borderRadius: 11,
                        padding: "9px 12px",
                        color: "#f4f4f5",
                        fontSize: 12,
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                    <button
                      onClick={handleSubmitAnswer}
                      disabled={!answer.trim()}
                      style={{
                        flexShrink: 0,
                        padding: "0 14px",
                        background: answer.trim()
                          ? "linear-gradient(135deg, rgba(56,189,248,0.4), rgba(14,165,233,0.3))"
                          : "rgba(255,255,255,0.05)",
                        border: `1px solid ${answer.trim() ? "rgba(56,189,248,0.5)" : "rgba(255,255,255,0.1)"}`,
                        borderRadius: 11,
                        color: answer.trim() ? "#7dd3fc" : "rgba(255,255,255,0.3)",
                        fontSize: 12, fontWeight: 700,
                        cursor: answer.trim() ? "pointer" : "default",
                      }}
                    >
                      Send
                    </button>
                  </motion.div>
                  <p style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, marginTop: 7 }}>
                    Press Enter to send · agent is paused
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Success result ─────────────────────────────────────────────── */}
          <AnimatePresence>
            {state === "success" && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div style={{
                  padding: "8px 12px 10px",
                  borderTop: "1px solid rgba(52,211,153,0.15)",
                }}>
                  <p style={{
                    color: "rgba(255,255,255,0.5)", fontSize: 10,
                    lineHeight: 1.5, wordBreak: "break-word",
                  }}>
                    {headerText}
                  </p>
                  <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 9, marginTop: 4 }}>
                    Auto-closing in 4s…
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Bottom glow accent ─────────────────────────────────────────── */}
          <div style={{
            height: 2,
            background: `linear-gradient(90deg, transparent, ${cfg.color}55, transparent)`,
            opacity: 0.6,
          }} />
        </div>
      </motion.div>
    </div>
  );
};

export default FloatingOverlay;

// ── Injected keyframe CSS ─────────────────────────────────────────────────────
if (typeof document !== "undefined") {
  const id = "omni-overlay-styles";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `
      @keyframes omspin  { to { transform: rotate(360deg); } }
      @keyframes ompulse {
        0%,100% { opacity:0.5; transform:scale(1);   }
        50%     { opacity:0;   transform:scale(1.9); }
      }
      @keyframes omwave {
        0%,100% { transform: scaleY(0.5); }
        50%     { transform: scaleY(1.0); }
      }
      .animate-spin { animation: omspin 0.8s linear infinite; }
      .omni-wavebar { animation: omwave 1.1s ease-in-out infinite; transform-origin: center; }
    `;
    document.head.appendChild(s);
  }
}
