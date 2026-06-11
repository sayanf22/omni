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
import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, Loader2, CheckCircle2, AlertCircle, X,
  ShieldAlert, Square, ChevronDown, ChevronUp, Minus,
  Zap, Brain, MousePointer2, Keyboard, Eye, FileText, Clipboard
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

type OverlayState = "idle" | "listening" | "thinking" | "working" | "approval" | "question" | "success" | "error" | "text_input";

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

// Tool name → icon mapping
const toolIcon = (tool: string | null) => {
  if (!tool) return <Zap size={12} />;
  const t = tool.toLowerCase();
  if (t === "mouse")     return <MousePointer2 size={12} />;
  if (t === "keyboard")  return <Keyboard size={12} />;
  if (t === "screen")    return <Eye size={12} />;
  if (t === "app")       return <Brain size={12} />;
  if (t === "file")      return <FileText size={12} />;
  if (t === "clipboard") return <Clipboard size={12} />;
  return <Zap size={12} />;
};

// ── Liquid glass style helpers ────────────────────────────────────────────────

// Glass styling helpers are defined dynamically inside the component to support light/dark themes

// ── Live audio waveform (WisperFlow-style) ────────────────────────────────────
// Always gently animating while listening (so you can SEE it's live), and the
// bars jump up with your voice level.
const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const bars = 11;
  const shape = [0.4, 0.6, 0.8, 0.95, 1.0, 1.0, 1.0, 0.95, 0.8, 0.6, 0.4];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, height: 32 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = 5;            // idle minimum height
        const max = 30;
        const h = Math.max(base, Math.min(max, base + lvl * (max - base) * shape[i]));
        return (
          <span
            key={i}
            className="omni-wavebar"
            style={{
              width: 4,
              height: h,
              borderRadius: 4,
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
  const { theme } = useStore();
  const isLight = theme === "light";

  const cardBg = isLight
    ? "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(245,245,245,0.90) 100%)"
    : "linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.03) 100%)";
  const cardBorder = isLight ? "1px solid rgba(0,0,0,0.15)" : "1px solid rgba(255,255,255,0.12)";
  const innerBg = isLight ? "rgba(255, 255, 255, 0.95)" : "rgba(8, 8, 12, 0.50)";
  const textColor = isLight ? "#1f2937" : "rgba(255,255,255,0.85)";
  const textColorSecondary = isLight ? "#4b5563" : "rgba(255,255,255,0.55)";
  const textColorMuted = isLight ? "#9ca3af" : "rgba(255,255,255,0.3)";

  const glassCard: React.CSSProperties = {
    background: cardBg,
    backdropFilter: "blur(32px) saturate(200%)",
    WebkitBackdropFilter: "blur(32px) saturate(200%)",
    border: cardBorder,
    borderRadius: 20,
    boxShadow: isLight
      ? [
          "0 12px 40px rgba(0,0,0,0.12)",
          "0 2px 8px rgba(0,0,0,0.06)",
          "inset 0 1px 0 rgba(255,255,255,0.8)",
        ].join(", ")
      : [
          "0 12px 40px rgba(0,0,0,0.45)",
          "0 2px 8px rgba(0,0,0,0.25)",
          "inset 0 1px 0 rgba(255,255,255,0.15)",
        ].join(", "),
    overflow: "hidden",
    userSelect: "none",
  };

  const glassInner: React.CSSProperties = {
    background: innerBg,
  };

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
  const [isDictating, setIsDictating] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [maxHeight, setMaxHeight] = useState(700);

  // Refs to avoid stale closures in event listeners
  const stateRef = useRef(state);
  const answerRef = useRef(answer);
  const questionRef = useRef(question);
  const isDictatingRef = useRef(isDictating);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { answerRef.current = answer; }, [answer]);
  useEffect(() => { questionRef.current = question; }, [question]);
  useEffect(() => { isDictatingRef.current = isDictating; }, [isDictating]);

  const toggleMicDictation = async () => {
    if (isDictatingRef.current) {
      try { await invoke("trigger_mic_stop"); } catch (e) { console.error(e); }
      setIsDictating(false);
    } else {
      setIsDictating(true);
      try { await invoke("trigger_mic_start"); } catch (e) { console.error(e); }
    }
  };

  useEffect(() => {
    const updateMaxHeight = async () => {
      try {
        const monitor = await primaryMonitor();
        const scale = await getCurrentWindow().scaleFactor();
        if (monitor) {
          const logicalHeight = monitor.size.height / scale;
          // Subtract 100px for margins (40px top, 60px bottom/taskbar)
          setMaxHeight(Math.max(300, Math.floor(logicalHeight - 100)));
        }
      } catch (e) {
        console.warn("Failed to get monitor size:", e);
      }
    };
    updateMaxHeight();
  }, [state]);

  // Set the document and body backgrounds to transparent to let the glass card
  // composite cleanly over the desktop when transparent is true in tauri.conf.json
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.documentElement.style.margin = "0";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  // ── Polling fallback (bulletproof) ────────────────────────────────────────
  // Events to a secondary webview can be missed, leaving the panel empty/black.
  // So we ALSO poll the backend's live state every 350ms and drive the UI from
  // it. This guarantees the panel always reflects what the agent is doing.
  const lastSeq = useRef<number>(-1);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<any>("get_live_state");
        if (!alive || !s) return;
        if (typeof s.seq === "number" && s.seq === lastSeq.current) return; // no change
        lastSeq.current = s.seq;
        const phase = s.phase as string;

        if (phase === "idle") {
          // Only hide if we aren't mid-question/approval driven by events.
          setState((prev) => (prev === "question" || prev === "approval") ? prev : "idle");
          return;
        }
        await show();
        if (s.heard) setHeard(s.heard);
        if (Array.isArray(s.steps)) {
          setSteps(s.steps.map((st: any) => ({
            step_num: st.step_num || 0,
            thought: st.thought || "",
            tool: st.tool || null,
            description: st.description || "",
            success: st.success !== false,
            ts: st.step_num || 0,
          })));
        }
        if (phase === "question" && s.question) {
          setQuestion({ id: s.question_id, question: s.question });
          setState("question");
        } else if (phase === "success") {
          setHeaderText(s.header || "Done.");
          setState("success");
          scheduleHide(5000);
        } else if (phase === "error") {
          setHeaderText(s.header || "Task failed.");
          setState("error");
          scheduleHide(6000);
        } else if (phase === "working") {
          setHeaderText(s.header || "Working…");
          setState("working");
        } else if (phase === "thinking") {
          setHeaderText(s.header || "Planning…");
          setState("thinking");
        }
      } catch (_) { /* backend not ready */ }
    };
    const id = setInterval(tick, 350);
    tick();
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Sync window height dynamically to card content height using a ResizeObserver.
  // Using scrollHeight (unconstrained) avoids the window getting stuck at its current size.
  useEffect(() => {
    if (state === "idle") {
      hideWindow();
      return;
    }

    const card = cardRef.current;
    if (!card) return;

    const doResize = () => {
      const rect = card.getBoundingClientRect();
      const height = Math.ceil(rect.height + 16);
      try {
        getCurrentWindow().setSize(new LogicalSize(400, Math.min(height, maxHeight)));
      } catch (e) {
        console.warn("Failed to resize Tauri overlay window:", e);
      }
    };

    // Run once immediately in case there are already steps
    doResize();

    const resizeObserver = new ResizeObserver(doResize);
    resizeObserver.observe(card);
    return () => resizeObserver.disconnect();
  }, [state, steps, maxHeight]);

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
    let active = true;
    const unsubscribes: Array<() => void> = [];

    async function setup() {
      const addListener = async (evt: string, cb: (...args: any[]) => void) => {
        const unsub = await listen(evt, cb);
        if (active) {
          unsubscribes.push(unsub);
        } else {
          unsub();
        }
      };

      // Mic start
      await addListener("hotkey:mic_start", async () => {
        await show();
        const curState = stateRef.current;
        if (curState === "question" || curState === "text_input") {
          setIsDictating(true);
        } else {
          setIsDictating(false);
          setState("listening");
          setHeaderText("Listening…");
          setHeard("");
          setSteps([]);
        }
      });

      // Live mic level for the reactive waveform
      await addListener("voice:level", (e: any) => {
        setAudioLevel(typeof e.payload === "number" ? e.payload : 0);
      });

      // Takeover state — agent has blocked physical input
      await addListener("takeover:started", () => setControlling(true));
      await addListener("takeover:ended", () => setControlling(false));

      // Mic test finished (from Settings) — show briefly then hide.
      await addListener("voice:test_result", async () => {
        setIsDictating(false);
        setState("idle");
        setHeard("");
        await hideWindow();
      });

      // Mic stop
      await addListener("hotkey:mic_stop", () => {
        const curState = stateRef.current;
        if (curState === "question" || curState === "text_input") {
          // Keep dictation active (transcribing phase) until transcript event arrives
        } else {
          setState("thinking");
          setHeaderText("Transcribing what you said…");
        }
      });

      // Voice transcript — show EXACTLY what was heard (the BACKEND runs the task,
      // so we only display here; no run_task call to avoid running it twice).
      await addListener("voice:transcript", async (e: any) => {
        await show();
        const said = (e.payload.text || "").trim();
        const curState = stateRef.current;
        if (curState === "question" || curState === "text_input") {
          setAnswer(said);
          setIsDictating(false);
        } else {
          setHeard(said);
          setState("thinking");
          setHeaderText("Understood — starting…");
          setSteps([]);
        }
      });

      // Task started
      await addListener("task:started", async (e: any) => {
        await show();
        setState("thinking");
        const instr = (e.payload?.instruction || "").trim();
        if (instr) setHeard(instr);   // also covers typed commands
        setHeaderText("Planning…");
        setSteps([]);
        setExpanded(false);
      });

      // Step update — append to history, replacing existing steps with same step_num
      await addListener("task:step", async (e: any) => {
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
          // Replace in-place if step_num matches (running → completed update), else append
          const idx = prev.findIndex((s) => s.step_num === entry.step_num);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = entry;
            return next.slice(-20);
          }
          return [...prev, entry].slice(-20);
        });
        setHeaderText(entry.thought || entry.description || "Working…");
      });

      // Permission request
      await addListener("permission:request", async (e: any) => {
        await show();
        await win().setFocus();
        setState("approval");
        setPermReq(e.payload);
      });

      // Free-text question — morph into chat input mode
      await addListener("question:request", async (e: any) => {
        await show();
        await win().setFocus();
        setQuestion(e.payload);
        setAnswer("");
        setState("question");
      });

      // Global hotkey: text input mode triggered
      await addListener("hotkey:text_mode", async () => {
        await show();
        await win().setFocus();
        setState("text_input");
        setHeard("");
        setSteps([]);
        setAnswer("");
      });

      // Done
      await addListener("task:done", async (e: any) => {
        setIsDictating(false);
        setState("success");
        setHeaderText(e.payload?.result || "Task completed.");
        scheduleHide(20000);
      });

      // Failed
      await addListener("task:failed", async (e: any) => {
        setIsDictating(false);
        setState("error");
        setHeaderText(e.payload?.error || "Task failed.");
        scheduleHide(20000);
      });

      // Killed / cancelled
      await addListener("agent:killed", async () => {
        setIsDictating(false);
        setState("idle");
        setSteps([]);
        setHeard("");
        await hideWindow();
      });
    }

    setup();

    return () => {
      active = false;
      unsubscribes.forEach((fn) => fn());
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

  const handleSendPrompt = async () => {
    const prompt = answer.trim();
    if (!prompt) return;
    try {
      setHeard(prompt);
      setState("thinking");
      setHeaderText("Planning…");
      setSteps([]);
      setAnswer("");
      await invoke("run_task", { instruction: prompt, userId: "" });
    } catch (e) {
      console.error(e);
      setHeaderText("Failed to start task");
      setState("error");
    }
  };

  // ── Global Escape key listener ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();

        if (isDictatingRef.current) {
          try { await invoke("trigger_mic_stop"); } catch (_) {}
          setIsDictating(false);
          return;
        }

        if (state === "listening") {
          try { await invoke("trigger_mic_stop"); } catch (_) {}
          setState("idle");
          await hideWindow();
        } else if (state === "text_input" || state === "question" || state === "approval") {
          setState("idle");
          setSteps([]);
          setHeard("");
          setAnswer("");
          await hideWindow();
        } else if (state === "working" || state === "thinking") {
          await handleCancel();
        } else {
          setState("idle");
          setSteps([]);
          setHeard("");
          await hideWindow();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state, answer, question, permReq]);

  if (state === "idle") return null;

  // Visible steps: show last 4 when collapsed, all when expanded
  const visibleSteps = expanded ? steps : steps.slice(-4);

  // ── State indicator config ──────────────────────────────────────────────────
  const stateConfig = {
    listening: { color: "#a78bfa", bg: "rgba(167,139,250,0.15)", border: "rgba(167,139,250,0.3)", label: "Listening", icon: <Mic size={15.5} /> },
    thinking:  { color: "#818CF8", bg: "rgba(129,140,248,0.15)", border: "rgba(129,140,248,0.3)", label: "Thinking",  icon: <Loader2 size={15.5} className="animate-spin" /> },
    working:   { color: "#38bdf8", bg: "rgba(56,189,248,0.15)",  border: "rgba(56,189,248,0.3)",  label: "Working",   icon: <Loader2 size={15.5} className="animate-spin" /> },
    approval:  { color: "#f87171", bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.35)", label: "Approval", icon: <ShieldAlert size={15.5} /> },
    question:  { color: "#38bdf8", bg: "rgba(56,189,248,0.15)",  border: "rgba(56,189,248,0.35)", label: "Question", icon: <Mic size={15.5} /> },
    text_input: { color: "#818CF8", bg: "rgba(129,140,248,0.15)", border: "rgba(129,140,248,0.35)", label: "Command", icon: <Brain size={15.5} /> },
    success:   { color: "#34d399", bg: "rgba(52,211,153,0.15)",  border: "rgba(52,211,153,0.3)",  label: "Done",      icon: <CheckCircle2 size={15.5} /> },
    error:     { color: "#f87171", bg: "rgba(248,113,113,0.15)", border: "rgba(248,113,113,0.3)", label: "Error",     icon: <AlertCircle size={15.5} /> },
  } as const;

  const cfg = stateConfig[state as keyof typeof stateConfig] ?? stateConfig.thinking;

  return (
    <div style={{ width: "400px", padding: "6px", boxSizing: "border-box", background: "transparent", display: "flex", flexDirection: "column" }}>
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, scale: 0.98, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.34, 1.2, 0.64, 1] }}
        style={{ ...glassCard, width: "100%", display: "flex", flexDirection: "column" }}
      >
        <div style={{ ...glassInner, display: "flex", flexDirection: "column" }}>

          {/* ── "Agent is controlling" banner ──────────────────────────────── */}
          {controlling && (
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "7px 12px",
              background: "linear-gradient(135deg, rgba(248,113,113,0.18), rgba(168,85,247,0.12))",
              borderBottom: `1px solid ${isLight ? "rgba(248,113,113,0.35)" : "rgba(248,113,113,0.25)"}`,
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", background: "#f87171",
                boxShadow: "0 0 8px #f87171", flexShrink: 0,
                animation: "ompulse 1.4s ease-in-out infinite",
              }} />
              <span style={{ color: isLight ? "#991b1b" : "#fca5a5", fontSize: 10.5, fontWeight: 700, flex: 1 }}>
                Agent is controlling your PC
              </span>
              <span style={{
                color: isLight ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.55)", fontSize: 9, fontWeight: 600,
                padding: "2px 6px", borderRadius: 6,
                background: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.07)",
                border: isLight ? "1px solid rgba(0,0,0,0.1)" : "1px solid rgba(255,255,255,0.12)",
              }}>
                Esc Esc to stop
              </span>
            </div>
          )}

          {/* ── Header bar ─────────────────────────────────────────────────── */}
          <div style={{
            padding: "14px 16px 10px",
            display: "flex", alignItems: "center", gap: 11,
            borderBottom: steps.length > 0 ? (isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(255,255,255,0.06)") : undefined,
          }}>
            {/* Status pill */}
            <div style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "4.5px 11px 4.5px 8px",
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 99,
              flexShrink: 0,
            }}>
              <span style={{ color: cfg.color, display: "flex", alignItems: "center" }}>
                {cfg.icon}
              </span>
              <span style={{ color: cfg.color, fontSize: 12, fontWeight: 800, letterSpacing: "0.04em" }}>
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
                color: textColor,
                fontSize: 13.5, fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                lineHeight: 1.4,
              }}>
                {headerText}
              </p>
            )}

            {/* Controls */}
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {/* Hide panel (task keeps running) — re-show with Ctrl+Shift+O */}
              <button
                onClick={hideWindow}
                title="Hide panel (Ctrl+Shift+O to toggle)"
                style={{
                  padding: "5px 8px",
                  background: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)",
                  border: isLight ? "1px solid rgba(0,0,0,0.1)" : "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 9, color: textColorSecondary,
                  cursor: "pointer", display: "flex", alignItems: "center",
                }}
              >
                <Minus size={13} />
              </button>
              {(state === "working" || state === "thinking") && (
                <button
                  onClick={handleCancel}
                  title="Stop task"
                  style={{
                    display: "flex", alignItems: "center", gap: 4.5,
                    padding: "5px 10px",
                    background: "rgba(248,113,113,0.15)",
                    border: "1px solid rgba(248,113,113,0.3)",
                    borderRadius: 10,
                    color: "#f87171",
                    fontSize: 12, fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  <Square size={10} fill="#f87171" /> Stop
                </button>
              )}
              {(state === "success" || state === "error") && (
                <button
                  onClick={async () => { setState("idle"); setSteps([]); await hideWindow(); }}
                  title="Dismiss"
                  style={{
                    padding: "5px 8px",
                    background: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)",
                    border: isLight ? "1px solid rgba(0,0,0,0.1)" : "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 9, color: textColorSecondary,
                    cursor: "pointer", display: "flex", alignItems: "center",
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* ── Scrollable activity region (you said + all steps) ──────────── */}
          <div className="omni-scroll" style={{ maxHeight: Math.max(150, maxHeight - 180), overflowY: "auto" }}>

          {/* ── "You said" transcript bubble — shows what was heard/typed ─────── */}
          <AnimatePresence initial={false}>
            {heard && (state === "thinking" || state === "working" || state === "question" || state === "approval") && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
              >
                <div style={{ padding: "3px 16px 10px" }}>
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 9,
                    padding: "10px 14px",
                    background: isLight
                      ? "linear-gradient(135deg, rgba(56,189,248,0.15), rgba(129,140,248,0.10))"
                      : "linear-gradient(135deg, rgba(56,189,248,0.10), rgba(129,140,248,0.06))",
                    border: isLight
                      ? "1px solid rgba(56,189,248,0.35)"
                      : "1px solid rgba(56,189,248,0.22)",
                    borderRadius: 14,
                  }}>
                    <Mic size={15} style={{ color: "#38bdf8", flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{
                        color: isLight ? "#0284c7" : "rgba(255,255,255,0.55)", fontSize: 10.5, fontWeight: 800,
                        textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3,
                      }}>
                        You said
                      </p>
                      <p style={{
                        color: isLight ? "#0f172a" : "rgba(255,255,255,0.95)", fontSize: 14.5, fontWeight: 500,
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
                <div style={{ padding: "8px 14px 6px" }}>
                  {/* Toggle expand/collapse */}
                  {steps.length > 4 && (
                    <button
                      onClick={() => setExpanded((e) => !e)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 5, padding: "4px 0 6px",
                        background: "transparent", border: "none",
                        color: isLight ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 700,
                        cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                      }}
                    >
                      {expanded ? <><ChevronUp size={11} /> Show less</> : <><ChevronDown size={11} /> Show all {steps.length} steps</>}
                    </button>
                  )}

                  {/* Step rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {visibleSteps.map((s, i) => (
                      <motion.div
                        key={s.ts}
                        initial={{ opacity: 0, x: 6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.14, delay: i * 0.02 }}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 9,
                          padding: "8px 10px",
                          background: s.success
                            ? (isLight ? "rgba(0,0,0,0.02)" : "rgba(255,255,255,0.03)")
                            : (isLight ? "rgba(239,68,68,0.08)" : "rgba(248,113,113,0.07)"),
                          border: s.success
                            ? (isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(255,255,255,0.06)")
                            : (isLight ? "1px solid rgba(239,68,68,0.25)" : "1px solid rgba(248,113,113,0.2)"),
                          borderRadius: 12,
                        }}
                      >
                        {/* Step number */}
                        <span style={{
                          flexShrink: 0, width: 20, height: 20,
                          borderRadius: "50%",
                          background: s.success ? "rgba(56,189,248,0.15)" : "rgba(248,113,113,0.15)",
                          border: s.success ? "1px solid rgba(56,189,248,0.3)" : "1px solid rgba(248,113,113,0.3)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 10.5, fontWeight: 900,
                          color: s.success ? "#38bdf8" : "#f87171",
                        }}>
                          {s.step_num}
                        </span>

                        {/* Content */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {s.thought && (
                            <p style={{
                              color: isLight ? "#111827" : "rgba(255,255,255,0.75)", fontSize: 12.5, fontWeight: 600,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              marginBottom: 1.5,
                            }}>
                              {s.thought}
                            </p>
                          )}
                          {s.description && s.description !== s.thought && (
                            <p style={{
                              color: s.success ? (isLight ? "#4b5563" : "rgba(255,255,255,0.45)") : "#f87171",
                              fontSize: 11, lineHeight: 1.4,
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
                            display: "flex", alignItems: "center", gap: 4,
                            padding: "3px 6px",
                            background: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)",
                            border: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(255,255,255,0.08)",
                            borderRadius: 7,
                            color: isLight ? "#4b5563" : "rgba(255,255,255,0.55)",
                            fontSize: 10, fontWeight: 700, textTransform: "uppercase",
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

          </div>{/* ── end scrollable activity region ── */}

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
                  padding: "14px 16px 16px",
                  borderTop: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(248,113,113,0.2)",
                }}>
                  <p style={{
                    color: "#f87171", fontSize: 11.5, fontWeight: 800,
                    textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7,
                  }}>
                    Permission Required
                  </p>
                  <p style={{
                    color: isLight ? "#111827" : "rgba(255,255,255,0.85)", fontSize: 13.5, lineHeight: 1.5,
                    wordBreak: "break-word", marginBottom: 10,
                  }}>
                    {permReq.description}
                  </p>
                  {permReq.tool && (
                    <span style={{
                      display: "inline-block", marginBottom: 12,
                      padding: "3px 10px",
                      background: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)",
                      border: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8, color: isLight ? "#4b5563" : "rgba(255,255,255,0.5)",
                      fontSize: 11, fontFamily: "monospace",
                    }}>
                      {permReq.tool} → {permReq.action}
                    </span>
                  )}
                  <div style={{ display: "flex", gap: 9 }}>
                    <button
                      onClick={() => handleApprove(false)}
                      style={{
                        flex: 1, padding: "9.5px 0",
                        background: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)",
                        border: isLight ? "1px solid rgba(0,0,0,0.12)" : "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 13, color: isLight ? "#4b5563" : "rgba(255,255,255,0.6)",
                        fontSize: 13, fontWeight: 800, cursor: "pointer",
                      }}
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => handleApprove(true)}
                      style={{
                        flex: 1, padding: "9.5px 0",
                        background: "linear-gradient(135deg, rgba(52,211,153,0.3), rgba(16,185,129,0.2))",
                        border: "1px solid rgba(52,211,153,0.4)",
                        borderRadius: 13, color: "#34d399",
                        fontSize: 13, fontWeight: 800, cursor: "pointer",
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
                  padding: "16px 16px 18px",
                  borderTop: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(56,189,248,0.2)",
                  background: isLight ? "linear-gradient(180deg, rgba(56,189,248,0.08), transparent)" : "linear-gradient(180deg, rgba(56,189,248,0.05), transparent)",
                }}>
                  {/* The question */}
                  <motion.p
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.08 }}
                    style={{
                      color: isLight ? "#111827" : "rgba(255,255,255,0.85)", fontSize: 14.5, fontWeight: 600,
                      lineHeight: 1.45, marginBottom: 12, wordBreak: "break-word",
                    }}
                  >
                    {question.question}
                  </motion.p>

                  {/* Chat input */}
                  {isDictating ? (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 14px",
                      background: "rgba(56,189,248,0.1)",
                      border: "1px solid rgba(56,189,248,0.25)",
                      borderRadius: 13,
                      marginBottom: 4,
                    }}>
                      <Mic size={15} style={{ color: "#38bdf8", animation: "ompulse 1.4s ease-in-out infinite" }} />
                      <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
                        <Waveform level={audioLevel} />
                        <span style={{ color: isLight ? "#374151" : "rgba(255,255,255,0.6)", fontSize: 12, marginLeft: 10, fontWeight: 600 }}>Listening to voice answer...</span>
                      </div>
                      <button
                        onClick={toggleMicDictation}
                        style={{
                          background: "rgba(248, 113, 113, 0.15)",
                          border: "1px solid rgba(248, 113, 113, 0.3)",
                          color: "#f87171",
                          borderRadius: 8,
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "4px 8px",
                          cursor: "pointer"
                        }}
                      >
                        Stop
                      </button>
                    </div>
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.12 }}
                      style={{ position: "relative", display: "flex", gap: 9 }}
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
                          background: isLight ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.06)",
                          border: isLight ? "1px solid rgba(56,189,248,0.5)" : "1px solid rgba(56,189,248,0.3)",
                          borderRadius: 13,
                          padding: "11px 14px",
                          color: isLight ? "#111827" : "#f4f4f5",
                          fontSize: 14,
                          outline: "none",
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        onClick={toggleMicDictation}
                        title="Dictate answer"
                        style={{
                          flexShrink: 0,
                          width: 44,
                          background: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)",
                          border: isLight ? "1px solid rgba(0,0,0,0.1)" : "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 13,
                          color: isLight ? "#4b5563" : "rgba(255,255,255,0.6)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        <Mic size={16} />
                      </button>
                      <button
                        onClick={handleSubmitAnswer}
                        disabled={!answer.trim()}
                        style={{
                          flexShrink: 0,
                          padding: "0 18px",
                          background: answer.trim()
                            ? "linear-gradient(135deg, rgba(56,189,248,0.4), rgba(14,165,233,0.3))"
                            : (isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)"),
                          border: `1px solid ${answer.trim() ? "rgba(56,189,248,0.5)" : (isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)")}`,
                          borderRadius: 13,
                          color: answer.trim() ? (isLight ? "#0369a1" : "#7dd3fc") : (isLight ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.3)"),
                          fontSize: 14, fontWeight: 800,
                          cursor: answer.trim() ? "pointer" : "default",
                        }}
                      >
                        Send
                      </button>
                    </motion.div>
                  )}
                  <p style={{ color: isLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 9 }}>
                    Press Enter to send · agent is paused
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Text input mode (morphs in smoothly) ───────────────────────── */}
          <AnimatePresence>
            {state === "text_input" && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.34, 1.1, 0.64, 1] }}
              >
                <div style={{
                  padding: "16px 16px 18px",
                  borderTop: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(129,140,248,0.2)",
                  background: isLight ? "linear-gradient(180deg, rgba(129,140,248,0.08), transparent)" : "linear-gradient(180deg, rgba(129,140,248,0.05), transparent)",
                }}>
                  {/* Chat input */}
                  {isDictating ? (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 14px",
                      background: "rgba(129,140,248,0.1)",
                      border: "1px solid rgba(129,140,248,0.25)",
                      borderRadius: 13,
                      marginBottom: 4,
                    }}>
                      <Mic size={15} style={{ color: "#818cf8", animation: "ompulse 1.4s ease-in-out infinite" }} />
                      <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
                        <Waveform level={audioLevel} />
                        <span style={{ color: isLight ? "#374151" : "rgba(255,255,255,0.6)", fontSize: 12, marginLeft: 10, fontWeight: 600 }}>Listening to command...</span>
                      </div>
                      <button
                        onClick={toggleMicDictation}
                        style={{
                          background: "rgba(248, 113, 113, 0.15)",
                          border: "1px solid rgba(248, 113, 113, 0.3)",
                          color: "#f87171",
                          borderRadius: 8,
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "4px 8px",
                          cursor: "pointer"
                        }}
                      >
                        Stop
                      </button>
                    </div>
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.08 }}
                      style={{ position: "relative", display: "flex", gap: 9 }}
                    >
                      <input
                        autoFocus
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); handleSendPrompt(); }
                        }}
                        placeholder="Tell Omni what to do…"
                        style={{
                          flex: 1,
                          background: isLight ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.06)",
                          border: isLight ? "1px solid rgba(129,140,248,0.5)" : "1px solid rgba(129,140,248,0.3)",
                          borderRadius: 13,
                          padding: "11px 14px",
                          color: isLight ? "#111827" : "#f4f4f5",
                          fontSize: 14,
                          outline: "none",
                          boxSizing: "border-box",
                        }}
                      />
                      <button
                        type="button"
                        onClick={toggleMicDictation}
                        title="Dictate command"
                        style={{
                          flexShrink: 0,
                          width: 44,
                          background: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)",
                          border: isLight ? "1px solid rgba(0,0,0,0.1)" : "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 13,
                          color: isLight ? "#4b5563" : "rgba(255,255,255,0.6)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        <Mic size={16} />
                      </button>
                      <button
                        onClick={handleSendPrompt}
                        disabled={!answer.trim()}
                        style={{
                          flexShrink: 0,
                          padding: "0 18px",
                          background: answer.trim()
                            ? "linear-gradient(135deg, rgba(129,140,248,0.4), rgba(99,102,241,0.3))"
                            : (isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.05)"),
                          border: `1px solid ${answer.trim() ? "rgba(129,140,248,0.5)" : (isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)")}`,
                          borderRadius: 13,
                          color: answer.trim() ? "#4f46e5" : "#a5b4fc",
                          fontSize: 14, fontWeight: 800,
                          cursor: answer.trim() ? "pointer" : "default",
                        }}
                      >
                        Run
                      </button>
                    </motion.div>
                  )}
                  <p style={{ color: isLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 9 }}>
                    Press Enter to run · Esc to close
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
                  padding: "12px 16px 14px",
                  borderTop: isLight ? "1px solid rgba(0,0,0,0.08)" : "1px solid rgba(52,211,153,0.15)",
                }}>
                  <p style={{
                    color: isLight ? "#1f2937" : "rgba(255,255,255,0.6)", fontSize: 12.5,
                    lineHeight: 1.5, wordBreak: "break-word",
                  }}>
                    {headerText}
                  </p>
                  <p style={{ color: isLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 5 }}>
                    Auto-closing in 4s…
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Bottom glow accent ─────────────────────────────────────────── */}
          <div style={{
            height: 3,
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
      .omni-scroll::-webkit-scrollbar { width: 6px; }
      .omni-scroll::-webkit-scrollbar-track { background: transparent; }
      .omni-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
      .omni-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
    `;
    document.head.appendChild(s);
  }
}
