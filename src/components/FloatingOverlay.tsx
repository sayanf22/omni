/**
 * FloatingOverlay — Liquid Glass Agent Card
 *
 * Design: heavy native Acrylic blur (set by Tauri on the window itself) +
 * CSS glassmorphism card with distortion shimmer. Fully dynamic — the Tauri
 * window resizes to EXACTLY fit content via ResizeObserver.
 *
 * Morphs into an input box when the AI needs a prompt/question answered.
 * Works even when the dashboard is closed (separate Tauri window).
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, X, Square,
  Send, Brain, MousePointer2, Keyboard,
  Eye, FileText, Clipboard, Zap, Globe, ChevronDown, ChevronUp,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────
type Phase = "idle"|"listening"|"thinking"|"working"|"approval"|"question"|"success"|"error"|"text_input";
interface Step { step_num:number; thought:string; tool:string|null; description:string; success:boolean; ts:number; }
interface PermReq { id:string; tool:string; action:string; description:string; preview:string|null; }

// ─── Live Waveform Bars ─────────────────────────────────────────────────────
const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const shape = [0.25, 0.5, 0.7, 0.9, 1, 1, 1, 0.9, 0.7, 0.5, 0.25];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display:"flex", alignItems:"center", gap:3, height:28 }}>
      {shape.map((s, i) => {
        const h = Math.max(3, Math.min(24, 3 + lvl * 21 * s));
        return (
          <span key={i} style={{
            display:"block", width:3, height:h, borderRadius:4,
            background: lvl > 0.1
              ? "linear-gradient(180deg,rgba(196,181,253,0.95),rgba(56,189,248,0.85))"
              : "rgba(255,255,255,0.2)",
            transition: "height 55ms cubic-bezier(.4,0,.2,1), background 200ms ease",
            flexShrink: 0,
          }}/>
        );
      })}
    </div>
  );
};

// ─── Tool Icon ─────────────────────────────────────────────────────────────────
const TIcon: React.FC<{t:string|null}> = ({t}) => {
  if (!t) return <Zap size={9}/>;
  const s = t.toLowerCase();
  if (s==="mouse")     return <MousePointer2 size={9}/>;
  if (s==="keyboard")  return <Keyboard size={9}/>;
  if (s==="screen")    return <Eye size={9}/>;
  if (s==="app")       return <Brain size={9}/>;
  if (s==="file")      return <FileText size={9}/>;
  if (s==="clipboard") return <Clipboard size={9}/>;
  if (s==="web")       return <Globe size={9}/>;
  return <Zap size={9}/>;
};

const win = () => getCurrentWindow();
const hideWin = async () => { try { await win().hide(); } catch(_){} };

// ─── Distortion shimmer overlay (liquid-glass effect) ──────────────────────
const GlassDistortion: React.FC = () => (
  <svg width="0" height="0" style={{position:"absolute"}}>
    <defs>
      <filter id="liquid-distort" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.65 0.45" numOctaves="3" seed="7" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>
  </svg>
);

// ─── Phase colour map ───────────────────────────────────────────────────────
const phaseColors = {
  idle:       { dot:"transparent", glow:"transparent",          ring:"transparent",           label:"" },
  listening:  { dot:"#c4b5fd",     glow:"rgba(196,181,253,.5)", ring:"rgba(196,181,253,.35)", label:"Listening" },
  thinking:   { dot:"#818cf8",     glow:"rgba(129,140,248,.5)", ring:"rgba(129,140,248,.35)", label:"Thinking" },
  working:    { dot:"#38bdf8",     glow:"rgba(56,189,248,.5)",  ring:"rgba(56,189,248,.35)",  label:"Working" },
  approval:   { dot:"#f87171",     glow:"rgba(248,113,113,.5)", ring:"rgba(248,113,113,.35)", label:"Approval" },
  question:   { dot:"#38bdf8",     glow:"rgba(56,189,248,.5)",  ring:"rgba(56,189,248,.35)",  label:"Question" },
  text_input: { dot:"#818cf8",     glow:"rgba(129,140,248,.5)", ring:"rgba(129,140,248,.35)", label:"Command" },
  success:    { dot:"#34d399",     glow:"rgba(52,211,153,.5)",  ring:"rgba(52,211,153,.35)",  label:"Done" },
  error:      { dot:"#f87171",     glow:"rgba(248,113,113,.5)", ring:"rgba(248,113,113,.35)", label:"Error" },
};

// ─── Main ───────────────────────────────────────────────────────────────────
export const FloatingOverlay: React.FC = () => {
  const { theme } = useStore();
  // theme drives future light-mode support; dark is used for future theming
  void theme;

  const [phase, setPhase]         = useState<Phase>("idle");
  const [header, setHeader]       = useState("");
  const [heard, setHeard]         = useState("");
  const [steps, setSteps]         = useState<Step[]>([]);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [permReq, setPermReq]     = useState<PermReq|null>(null);
  const [question, setQuestion]   = useState<{id:string;question:string}|null>(null);
  const [answer, setAnswer]       = useState("");
  const [audioLvl, setAudioLvl]   = useState(0);
  const [controlling, setControlling] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [screenH, setScreenH]     = useState(900);

  const phaseRef  = useRef(phase);
  const isDictRef = useRef(isDictating);
  useEffect(() => { phaseRef.current  = phase; },      [phase]);
  useEffect(() => { isDictRef.current = isDictating; }, [isDictating]);

  const cardRef   = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastSeq   = useRef(-1);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  // ── screen height ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const m = await primaryMonitor();
        const sc = await win().scaleFactor();
        if (m) setScreenH(Math.floor(m.size.height / sc - 60));
      } catch(_){}
    })();
  }, []);

  // ── Force transparent window / body ───────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.cssText = "background:transparent!important;";
    document.body.style.cssText = "background:transparent!important;margin:0;overflow:hidden;";
  }, []);

  // ── DYNAMIC RESIZE ─────────────────────────────────────────────────────────
  const doResize = useCallback(() => {
    const card = cardRef.current;
    if (!card || phase === "idle") return;
    const h = Math.ceil(card.getBoundingClientRect().height + 16);
    const capped = Math.min(h, screenH);
    try { win().setSize(new LogicalSize(440, capped)); } catch(_){}
  }, [phase, screenH]);

  useEffect(() => {
    if (phase === "idle") { hideWin(); return; }
    const card = cardRef.current;
    if (!card) return;
    doResize();
    const obs = new ResizeObserver(doResize);
    obs.observe(card);
    // Also watch every child that might animate in
    card.querySelectorAll("*").forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, [phase, steps, stepsOpen, heard, header, doResize]);

  // Auto-focus answer input when card morphs to question/text_input
  useEffect(() => {
    if ((phase === "question" || phase === "text_input") && answerRef.current) {
      setTimeout(() => answerRef.current?.focus(), 80);
    }
  }, [phase]);

  // ── helpers ────────────────────────────────────────────────────────────────
  const clearT   = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  const schedHide = (ms: number) => {
    clearT();
    hideTimer.current = setTimeout(async () => {
      setPhase("idle"); setSteps([]); setHeard(""); await hideWin();
    }, ms);
  };
  const show = async () => { clearT(); await win().show(); };

  const addStep = useCallback((e: Step) => {
    setSteps(prev => {
      const idx = prev.findIndex(s => s.step_num === e.step_num);
      if (idx >= 0) { const n=[...prev]; n[idx]=e; return n.slice(-40); }
      return [...prev, e].slice(-40);
    });
  }, []);

  // ── Polling fallback ───────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<any>("get_live_state");
        if (!alive || !s || s.seq === lastSeq.current) return;
        lastSeq.current = s.seq;
        const p = s.phase as string;
        if (p === "idle") { setPhase(prev => (prev==="question"||prev==="approval") ? prev : "idle"); return; }
        await show();
        if (s.heard) setHeard(s.heard);
        if (Array.isArray(s.steps)) {
          setSteps(s.steps.map((st:any) => ({
            step_num: st.step_num??0, thought:st.thought??"",
            tool:st.tool??null, description:st.description??"",
            success:st.success!==false, ts:st.step_num??0,
          })));
        }
        if      (p==="listening") { setPhase("listening"); setHeader(s.header||"Listening…"); }
        else if (p==="thinking")  { setPhase("thinking");  setHeader(s.header||"Planning…"); }
        else if (p==="working")   { setPhase("working");   setHeader(s.header||"Working…"); }
        else if (p==="success")   { setPhase("success");   setHeader(s.header||"Done."); schedHide(25000); }
        else if (p==="error")     { setPhase("error");     setHeader(s.header||"Failed."); schedHide(25000); }
        else if (p==="question"&&s.question) {
          setQuestion({id:s.question_id, question:s.question}); setPhase("question");
        }
      } catch(_){}
    };
    const id = setInterval(tick, 280);
    tick();
    return () => { alive=false; clearInterval(id); };
  }, []);

  // ── Event listeners ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const subs: Array<()=>void> = [];
    const on = async (evt:string, cb:(...a:any[])=>void) => {
      const u = await listen(evt, cb);
      if (alive) subs.push(u); else u();
    };

    (async () => {
      await on("hotkey:mic_start", async () => {
        await show();
        if (phaseRef.current==="question"||phaseRef.current==="text_input") {
          setIsDictating(true);
        } else {
          setIsDictating(false); setPhase("listening");
          setHeader("Listening…"); setHeard(""); setSteps([]);
        }
      });

      await on("voice:level", (e:any) => setAudioLvl(typeof e.payload==="number" ? e.payload : 0));
      await on("takeover:started", () => setControlling(true));
      await on("takeover:ended",   () => setControlling(false));

      await on("voice:test_result", async () => {
        setIsDictating(false); setPhase("idle"); setHeard(""); await hideWin();
      });

      await on("hotkey:mic_stop", () => {
        if (phaseRef.current==="listening") {
          setPhase("thinking"); setHeader("Transcribing…");
        }
      });

      await on("wake:timeout", async () => {
        if (phaseRef.current==="listening") {
          setPhase("idle"); setHeard(""); await hideWin();
        }
      });

      // Wake word detected — show overlay in wake state
      await on("wake:detected", async () => {
        await show();
        setPhase("listening");
        setHeader("Hey Omni — say your command…");
        setHeard(""); setSteps([]);
      });

      await on("voice:transcript", async (e:any) => {
        await show();
        const said = (e.payload?.text||"").trim();
        if (phaseRef.current==="question"||phaseRef.current==="text_input") {
          setAnswer(said); setIsDictating(false);
        } else {
          setHeard(said); setPhase("thinking"); setHeader("Understood…"); setSteps([]);
        }
      });

      await on("task:started", async (e:any) => {
        await show();
        const instr = (e.payload?.instruction||"").trim();
        if (instr) setHeard(instr);
        setPhase("thinking"); setHeader("Planning…"); setSteps([]); setStepsOpen(true);
      });

      await on("task:step", async (e:any) => {
        await show(); setPhase("working");
        const entry: Step = {
          step_num:e.payload.step_num??0, thought:e.payload.thought??"",
          tool:e.payload.tool??null, description:e.payload.description??"",
          success:e.payload.success!==false, ts:Date.now(),
        };
        addStep(entry);
        setHeader(entry.thought||entry.description||"Working…");
      });

      await on("permission:request", async (e:any) => {
        await show(); await win().setFocus(); setPhase("approval"); setPermReq(e.payload);
      });

      await on("question:request", async (e:any) => {
        await show(); await win().setFocus();
        setQuestion(e.payload); setAnswer(""); setPhase("question");
      });

      await on("hotkey:text_mode", async () => {
        await show(); await win().setFocus();
        setPhase("text_input"); setHeard(""); setSteps([]); setAnswer("");
      });

      await on("task:done", async (e:any) => {
        setIsDictating(false); setPhase("success");
        setHeader(e.payload?.result||"Task completed."); schedHide(25000);
      });

      await on("task:failed", async (e:any) => {
        setIsDictating(false); setPhase("error");
        setHeader(e.payload?.error||"Task failed."); schedHide(25000);
      });

      await on("agent:killed", async () => {
        setIsDictating(false); setPhase("idle"); setSteps([]); setHeard(""); await hideWin();
      });
    })();

    return () => { alive=false; subs.forEach(u=>u()); clearT(); };
  }, [addStep]);

  // ── Escape key ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (isDictRef.current) { try { await invoke("trigger_mic_stop"); } catch(_){} setIsDictating(false); return; }
      if (phase==="listening") { try { await invoke("trigger_mic_stop"); } catch(_){} setPhase("idle"); await hideWin(); }
      else if (phase==="working"||phase==="thinking") { try { await invoke("cancel_task"); } catch(_){} setPhase("idle"); setSteps([]); await hideWin(); }
      else { setPhase("idle"); setSteps([]); setHeard(""); setAnswer(""); await hideWin(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // ── Action handlers ────────────────────────────────────────────────────────
  const approve = async (ok: boolean) => {
    if (!permReq) return;
    await invoke("approve_request", {id:permReq.id, approved:ok}).catch(()=>{});
    setPermReq(null); setPhase("working"); setHeader("Resuming…");
  };
  const submitAnswer = async () => {
    if (!question||!answer.trim()) return;
    await invoke("answer_question", {id:question.id, answer:answer.trim()}).catch(()=>{});
    setQuestion(null); setAnswer(""); setPhase("working"); setHeader("Got it…");
  };
  const sendPrompt = async () => {
    const p = answer.trim(); if (!p) return;
    setHeard(p); setPhase("thinking"); setHeader("Planning…"); setSteps([]); setAnswer("");
    await invoke("run_task", {instruction:p, userId:""}).catch(console.error);
  };
  const toggleMic = async () => {
    if (isDictRef.current) { try { await invoke("trigger_mic_stop"); } catch(_){} setIsDictating(false); }
    else { setIsDictating(true); try { await invoke("trigger_mic_start"); } catch(_){} }
  };

  if (phase === "idle") return null;

  // ── Design tokens ─────────────────────────────────────────────────────────
  const pc = phaseColors[phase];

  // Glassmorphism card — dark semi-transparent surface that lets native Acrylic
  // blur show through. The card itself has NO backdrop-filter (that's the window
  // layer). Inner shimmer adds the "liquid" depth.
  const cardBg  = "rgba(8, 8, 14, 0.55)";
  const cardBdr = "rgba(255,255,255,0.13)";
  const cardShadow = "0 8px 40px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.12) inset";

  const txt     = "rgba(255,255,255,0.92)";
  const txtSec  = "rgba(255,255,255,0.44)";
  const divBdr  = "rgba(255,255,255,0.07)";
  const rowBg   = "rgba(255,255,255,0.04)";

  const visSteps = stepsOpen ? steps : steps.slice(-5);

  // Morph to input card if question / text_input
  const isInputMode = phase === "question" || phase === "text_input";

  return (
    <>
      {/* SVG liquid-distortion filter (invisible) */}
      <GlassDistortion/>

      {/* Inert CSS keyframes */}
      <style>{`
        @keyframes omni-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes omni-glow  { 0%,100%{box-shadow:0 0 6px currentColor} 50%{box-shadow:0 0 14px currentColor} }
        @keyframes omni-spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        .omni-spin { animation: omni-spin 1s linear infinite; }
        .omni-pulse { animation: omni-pulse 1.8s ease-in-out infinite; }
      `}</style>

      {/* Outer wrapper — transparent, sets window width */}
      <div style={{ width:440, padding:"8px", boxSizing:"border-box", background:"transparent" }}>

        <motion.div
          ref={cardRef}
          key={isInputMode ? "input" : "status"}
          initial={{ opacity:0, y:-8, scale:0.97 }}
          animate={{ opacity:1, y:0, scale:1 }}
          exit={{ opacity:0, y:-6, scale:0.96 }}
          transition={{ type:"spring", stiffness:500, damping:36 }}
          style={{
            position:"relative",
            background: cardBg,
            border: `1px solid ${cardBdr}`,
            borderRadius: 20,
            boxShadow: cardShadow,
            overflow: "hidden",
            // The actual blur is applied at the NATIVE WINDOW level (Acrylic).
            // This div just provides the dark tinted overlay to make text legible.
          }}
        >
          {/* ── Liquid shimmer layer ─────────────────────────────────── */}
          <div style={{
            position:"absolute", inset:0, pointerEvents:"none", zIndex:0,
            background: `radial-gradient(ellipse 80% 50% at 50% -10%, rgba(${
              phase==="listening" ? "196,181,253" :
              phase==="success"   ? "52,211,153"  :
              phase==="error"     ? "248,113,113" :
              phase==="working"   ? "56,189,248"  :
                                   "129,140,248"
            },.12) 0%, transparent 70%)`,
            filter: "url(#liquid-distort)",
            borderRadius: 20,
          }}/>

          {/* ── Coloured top accent line ─────────────────────────────── */}
          <div style={{
            position:"absolute", top:0, left:0, right:0, height:2,
            background: `linear-gradient(90deg, transparent 0%, ${pc.dot} 40%, ${pc.dot} 60%, transparent 100%)`,
            opacity: (phase as string)==="idle" ? 0 : 0.8,
            borderRadius:"20px 20px 0 0",
            transition:"background 0.4s ease",
            zIndex:1,
          }}/>

          {/* ────────────────────── Content (above shimmer) ────────── */}
          <div style={{ position:"relative", zIndex:2 }}>

            {/* ── Takeover banner ──────────────────────────────────── */}
            <AnimatePresence>
              {controlling && (
                <motion.div
                  initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}} exit={{height:0,opacity:0}}
                  style={{
                    display:"flex", alignItems:"center", gap:8, padding:"7px 14px",
                    background:"linear-gradient(90deg,rgba(239,68,68,0.20),rgba(168,85,247,0.10))",
                    borderBottom:"1px solid rgba(239,68,68,0.22)",
                  }}>
                  <span className="omni-pulse" style={{
                    width:6, height:6, borderRadius:"50%", background:"#f87171",
                    boxShadow:"0 0 8px #f87171", flexShrink:0,
                  }}/>
                  <span style={{color:"#fca5a5", fontSize:10.5, fontWeight:700, flex:1}}>Agent controlling your PC</span>
                  <kbd style={{
                    color:txtSec, fontSize:9, fontWeight:600, padding:"2px 7px", borderRadius:5,
                    background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.10)",
                  }}>Esc Esc</kbd>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Header row ───────────────────────────────────────── */}
            <div style={{
              display:"flex", alignItems:"center", gap:10,
              padding:"13px 14px 11px",
              borderBottom: (steps.length > 0 || heard || isInputMode) ? `1px solid ${divBdr}` : "none",
            }}>
              {/* Status pill */}
              <motion.div
                layout
                style={{
                  display:"flex", alignItems:"center", gap:6,
                  padding:"4px 11px 4px 8px",
                  background: `${pc.ring}44`,
                  border: `1px solid ${pc.ring}`,
                  borderRadius:99, flexShrink:0,
                }}>
                {/* Pulsing dot */}
                <span className={phase!=="success"&&phase!=="error" ? "omni-pulse" : ""} style={{
                  width:7, height:7, borderRadius:"50%",
                  background: pc.dot,
                  boxShadow: `0 0 6px ${pc.glow}`,
                  flexShrink:0,
                }}/>
                <span style={{ color:pc.dot, fontSize:10.5, fontWeight:800, letterSpacing:"0.06em" }}>
                  {pc.label}
                </span>
              </motion.div>

              {/* Waveform or header text */}
              <div style={{ flex:1, minWidth:0, overflow:"hidden" }}>
                {phase==="listening" ? (
                  <Waveform level={audioLvl}/>
                ) : (
                  <motion.p
                    key={header}
                    initial={{opacity:0, x:5}} animate={{opacity:1, x:0}} transition={{duration:0.13}}
                    style={{
                      color:txt, fontSize:13, fontWeight:600, lineHeight:1.4,
                      margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    }}
                  >{header}</motion.p>
                )}
              </div>

              {/* Buttons */}
              <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                <button
                  onClick={hideWin}
                  title="Hide (Ctrl+Shift+O to re-show)"
                  style={{
                    padding:"5px 8px", borderRadius:9,
                    background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.09)",
                    color:txtSec, cursor:"pointer", display:"flex", alignItems:"center", fontSize:12,
                  }}>—</button>

                {(phase==="working"||phase==="thinking") && (
                  <button
                    onClick={async()=>{ await invoke("cancel_task").catch(()=>{}); setPhase("idle"); setSteps([]); await hideWin(); }}
                    style={{
                      display:"flex", alignItems:"center", gap:4, padding:"5px 10px",
                      background:"rgba(248,113,113,0.14)", border:"1px solid rgba(248,113,113,0.30)",
                      borderRadius:9, color:"#f87171", fontSize:11.5, fontWeight:800, cursor:"pointer",
                    }}>
                    <Square size={9} fill="#f87171"/> Stop
                  </button>
                )}

                {(phase==="success"||phase==="error") && (
                  <button
                    onClick={async()=>{ setPhase("idle"); setSteps([]); await hideWin(); }}
                    style={{
                      padding:"5px 8px", borderRadius:9,
                      background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.09)",
                      color:txtSec, cursor:"pointer", display:"flex", alignItems:"center",
                    }}>
                    <X size={11}/>
                  </button>
                )}
              </div>
            </div>

            {/* ── "You said" bubble ─────────────────────────────────── */}
            <AnimatePresence initial={false}>
              {heard && !isInputMode && (
                <motion.div
                  initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
                  exit={{height:0,opacity:0}} transition={{duration:0.15}}>
                  <div style={{padding:"9px 14px 8px"}}>
                    <div style={{
                      display:"flex", alignItems:"flex-start", gap:9, padding:"10px 13px",
                      background:"linear-gradient(135deg,rgba(56,189,248,0.10),rgba(129,140,248,0.07))",
                      border:"1px solid rgba(56,189,248,0.22)", borderRadius:13,
                    }}>
                      <Mic size={12} style={{color:"#38bdf8", flexShrink:0, marginTop:3}}/>
                      <div style={{flex:1, minWidth:0}}>
                        <p style={{color:"rgba(56,189,248,0.6)", fontSize:9, fontWeight:900, textTransform:"uppercase", letterSpacing:"0.08em", margin:"0 0 3px"}}>You said</p>
                        <p style={{color:txt, fontSize:13, fontWeight:500, lineHeight:1.5, margin:0, wordBreak:"break-word"}}>{heard}</p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Step history ──────────────────────────────────────── */}
            <AnimatePresence initial={false}>
              {steps.length > 0 && !isInputMode && (
                <motion.div
                  initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
                  exit={{height:0,opacity:0}} transition={{duration:0.17}}>
                  <div style={{borderTop:`1px solid ${divBdr}`, padding:"7px 12px 9px"}}>

                    <button
                      onClick={()=>setStepsOpen(v=>!v)}
                      style={{
                        width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
                        padding:"3px 2px 5px", background:"transparent", border:"none",
                        color:txtSec, fontSize:10, fontWeight:700, cursor:"pointer",
                        textTransform:"uppercase", letterSpacing:"0.05em",
                      }}>
                      <span>Steps ({steps.length})</span>
                      {stepsOpen ? <ChevronUp size={10}/> : <ChevronDown size={10}/>}
                    </button>

                    <AnimatePresence initial={false}>
                      {stepsOpen && (
                        <motion.div
                          initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
                          exit={{height:0,opacity:0}} transition={{duration:0.14}}>
                          <div style={{display:"flex", flexDirection:"column", gap:4, paddingTop:2}}>
                            {visSteps.map((s, i) => (
                              <motion.div
                                key={`${s.step_num}-${s.ts}`}
                                initial={{opacity:0, x:5}} animate={{opacity:1, x:0}}
                                transition={{duration:0.11, delay:i*0.014}}
                                style={{
                                  display:"flex", alignItems:"flex-start", gap:8, padding:"7px 9px",
                                  background: s.success ? rowBg : "rgba(248,113,113,0.08)",
                                  border: s.success ? `1px solid ${divBdr}` : "1px solid rgba(248,113,113,0.22)",
                                  borderRadius:11,
                                }}>
                                <span style={{
                                  flexShrink:0, width:17, height:17, borderRadius:"50%",
                                  background: s.success?"rgba(56,189,248,0.12)":"rgba(248,113,113,0.12)",
                                  border: s.success?"1px solid rgba(56,189,248,0.28)":"1px solid rgba(248,113,113,0.28)",
                                  display:"flex", alignItems:"center", justifyContent:"center",
                                  fontSize:9, fontWeight:900,
                                  color: s.success?"#38bdf8":"#f87171",
                                }}>{s.step_num}</span>

                                <div style={{flex:1, minWidth:0}}>
                                  {s.thought && (
                                    <p style={{
                                      color:txt, fontSize:12, fontWeight:600, margin:"0 0 2px",
                                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                    }}>{s.thought}</p>
                                  )}
                                  {s.description && s.description!==s.thought && (
                                    <p style={{
                                      color: s.success ? txtSec : "#f87171",
                                      fontSize:10.5, lineHeight:1.4, margin:0,
                                      display:"-webkit-box", WebkitLineClamp:3, WebkitBoxOrient:"vertical",
                                      overflow:"hidden",
                                    }}>{s.description}</p>
                                  )}
                                </div>

                                {s.tool && (
                                  <span style={{
                                    flexShrink:0, display:"flex", alignItems:"center", gap:2.5,
                                    padding:"2px 5px",
                                    background:"rgba(255,255,255,0.05)", border:`1px solid ${divBdr}`,
                                    borderRadius:6, color:txtSec, fontSize:8, fontWeight:700, textTransform:"uppercase",
                                  }}>
                                    <TIcon t={s.tool}/>{s.tool}
                                  </span>
                                )}
                              </motion.div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Approval ──────────────────────────────────────────── */}
            <AnimatePresence>
              {phase==="approval" && permReq && (
                <motion.div
                  initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
                  exit={{height:0,opacity:0}} transition={{duration:0.15}}>
                  <div style={{padding:"12px 14px 14px", borderTop:"1px solid rgba(248,113,113,0.20)"}}>
                    <p style={{color:"#f87171", fontSize:10, fontWeight:800, textTransform:"uppercase", letterSpacing:"0.08em", margin:"0 0 7px"}}>Permission Required</p>
                    <p style={{color:txt, fontSize:13, lineHeight:1.5, margin:"0 0 12px"}}>{permReq.description}</p>
                    <div style={{display:"flex", gap:8}}>
                      <button onClick={()=>approve(false)} style={{
                        flex:1, padding:"9px",
                        background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)",
                        borderRadius:11, color:txtSec, fontSize:12, fontWeight:700, cursor:"pointer",
                      }}>Deny</button>
                      <button onClick={()=>approve(true)} style={{
                        flex:1, padding:"9px",
                        background:"rgba(52,211,153,0.15)", border:"1px solid rgba(52,211,153,0.30)",
                        borderRadius:11, color:"#34d399", fontSize:12, fontWeight:800, cursor:"pointer",
                      }}>Approve</button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── MORPHED INPUT — question OR text_input ────────────── */}
            <AnimatePresence>
              {isInputMode && (
                <motion.div
                  initial={{opacity:0, y:6}} animate={{opacity:1, y:0}}
                  exit={{opacity:0, y:4}} transition={{duration:0.18}}>
                  <div style={{padding:"10px 14px 14px"}}>

                    {/* Question text (if AI asked something) */}
                    {phase==="question" && question && (
                      <motion.div
                        initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.05}}
                        style={{
                          padding:"10px 13px", marginBottom:10,
                          background:"linear-gradient(135deg,rgba(56,189,248,0.10),rgba(129,140,248,0.07))",
                          border:"1px solid rgba(56,189,248,0.22)", borderRadius:13,
                        }}>
                        <p style={{color:"rgba(56,189,248,0.65)", fontSize:9, fontWeight:900, textTransform:"uppercase", letterSpacing:"0.08em", margin:"0 0 4px"}}>
                          Omni asks
                        </p>
                        <p style={{color:txt, fontSize:13, lineHeight:1.5, margin:0}}>{question.question}</p>
                      </motion.div>
                    )}

                    {/* Hint for text_input mode */}
                    {phase==="text_input" && (
                      <p style={{color:txtSec, fontSize:10.5, margin:"0 0 8px", fontWeight:500}}>
                        Type a command or use mic
                      </p>
                    )}

                    {/* Glass input box */}
                    <div style={{
                      display:"flex", gap:6, alignItems:"flex-end",
                      padding:"8px 10px",
                      background:"rgba(255,255,255,0.06)",
                      border:"1px solid rgba(255,255,255,0.13)",
                      borderRadius:14,
                      backdropFilter:"blur(6px)",
                    }}>
                      <textarea
                        ref={answerRef}
                        value={answer}
                        onChange={e=>setAnswer(e.target.value)}
                        onKeyDown={e=>{ if (e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); phase==="question"?submitAnswer():sendPrompt(); } }}
                        placeholder={phase==="question"?"Your answer…":"Type a command…"}
                        rows={1}
                        style={{
                          flex:1, resize:"none",
                          background:"transparent", border:"none", outline:"none",
                          color:txt, fontSize:13.5, lineHeight:1.5,
                          fontFamily:"inherit",
                          maxHeight:120, overflowY:"auto",
                          padding:0,
                        }}
                      />
                      <button onClick={toggleMic} style={{
                        padding:"7px 9px", flexShrink:0, borderRadius:10,
                        background: isDictating ? "rgba(196,181,253,0.20)" : "rgba(255,255,255,0.07)",
                        border: isDictating ? "1px solid rgba(196,181,253,0.40)" : "1px solid rgba(255,255,255,0.10)",
                        color: isDictating ? "#c4b5fd" : txtSec, cursor:"pointer",
                        display:"flex", alignItems:"center",
                      }}>
                        {isDictating ? <Waveform level={audioLvl}/> : <Mic size={14}/>}
                      </button>
                      <button onClick={phase==="question"?submitAnswer:sendPrompt} style={{
                        padding:"7px 10px", flexShrink:0, borderRadius:10,
                        background:"rgba(129,140,248,0.20)", border:"1px solid rgba(129,140,248,0.35)",
                        color:"#818cf8", cursor:"pointer", display:"flex", alignItems:"center",
                      }}>
                        <Send size={14}/>
                      </button>
                    </div>
                    <p style={{color:txtSec, fontSize:9.5, marginTop:5, textAlign:"center", fontWeight:500}}>
                      Enter to send · Esc to cancel
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Bottom padding ─────────────────────────────────────── */}
            {!isInputMode && <div style={{height:4}}/>}
          </div>
        </motion.div>
      </div>
    </>
  );
};
