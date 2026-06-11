/**
 * FloatingOverlay — dynamic top-right agent status card
 *
 * • Fully dynamic height — expands/contracts to exactly fit content, zero manual math
 * • Framer-motion layout animations — content slides in/out smoothly
 * • Live waveform during listening, spinner states for thinking/working
 * • Step history grows as the agent works, collapses when done
 * • Single card, no dashboard. Ctrl+Shift+O toggles visibility.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  Mic, Loader2, CheckCircle2, AlertCircle, X, Square, Minus,
  ShieldAlert, ChevronDown, ChevronUp, Send, Brain,
  MousePointer2, Keyboard, Eye, FileText, Clipboard, Zap, Globe,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Phase =
  | "idle" | "listening" | "thinking" | "working"
  | "approval" | "question" | "success" | "error" | "text_input";

interface Step {
  step_num: number;
  thought: string;
  tool: string | null;
  description: string;
  success: boolean;
  ts: number;
}

interface PermReq {
  id: string; tool: string; action: string; description: string; preview: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Animated mic waveform — 11 bars, responds to live audio level */
const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const shape = [0.3, 0.55, 0.75, 0.92, 1, 1, 1, 0.92, 0.75, 0.55, 0.3];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height: 28 }}>
      {shape.map((s, i) => {
        const h = Math.max(4, Math.min(26, 4 + lvl * 22 * s));
        return (
          <span
            key={i}
            className="omni-wavebar"
            style={{
              width: 3, height: h, borderRadius: 3,
              background: "linear-gradient(180deg,#a78bfa,#38bdf8)",
              transition: "height 70ms cubic-bezier(.4,0,.2,1)",
              animationDelay: `${i * 0.08}s`,
              animationDuration: lvl > 0.08 ? "0.45s" : "1.1s",
            }}
          />
        );
      })}
    </div>
  );
};

/** Tool icon for step badge */
const ToolIcon: React.FC<{ tool: string | null }> = ({ tool }) => {
  if (!tool) return <Zap size={10} />;
  const t = tool.toLowerCase();
  if (t === "mouse")     return <MousePointer2 size={10} />;
  if (t === "keyboard")  return <Keyboard size={10} />;
  if (t === "screen")    return <Eye size={10} />;
  if (t === "app")       return <Brain size={10} />;
  if (t === "file")      return <FileText size={10} />;
  if (t === "clipboard") return <Clipboard size={10} />;
  if (t === "web")       return <Globe size={10} />;
  return <Zap size={10} />;
};

// ─────────────────────────────────────────────────────────────────────────────
// Window helpers
// ─────────────────────────────────────────────────────────────────────────────

const win = () => getCurrentWindow();
const hideWin = async () => { try { await win().hide(); } catch (_) {} };

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export const FloatingOverlay: React.FC = () => {
  const { theme } = useStore();
  const dark = theme !== "light";

  // ── State ──────────────────────────────────────────────────────────────────
  const [phase, setPhase]         = useState<Phase>("idle");
  const [header, setHeader]       = useState("");
  const [heard, setHeard]         = useState("");
  const [steps, setSteps]         = useState<Step[]>([]);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [permReq, setPermReq]     = useState<PermReq | null>(null);
  const [question, setQuestion]   = useState<{ id: string; question: string } | null>(null);
  const [answer, setAnswer]       = useState("");
  const [audioLvl, setAudioLvl]   = useState(0);
  const [controlling, setControlling] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [maxH, setMaxH]           = useState(800);

  // Refs for stale-closure–safe access inside listeners
  const phaseRef      = useRef(phase);
  const answerRef     = useRef(answer);
  const isDictRef     = useRef(isDictating);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { answerRef.current = answer; }, [answer]);
  useEffect(() => { isDictRef.current = isDictating; }, [isDictating]);

  // Card ref for ResizeObserver
  const cardRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Monitor size ────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const m = await primaryMonitor();
        const sc = await win().scaleFactor();
        if (m) setMaxH(Math.max(300, Math.floor(m.size.height / sc - 80)));
      } catch (_) {}
    })();
  }, []);

  // ── Transparent background ──────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  // ── Auto-resize window to card content ─────────────────────────────────────
  useEffect(() => {
    if (phase === "idle") { hideWin(); return; }
    const card = cardRef.current;
    if (!card) return;
    const obs = new ResizeObserver(() => {
      const h = Math.ceil(card.getBoundingClientRect().height + 12);
      try { win().setSize(new LogicalSize(420, Math.min(h, maxH))); } catch (_) {}
    });
    obs.observe(card);
    // Fire once immediately
    const h0 = Math.ceil(card.getBoundingClientRect().height + 12);
    try { win().setSize(new LogicalSize(420, Math.min(h0, maxH))); } catch (_) {}
    return () => obs.disconnect();
  }, [phase, steps, maxH]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const clearTimer = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  const schedHide = (ms: number) => {
    clearTimer();
    hideTimer.current = setTimeout(async () => {
      setPhase("idle"); setSteps([]); setHeard("");
      await hideWin();
    }, ms);
  };
  const show = async () => { clearTimer(); await win().show(); };

  const addStep = useCallback((entry: Step) => {
    setSteps(prev => {
      const idx = prev.findIndex(s => s.step_num === entry.step_num);
      if (idx >= 0) { const n = [...prev]; n[idx] = entry; return n.slice(-30); }
      return [...prev, entry].slice(-30);
    });
  }, []);

  // ── Polling fallback ─────────────────────────────────────────────────────────
  const lastSeq = useRef(-1);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<any>("get_live_state");
        if (!alive || !s || s.seq === lastSeq.current) return;
        lastSeq.current = s.seq;
        const p = s.phase as string;
        if (p === "idle") { setPhase(prev => (prev === "question" || prev === "approval") ? prev : "idle"); return; }
        await show();
        if (s.heard) setHeard(s.heard);
        if (Array.isArray(s.steps)) {
          setSteps(s.steps.map((st: any) => ({
            step_num: st.step_num ?? 0, thought: st.thought ?? "",
            tool: st.tool ?? null, description: st.description ?? "",
            success: st.success !== false, ts: st.step_num ?? 0,
          })));
        }
        if      (p === "listening") { setPhase("listening"); setHeader(s.header || "Listening…"); }
        else if (p === "thinking")  { setPhase("thinking");  setHeader(s.header || "Planning…"); }
        else if (p === "working")   { setPhase("working");   setHeader(s.header || "Working…"); }
        else if (p === "success")   { setPhase("success");   setHeader(s.header || "Done."); schedHide(20000); }
        else if (p === "error")     { setPhase("error");     setHeader(s.header || "Failed."); schedHide(20000); }
        else if (p === "question" && s.question) {
          setQuestion({ id: s.question_id, question: s.question }); setPhase("question");
        }
      } catch (_) {}
    };
    const id = setInterval(tick, 300);
    tick();
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ── Event listeners ──────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const subs: Array<() => void> = [];
    const on = async (evt: string, cb: (...a: any[]) => void) => {
      const u = await listen(evt, cb);
      if (alive) subs.push(u); else u();
    };

    (async () => {
      await on("hotkey:mic_start", async () => {
        await show();
        if (phaseRef.current === "question" || phaseRef.current === "text_input") {
          setIsDictating(true);
        } else {
          setIsDictating(false); setPhase("listening");
          setHeader("Listening…"); setHeard(""); setSteps([]);
        }
      });

      await on("voice:level",      (e: any) => setAudioLvl(typeof e.payload === "number" ? e.payload : 0));
      await on("takeover:started", () => setControlling(true));
      await on("takeover:ended",   () => setControlling(false));

      await on("voice:test_result", async () => {
        setIsDictating(false); setPhase("idle"); setHeard(""); await hideWin();
      });

      await on("hotkey:mic_stop", () => {
        if (phaseRef.current !== "question" && phaseRef.current !== "text_input") {
          setPhase("thinking"); setHeader("Transcribing…");
        }
      });

      await on("voice:transcript", async (e: any) => {
        await show();
        const said = (e.payload?.text || "").trim();
        if (phaseRef.current === "question" || phaseRef.current === "text_input") {
          setAnswer(said); setIsDictating(false);
        } else {
          setHeard(said); setPhase("thinking"); setHeader("Understood — starting…"); setSteps([]);
        }
      });

      await on("task:started", async (e: any) => {
        await show();
        const instr = (e.payload?.instruction || "").trim();
        if (instr) setHeard(instr);
        setPhase("thinking"); setHeader("Planning…"); setSteps([]); setStepsOpen(true);
      });

      await on("task:step", async (e: any) => {
        await show(); setPhase("working");
        const entry: Step = {
          step_num: e.payload.step_num ?? 0, thought: e.payload.thought ?? "",
          tool: e.payload.tool ?? null, description: e.payload.description ?? "",
          success: e.payload.success !== false, ts: Date.now(),
        };
        addStep(entry);
        setHeader(entry.thought || entry.description || "Working…");
      });

      await on("permission:request", async (e: any) => {
        await show(); await win().setFocus(); setPhase("approval"); setPermReq(e.payload);
      });

      await on("question:request", async (e: any) => {
        await show(); await win().setFocus();
        setQuestion(e.payload); setAnswer(""); setPhase("question");
      });

      await on("hotkey:text_mode", async () => {
        await show(); await win().setFocus();
        setPhase("text_input"); setHeard(""); setSteps([]); setAnswer("");
      });

      await on("task:done", async (e: any) => {
        setIsDictating(false); setPhase("success");
        setHeader(e.payload?.result || "Task completed."); schedHide(20000);
      });

      await on("task:failed", async (e: any) => {
        setIsDictating(false); setPhase("error");
        setHeader(e.payload?.error || "Task failed."); schedHide(20000);
      });

      await on("agent:killed", async () => {
        setIsDictating(false); setPhase("idle"); setSteps([]); setHeard(""); await hideWin();
      });
    })();

    return () => { alive = false; subs.forEach(u => u()); clearTimer(); };
  }, [addStep]);

  // ── Escape key ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (isDictRef.current) { try { await invoke("trigger_mic_stop"); } catch (_) {} setIsDictating(false); return; }
      if (phase === "listening") { try { await invoke("trigger_mic_stop"); } catch (_) {} setPhase("idle"); await hideWin(); }
      else if (phase === "working" || phase === "thinking") { try { await invoke("cancel_task"); } catch (_) {} setPhase("idle"); setSteps([]); await hideWin(); }
      else { setPhase("idle"); setSteps([]); setHeard(""); setAnswer(""); await hideWin(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleApprove = async (ok: boolean) => {
    if (!permReq) return;
    await invoke("approve_request", { id: permReq.id, approved: ok }).catch(() => {});
    setPermReq(null); setPhase("working"); setHeader("Resuming…");
  };

  const handleAnswer = async () => {
    if (!question || !answer.trim()) return;
    await invoke("answer_question", { id: question.id, answer: answer.trim() }).catch(() => {});
    setQuestion(null); setAnswer(""); setPhase("working"); setHeader("Got it, continuing…");
  };

  const handleSend = async () => {
    const p = answer.trim(); if (!p) return;
    setHeard(p); setPhase("thinking"); setHeader("Planning…"); setSteps([]); setAnswer("");
    await invoke("run_task", { instruction: p, userId: "" }).catch(console.error);
  };

  const handleMicToggle = async () => {
    if (isDictRef.current) { try { await invoke("trigger_mic_stop"); } catch (_) {} setIsDictating(false); }
    else { setIsDictating(true); try { await invoke("trigger_mic_start"); } catch (_) {} }
  };

  // ── Nothing to show ──────────────────────────────────────────────────────────
  if (phase === "idle") return null;

  // ── Theme tokens ─────────────────────────────────────────────────────────────
  const bg      = dark ? "rgba(12,12,18,0.82)"       : "rgba(255,255,255,0.92)";
  const border  = dark ? "rgba(255,255,255,0.10)"    : "rgba(0,0,0,0.12)";
  const txt     = dark ? "rgba(255,255,255,0.88)"    : "#111827";
  const txtSec  = dark ? "rgba(255,255,255,0.50)"    : "#4b5563";
  const divider = dark ? "rgba(255,255,255,0.06)"    : "rgba(0,0,0,0.07)";

  // ── Phase config ─────────────────────────────────────────────────────────────
  const PC: Record<Phase, { color: string; bg: string; border: string; label: string; icon: React.ReactNode }> = {
    idle:       { color:"#6b7280", bg:"transparent",              border:"transparent",         label:"",         icon:null },
    listening:  { color:"#a78bfa", bg:"rgba(167,139,250,0.14)",   border:"rgba(167,139,250,0.28)", label:"Listening", icon:<Mic size={14}/> },
    thinking:   { color:"#818CF8", bg:"rgba(129,140,248,0.14)",   border:"rgba(129,140,248,0.28)", label:"Thinking",  icon:<Loader2 size={14} className="animate-spin"/> },
    working:    { color:"#38bdf8", bg:"rgba(56,189,248,0.14)",    border:"rgba(56,189,248,0.28)",  label:"Working",   icon:<Loader2 size={14} className="animate-spin"/> },
    approval:   { color:"#f87171", bg:"rgba(248,113,113,0.14)",   border:"rgba(248,113,113,0.30)", label:"Approval",  icon:<ShieldAlert size={14}/> },
    question:   { color:"#38bdf8", bg:"rgba(56,189,248,0.14)",    border:"rgba(56,189,248,0.30)",  label:"Question",  icon:<Mic size={14}/> },
    text_input: { color:"#818CF8", bg:"rgba(129,140,248,0.14)",   border:"rgba(129,140,248,0.30)", label:"Command",   icon:<Brain size={14}/> },
    success:    { color:"#34d399", bg:"rgba(52,211,153,0.14)",    border:"rgba(52,211,153,0.28)",  label:"Done",      icon:<CheckCircle2 size={14}/> },
    error:      { color:"#f87171", bg:"rgba(248,113,113,0.14)",   border:"rgba(248,113,113,0.28)", label:"Error",     icon:<AlertCircle size={14}/> },
  };
  const pc = PC[phase];

  // Steps visible: all while working, last 3 on success/error
  const visSteps = (phase === "success" || phase === "error")
    ? (stepsOpen ? steps : steps.slice(-2))
    : (stepsOpen ? steps : steps.slice(-4));

  return (
    <div style={{ width: 420, padding: "6px 6px 6px 6px", boxSizing: "border-box", background: "transparent" }}>
      <LayoutGroup>
        <motion.div
          ref={cardRef}
          layout
          initial={{ opacity: 0, y: -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          style={{
            background: bg,
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            border: `1px solid ${border}`,
            borderRadius: 18,
            boxShadow: dark
              ? "0 16px 48px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)"
              : "0 12px 40px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9)",
            overflow: "hidden",
          }}
        >

          {/* ── Agent-controlling banner ──────────────────────────────────── */}
          <AnimatePresence>
            {controlling && (
              <motion.div layout initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                style={{
                  display:"flex", alignItems:"center", gap:8, padding:"7px 14px",
                  background:"linear-gradient(135deg,rgba(248,113,113,0.18),rgba(168,85,247,0.10))",
                  borderBottom:`1px solid rgba(248,113,113,0.22)`,
                }}>
                <span style={{ width:6,height:6,borderRadius:"50%",background:"#f87171",boxShadow:"0 0 6px #f87171",animation:"ompulse 1.4s ease-in-out infinite" }}/>
                <span style={{ color:"#fca5a5",fontSize:10.5,fontWeight:700,flex:1 }}>Agent controlling your PC</span>
                <span style={{ color:txtSec,fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:5,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.10)" }}>Esc Esc to stop</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Header ────────────────────────────────────────────────────── */}
          <motion.div layout style={{ padding:"13px 14px 10px", display:"flex", alignItems:"center", gap:10 }}>

            {/* Status pill */}
            <motion.div layout
              style={{
                display:"flex",alignItems:"center",gap:6,
                padding:"4px 10px 4px 8px",
                background:pc.bg, border:`1px solid ${pc.border}`, borderRadius:99,
                flexShrink:0,
              }}>
              <span style={{ color:pc.color, display:"flex", alignItems:"center" }}>{pc.icon}</span>
              <span style={{ color:pc.color, fontSize:11.5, fontWeight:800, letterSpacing:"0.04em" }}>{pc.label}</span>
            </motion.div>

            {/* Waveform (listening) OR header text */}
            <div style={{ flex:1, minWidth:0, display:"flex", alignItems:"center" }}>
              {phase === "listening" ? (
                <Waveform level={audioLvl} />
              ) : (
                <motion.p layout
                  key={header}
                  initial={{ opacity:0, y:3 }}
                  animate={{ opacity:1, y:0 }}
                  transition={{ duration:0.15 }}
                  style={{ color:txt, fontSize:13, fontWeight:600, lineHeight:1.4,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    margin:0,
                  }}>
                  {header}
                </motion.p>
              )}
            </div>

            {/* Controls */}
            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
              <button onClick={hideWin} title="Hide (Ctrl+Shift+O)"
                style={{ padding:"4px 7px", background:"rgba(255,255,255,0.06)", border:`1px solid ${border}`,
                  borderRadius:8, color:txtSec, cursor:"pointer", display:"flex", alignItems:"center" }}>
                <Minus size={12}/>
              </button>
              {(phase === "working" || phase === "thinking") && (
                <button onClick={async () => { await invoke("cancel_task").catch(()=>{}); setPhase("idle"); setSteps([]); await hideWin(); }}
                  style={{ display:"flex",alignItems:"center",gap:4, padding:"4px 9px",
                    background:"rgba(248,113,113,0.14)", border:"1px solid rgba(248,113,113,0.28)",
                    borderRadius:8, color:"#f87171", fontSize:11.5, fontWeight:800, cursor:"pointer" }}>
                  <Square size={9} fill="#f87171"/> Stop
                </button>
              )}
              {(phase === "success" || phase === "error") && (
                <button onClick={async () => { setPhase("idle"); setSteps([]); await hideWin(); }}
                  style={{ padding:"4px 7px", background:"rgba(255,255,255,0.06)", border:`1px solid ${border}`,
                    borderRadius:8, color:txtSec, cursor:"pointer", display:"flex", alignItems:"center" }}>
                  <X size={11}/>
                </button>
              )}
            </div>
          </motion.div>

          {/* ── "You said" bubble ─────────────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {heard && (phase === "thinking" || phase === "working" || phase === "success" || phase === "error" || phase === "question" || phase === "approval") && (
              <motion.div layout
                initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:"auto" }}
                exit={{ opacity:0, height:0 }} transition={{ duration:0.16 }}>
                <div style={{ padding:"0 12px 10px" }}>
                  <div style={{
                    display:"flex", alignItems:"flex-start", gap:9,
                    padding:"9px 12px",
                    background: dark
                      ? "linear-gradient(135deg,rgba(56,189,248,0.08),rgba(129,140,248,0.05))"
                      : "linear-gradient(135deg,rgba(56,189,248,0.12),rgba(129,140,248,0.07))",
                    border: dark ? "1px solid rgba(56,189,248,0.18)" : "1px solid rgba(56,189,248,0.28)",
                    borderRadius:12,
                  }}>
                    <Mic size={13} style={{ color:"#38bdf8", flexShrink:0, marginTop:2 }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <p style={{ color:"rgba(56,189,248,0.7)", fontSize:9.5, fontWeight:800, textTransform:"uppercase", letterSpacing:"0.07em", margin:"0 0 3px" }}>You said</p>
                      <p style={{ color:txt, fontSize:13.5, fontWeight:500, lineHeight:1.45, margin:0, wordBreak:"break-word" }}>{heard}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Step log ──────────────────────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {steps.length > 0 && (
              <motion.div layout
                initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:"auto" }}
                exit={{ opacity:0, height:0 }} transition={{ duration:0.18 }}>
                <div style={{ borderTop:`1px solid ${divider}`, padding:"6px 12px 8px" }}>

                  {/* Collapse/expand toggle */}
                  <button onClick={() => setStepsOpen(v => !v)}
                    style={{
                      width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"4px 2px 5px", background:"transparent", border:"none",
                      color:txtSec, fontSize:10.5, fontWeight:700, cursor:"pointer",
                      letterSpacing:"0.04em", textTransform:"uppercase",
                    }}>
                    <span>Steps ({steps.length})</span>
                    {stepsOpen ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
                  </button>

                  {/* Step rows */}
                  <AnimatePresence initial={false}>
                    {stepsOpen && (
                      <motion.div layout
                        initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:"auto" }}
                        exit={{ opacity:0, height:0 }} transition={{ duration:0.16 }}>
                        <div style={{ display:"flex", flexDirection:"column", gap:4, paddingTop:2 }}>
                          {visSteps.map((s, i) => (
                            <motion.div key={`${s.step_num}-${s.ts}`} layout
                              initial={{ opacity:0, x:5 }} animate={{ opacity:1, x:0 }}
                              transition={{ duration:0.12, delay: i * 0.015 }}
                              style={{
                                display:"flex", alignItems:"flex-start", gap:8, padding:"7px 9px",
                                background: s.success
                                  ? (dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.025)")
                                  : (dark ? "rgba(248,113,113,0.07)" : "rgba(239,68,68,0.07)"),
                                border: s.success
                                  ? `1px solid ${divider}`
                                  : "1px solid rgba(248,113,113,0.22)",
                                borderRadius:10,
                              }}>
                              {/* Step number */}
                              <span style={{
                                flexShrink:0, width:18, height:18, borderRadius:"50%",
                                background: s.success ? "rgba(56,189,248,0.12)" : "rgba(248,113,113,0.12)",
                                border: s.success ? "1px solid rgba(56,189,248,0.25)" : "1px solid rgba(248,113,113,0.25)",
                                display:"flex", alignItems:"center", justifyContent:"center",
                                fontSize:9.5, fontWeight:900,
                                color: s.success ? "#38bdf8" : "#f87171",
                              }}>{s.step_num}</span>

                              {/* Text */}
                              <div style={{ flex:1, minWidth:0 }}>
                                {s.thought && (
                                  <p style={{ color:txt, fontSize:12, fontWeight:600, margin:"0 0 1.5px",
                                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                    {s.thought}
                                  </p>
                                )}
                                {s.description && s.description !== s.thought && (
                                  <p style={{
                                    color: s.success ? txtSec : "#f87171",
                                    fontSize:10.5, lineHeight:1.4, margin:0,
                                    overflow:"hidden", textOverflow:"ellipsis",
                                    display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical",
                                  }}>{s.description}</p>
                                )}
                              </div>

                              {/* Tool badge */}
                              {s.tool && (
                                <span style={{
                                  flexShrink:0, display:"flex", alignItems:"center", gap:3,
                                  padding:"2px 5px",
                                  background: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)",
                                  border:`1px solid ${divider}`, borderRadius:6,
                                  color:txtSec, fontSize:9, fontWeight:700, textTransform:"uppercase",
                                }}>
                                  <ToolIcon tool={s.tool}/>{s.tool}
                                </span>
                              )}
                            </motion.div>
                          ))}

                          {/* Show-more if collapsed */}
                          {!stepsOpen && steps.length > visSteps.length && (
                            <button onClick={() => setStepsOpen(true)}
                              style={{ background:"transparent", border:"none", color:txtSec,
                                fontSize:10.5, fontWeight:700, cursor:"pointer", padding:"2px 0", textAlign:"left" }}>
                              + {steps.length - visSteps.length} more…
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Approval dialog ────────────────────────────────────────────── */}
          <AnimatePresence>
            {phase === "approval" && permReq && (
              <motion.div layout initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:"auto" }} exit={{ opacity:0, height:0 }} transition={{ duration:0.16 }}>
                <div style={{ padding:"12px 14px 14px", borderTop:`1px solid rgba(248,113,113,0.18)` }}>
                  <p style={{ color:"#f87171", fontSize:10.5, fontWeight:800, textTransform:"uppercase", letterSpacing:"0.07em", margin:"0 0 6px" }}>Permission Required</p>
                  <p style={{ color:txt, fontSize:13, lineHeight:1.5, margin:"0 0 12px" }}>{permReq.description}</p>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={() => handleApprove(false)}
                      style={{ flex:1, padding:"9px", background:"rgba(255,255,255,0.05)", border:`1px solid ${border}`,
                        borderRadius:10, color:txtSec, fontSize:12, fontWeight:700, cursor:"pointer" }}>
                      Deny
                    </button>
                    <button onClick={() => handleApprove(true)}
                      style={{ flex:1, padding:"9px", background:"rgba(52,211,153,0.15)", border:"1px solid rgba(52,211,153,0.28)",
                        borderRadius:10, color:"#34d399", fontSize:12, fontWeight:800, cursor:"pointer" }}>
                      Approve
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Question / text_input ──────────────────────────────────────── */}
          <AnimatePresence>
            {(phase === "question" || phase === "text_input") && (
              <motion.div layout initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:"auto" }} exit={{ opacity:0, height:0 }} transition={{ duration:0.16 }}>
                <div style={{ padding:"10px 12px 12px", borderTop:`1px solid ${divider}` }}>
                  {phase === "question" && question && (
                    <p style={{ color:txt, fontSize:13, lineHeight:1.5, margin:"0 0 8px" }}>{question.question}</p>
                  )}
                  <div style={{ display:"flex", gap:7, alignItems:"flex-end" }}>
                    <textarea
                      value={answer}
                      onChange={e => setAnswer(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); phase === "question" ? handleAnswer() : handleSend(); } }}
                      placeholder={phase === "question" ? "Type your answer…" : "Type a command…"}
                      rows={1}
                      style={{
                        flex:1, padding:"9px 12px", resize:"none",
                        background: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                        border:`1px solid ${border}`, borderRadius:11,
                        color:txt, fontSize:13, lineHeight:1.4,
                        outline:"none", fontFamily:"inherit",
                        maxHeight:100, overflowY:"auto",
                      }}
                      autoFocus
                    />
                    {/* Mic button for dictation */}
                    <button onClick={handleMicToggle}
                      style={{
                        padding:"9px 10px", flexShrink:0,
                        background: isDictating ? "rgba(167,139,250,0.18)" : "rgba(255,255,255,0.06)",
                        border: isDictating ? "1px solid rgba(167,139,250,0.30)" : `1px solid ${border}`,
                        borderRadius:11, color: isDictating ? "#a78bfa" : txtSec,
                        cursor:"pointer", display:"flex", alignItems:"center",
                      }}>
                      <Mic size={14}/>
                    </button>
                    <button onClick={phase === "question" ? handleAnswer : handleSend}
                      style={{
                        padding:"9px 11px", flexShrink:0,
                        background:"rgba(129,140,248,0.18)", border:"1px solid rgba(129,140,248,0.28)",
                        borderRadius:11, color:"#818CF8",
                        cursor:"pointer", display:"flex", alignItems:"center",
                      }}>
                      <Send size={13}/>
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </motion.div>
      </LayoutGroup>
    </div>
  );
};
