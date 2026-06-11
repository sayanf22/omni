/**
 * FloatingOverlay — top-right agent status card
 *
 * Fully dynamic: the Tauri window resizes to EXACTLY fit the card content
 * every time anything changes. No max-height cap, no truncation.
 *
 * Works even when the dashboard is closed — this is a separate Tauri window.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, Loader2, CheckCircle2, AlertCircle, X, Square,
  ShieldAlert, Send, Brain, MousePointer2, Keyboard,
  Eye, FileText, Clipboard, Zap, Globe, ChevronDown, ChevronUp,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = "idle"|"listening"|"thinking"|"working"|"approval"|"question"|"success"|"error"|"text_input";
interface Step { step_num:number; thought:string; tool:string|null; description:string; success:boolean; ts:number; }
interface PermReq { id:string; tool:string; action:string; description:string; preview:string|null; }

// ─── Waveform ─────────────────────────────────────────────────────────────────
const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const shape = [0.2,0.4,0.65,0.85,1,1,1,0.85,0.65,0.4,0.2];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display:"flex", alignItems:"center", gap:3.5, height:32 }}>
      {shape.map((s,i) => {
        const h = Math.max(3, Math.min(28, 3 + lvl * 25 * s));
        return (
          <span key={i} className="omni-wavebar" style={{
            display:"block", width:3.5, height:h, borderRadius:3,
            background:"linear-gradient(180deg,#c4b5fd,#38bdf8)",
            transition:"height 65ms cubic-bezier(.4,0,.2,1)",
            animationDelay:`${i*0.08}s`,
            animationDuration: lvl > 0.1 ? "0.4s" : "1.2s",
          }}/>
        );
      })}
    </div>
  );
};

// ─── Tool icon ────────────────────────────────────────────────────────────────
const TIcon: React.FC<{t:string|null}> = ({t}) => {
  if (!t) return <Zap size={9}/>;
  const s = t.toLowerCase();
  if (s==="mouse") return <MousePointer2 size={9}/>;
  if (s==="keyboard") return <Keyboard size={9}/>;
  if (s==="screen") return <Eye size={9}/>;
  if (s==="app") return <Brain size={9}/>;
  if (s==="file") return <FileText size={9}/>;
  if (s==="clipboard") return <Clipboard size={9}/>;
  if (s==="web") return <Globe size={9}/>;
  return <Zap size={9}/>;
};

const win = () => getCurrentWindow();
const hideWin = async () => { try { await win().hide(); } catch(_){} };

// ─── Main ─────────────────────────────────────────────────────────────────────
export const FloatingOverlay: React.FC = () => {
  const { theme } = useStore();
  const dark = theme !== "light";

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

  // stale-closure refs
  const phaseRef   = useRef(phase);
  const isDictRef  = useRef(isDictating);
  useEffect(() => { phaseRef.current  = phase; },      [phase]);
  useEffect(() => { isDictRef.current = isDictating; }, [isDictating]);

  const cardRef  = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastSeq  = useRef(-1);

  // ── screen height ────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const m = await primaryMonitor();
        const sc = await win().scaleFactor();
        if (m) setScreenH(Math.floor(m.size.height / sc - 60));
      } catch(_){}
    })();
  }, []);

  // ── transparent BG ───────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.cssText = "background:transparent;margin:0;overflow:hidden;";
  }, []);

  // ── DYNAMIC RESIZE ────────────────────────────────────────────────────────
  // ResizeObserver fires on EVERY DOM change — window tracks content exactly.
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
    // Fire immediately
    doResize();
    const obs = new ResizeObserver(doResize);
    obs.observe(card);
    return () => obs.disconnect();
  }, [phase, steps, stepsOpen, doResize]);

  // ── helpers ──────────────────────────────────────────────────────────────
  const clearT = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
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

  // ── polling fallback ──────────────────────────────────────────────────────
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

  // ── event listeners ───────────────────────────────────────────────────────
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
        // Wake word timeout: if we were listening but nothing was transcribed,
        // go back to idle after a short delay
        if (phaseRef.current==="listening") {
          setPhase("thinking"); setHeader("Transcribing…");
        }
      });

      // Wake word detected but no speech → return to idle
      await on("wake:timeout", async () => {
        if (phaseRef.current==="listening") {
          setPhase("idle"); setHeard(""); await hideWin();
        }
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

  // ── escape key ────────────────────────────────────────────────────────────
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

  // ── handlers ──────────────────────────────────────────────────────────────
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

  if (phase==="idle") return null;

  // ── theme ─────────────────────────────────────────────────────────────────
  const d = dark;
  const cardBg   = d ? "rgba(13,13,20,0.88)"      : "rgba(255,255,255,0.94)";
  const bdr      = d ? "rgba(255,255,255,0.11)"   : "rgba(0,0,0,0.10)";
  const txt      = d ? "rgba(255,255,255,0.90)"   : "#0f172a";
  const txtSec   = d ? "rgba(255,255,255,0.48)"   : "#6b7280";
  const divBdr   = d ? "rgba(255,255,255,0.07)"   : "rgba(0,0,0,0.07)";
  const rowBg    = d ? "rgba(255,255,255,0.035)"  : "rgba(0,0,0,0.022)";
  const shadow   = d
    ? "0 20px 60px rgba(0,0,0,0.65), 0 4px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.10)"
    : "0 12px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,1)";

  // phase colors
  const PC: Record<Phase, {color:string; bg:string; bdr:string; label:string; icon:React.ReactNode}> = {
    idle:       {color:"#6b7280", bg:"transparent",              bdr:"transparent",            label:"",         icon:null},
    listening:  {color:"#a78bfa", bg:"rgba(167,139,250,0.14)",  bdr:"rgba(167,139,250,0.30)",  label:"Listening", icon:<Mic size={13}/>},
    thinking:   {color:"#818cf8", bg:"rgba(129,140,248,0.14)",  bdr:"rgba(129,140,248,0.30)",  label:"Thinking",  icon:<Loader2 size={13} className="animate-spin"/>},
    working:    {color:"#38bdf8", bg:"rgba(56,189,248,0.14)",   bdr:"rgba(56,189,248,0.30)",   label:"Working",   icon:<Loader2 size={13} className="animate-spin"/>},
    approval:   {color:"#f87171", bg:"rgba(248,113,113,0.14)",  bdr:"rgba(248,113,113,0.32)",  label:"Approval",  icon:<ShieldAlert size={13}/>},
    question:   {color:"#38bdf8", bg:"rgba(56,189,248,0.14)",   bdr:"rgba(56,189,248,0.32)",   label:"Question",  icon:<Mic size={13}/>},
    text_input: {color:"#818cf8", bg:"rgba(129,140,248,0.14)",  bdr:"rgba(129,140,248,0.32)",  label:"Command",   icon:<Brain size={13}/>},
    success:    {color:"#34d399", bg:"rgba(52,211,153,0.14)",   bdr:"rgba(52,211,153,0.30)",   label:"Done",      icon:<CheckCircle2 size={13}/>},
    error:      {color:"#f87171", bg:"rgba(248,113,113,0.14)",  bdr:"rgba(248,113,113,0.30)",  label:"Error",     icon:<AlertCircle size={13}/>},
  };
  const pc = PC[phase];

  const visSteps = phase==="success"||phase==="error"
    ? (stepsOpen ? steps : steps.slice(-3))
    : (stepsOpen ? steps : steps.slice(-5));

  return (
    <div style={{width:440, padding:"8px", boxSizing:"border-box", background:"transparent"}}>
      <motion.div
        ref={cardRef}
        initial={{opacity:0, y:-10, scale:0.96}}
        animate={{opacity:1, y:0, scale:1}}
        transition={{type:"spring", stiffness:400, damping:30}}
        style={{
          background:cardBg,
          backdropFilter:"blur(48px) saturate(200%)",
          WebkitBackdropFilter:"blur(48px) saturate(200%)",
          border:`1px solid ${bdr}`,
          borderRadius:20,
          boxShadow:shadow,
          overflow:"hidden",
        }}
      >

        {/* ── Takeover banner ────────────────────────────────────────── */}
        <AnimatePresence>
          {controlling && (
            <motion.div
              initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}} exit={{height:0,opacity:0}}
              style={{
                display:"flex", alignItems:"center", gap:8, padding:"8px 14px",
                background:"linear-gradient(90deg,rgba(239,68,68,0.18),rgba(168,85,247,0.10))",
                borderBottom:`1px solid rgba(239,68,68,0.22)`,
              }}>
              <span style={{
                width:6, height:6, borderRadius:"50%", background:"#f87171",
                boxShadow:"0 0 8px #f87171", flexShrink:0,
                animation:"ompulse 1.4s ease-in-out infinite",
              }}/>
              <span style={{color:"#fca5a5", fontSize:10.5, fontWeight:700, flex:1}}>Agent controlling your PC</span>
              <kbd style={{
                color:txtSec, fontSize:9, fontWeight:600, padding:"2px 7px",
                borderRadius:5, background:d?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.05)",
                border:`1px solid ${bdr}`,
              }}>Esc Esc to stop</kbd>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Header row ─────────────────────────────────────────────── */}
        <div style={{
          display:"flex", alignItems:"center", gap:10,
          padding:"13px 14px 11px",
          borderBottom: (steps.length > 0 || heard) ? `1px solid ${divBdr}` : "none",
        }}>

          {/* Status pill */}
          <div style={{
            display:"flex", alignItems:"center", gap:6,
            padding:"4px 11px 4px 8px",
            background:pc.bg, border:`1px solid ${pc.bdr}`,
            borderRadius:99, flexShrink:0,
          }}>
            <span style={{color:pc.color, display:"flex", alignItems:"center"}}>{pc.icon}</span>
            <span style={{color:pc.color, fontSize:11, fontWeight:800, letterSpacing:"0.05em"}}>{pc.label}</span>
          </div>

          {/* Waveform OR header text */}
          <div style={{flex:1, minWidth:0, overflow:"hidden"}}>
            {phase==="listening" ? (
              <Waveform level={audioLvl}/>
            ) : (
              <motion.p
                key={header}
                initial={{opacity:0, x:4}} animate={{opacity:1, x:0}} transition={{duration:0.13}}
                style={{
                  color:txt, fontSize:13, fontWeight:600, lineHeight:1.4,
                  margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                }}
              >{header}</motion.p>
            )}
          </div>

          {/* Action buttons */}
          <div style={{display:"flex", gap:5, flexShrink:0}}>
            {/* Hide */}
            <button
              onClick={hideWin}
              title="Hide (Ctrl+Shift+O to re-show)"
              style={{
                padding:"5px 8px", borderRadius:9,
                background:d?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.04)",
                border:`1px solid ${bdr}`, color:txtSec, cursor:"pointer",
                display:"flex", alignItems:"center", fontSize:11,
              }}>—</button>

            {/* Stop (while working) */}
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

            {/* Dismiss (success/error) */}
            {(phase==="success"||phase==="error") && (
              <button
                onClick={async()=>{ setPhase("idle"); setSteps([]); await hideWin(); }}
                style={{
                  padding:"5px 8px", borderRadius:9,
                  background:d?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.04)",
                  border:`1px solid ${bdr}`, color:txtSec, cursor:"pointer",
                  display:"flex", alignItems:"center",
                }}>
                <X size={11}/>
              </button>
            )}
          </div>
        </div>

        {/* ── "You said" bubble ──────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {heard && (phase==="thinking"||phase==="working"||phase==="success"||phase==="error"||phase==="question"||phase==="approval") && (
            <motion.div
              initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
              exit={{height:0,opacity:0}} transition={{duration:0.15}}>
              <div style={{padding:"10px 14px 8px"}}>
                <div style={{
                  display:"flex", alignItems:"flex-start", gap:9, padding:"10px 13px",
                  background:d?"linear-gradient(135deg,rgba(56,189,248,0.09),rgba(129,140,248,0.05))"
                              :"linear-gradient(135deg,rgba(56,189,248,0.10),rgba(129,140,248,0.06))",
                  border:d?"1px solid rgba(56,189,248,0.18)":"1px solid rgba(56,189,248,0.25)",
                  borderRadius:13,
                }}>
                  <Mic size={12} style={{color:"#38bdf8", flexShrink:0, marginTop:3}}/>
                  <div style={{flex:1, minWidth:0}}>
                    <p style={{color:"rgba(56,189,248,0.65)", fontSize:9, fontWeight:900, textTransform:"uppercase", letterSpacing:"0.08em", margin:"0 0 3px"}}>You said</p>
                    <p style={{color:txt, fontSize:13.5, fontWeight:500, lineHeight:1.48, margin:0, wordBreak:"break-word"}}>{heard}</p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Step history ───────────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {steps.length > 0 && (
            <motion.div
              initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
              exit={{height:0,opacity:0}} transition={{duration:0.17}}>
              <div style={{borderTop:`1px solid ${divBdr}`, padding:"7px 12px 9px"}}>

                {/* toggle */}
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
                        {visSteps.map((s,i) => (
                          <motion.div
                            key={`${s.step_num}-${s.ts}`}
                            initial={{opacity:0,x:4}} animate={{opacity:1,x:0}}
                            transition={{duration:0.11, delay:i*0.012}}
                            style={{
                              display:"flex", alignItems:"flex-start", gap:8, padding:"7px 9px",
                              background: s.success ? rowBg : (d?"rgba(248,113,113,0.07)":"rgba(239,68,68,0.06)"),
                              border: s.success ? `1px solid ${divBdr}` : "1px solid rgba(248,113,113,0.22)",
                              borderRadius:11,
                            }}>
                            {/* number badge */}
                            <span style={{
                              flexShrink:0, width:17, height:17, borderRadius:"50%",
                              background: s.success?"rgba(56,189,248,0.12)":"rgba(248,113,113,0.12)",
                              border: s.success?"1px solid rgba(56,189,248,0.28)":"1px solid rgba(248,113,113,0.28)",
                              display:"flex", alignItems:"center", justifyContent:"center",
                              fontSize:9, fontWeight:900,
                              color: s.success?"#38bdf8":"#f87171",
                            }}>{s.step_num}</span>

                            {/* content */}
                            <div style={{flex:1, minWidth:0}}>
                              {s.thought && (
                                <p style={{
                                  color:txt, fontSize:12, fontWeight:600, margin:"0 0 2px",
                                  overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                }}>{s.thought}</p>
                              )}
                              {s.description && s.description!==s.thought && (
                                <p style={{
                                  color:s.success?txtSec:"#f87171",
                                  fontSize:10.5, lineHeight:1.4, margin:0,
                                  display:"-webkit-box", WebkitLineClamp:3, WebkitBoxOrient:"vertical",
                                  overflow:"hidden",
                                }}>{s.description}</p>
                              )}
                            </div>

                            {/* tool badge */}
                            {s.tool && (
                              <span style={{
                                flexShrink:0, display:"flex", alignItems:"center", gap:2.5,
                                padding:"2px 5px",
                                background:d?"rgba(255,255,255,0.05)":"rgba(0,0,0,0.04)",
                                border:`1px solid ${divBdr}`, borderRadius:6,
                                color:txtSec, fontSize:8.5, fontWeight:700, textTransform:"uppercase",
                              }}>
                                <TIcon t={s.tool}/>{s.tool}
                              </span>
                            )}
                          </motion.div>
                        ))}

                        {/* show-more hint */}
                        {!stepsOpen && steps.length > visSteps.length && (
                          <button onClick={()=>setStepsOpen(true)}
                            style={{background:"transparent",border:"none",color:txtSec,
                              fontSize:10,fontWeight:700,cursor:"pointer",padding:"2px 0",textAlign:"left"}}>
                            + {steps.length-visSteps.length} more…
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

        {/* ── Approval ───────────────────────────────────────────────── */}
        <AnimatePresence>
          {phase==="approval" && permReq && (
            <motion.div
              initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
              exit={{height:0,opacity:0}} transition={{duration:0.15}}>
              <div style={{padding:"12px 14px 14px", borderTop:`1px solid rgba(248,113,113,0.18)`}}>
                <p style={{color:"#f87171",fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:"0.08em",margin:"0 0 7px"}}>Permission Required</p>
                <p style={{color:txt,fontSize:13,lineHeight:1.5,margin:"0 0 12px"}}>{permReq.description}</p>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>approve(false)}
                    style={{flex:1,padding:"9px",background:d?"rgba(255,255,255,0.06)":"rgba(0,0,0,0.04)",
                      border:`1px solid ${bdr}`,borderRadius:11,color:txtSec,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    Deny
                  </button>
                  <button onClick={()=>approve(true)}
                    style={{flex:1,padding:"9px",background:"rgba(52,211,153,0.15)",
                      border:"1px solid rgba(52,211,153,0.30)",borderRadius:11,color:"#34d399",fontSize:12,fontWeight:800,cursor:"pointer"}}>
                    Approve
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Question / text input ──────────────────────────────────── */}
        <AnimatePresence>
          {(phase==="question"||phase==="text_input") && (
            <motion.div
              initial={{height:0,opacity:0}} animate={{height:"auto",opacity:1}}
              exit={{height:0,opacity:0}} transition={{duration:0.15}}>
              <div style={{padding:"10px 12px 12px", borderTop:`1px solid ${divBdr}`}}>
                {phase==="question" && question && (
                  <p style={{color:txt,fontSize:13,lineHeight:1.5,margin:"0 0 9px"}}>{question.question}</p>
                )}
                <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
                  <textarea
                    value={answer}
                    onChange={e=>setAnswer(e.target.value)}
                    onKeyDown={e=>{ if (e.key==="Enter"&&!e.shiftKey) { e.preventDefault(); phase==="question"?submitAnswer():sendPrompt(); } }}
                    placeholder={phase==="question"?"Type your answer…":"Type a command…"}
                    rows={1}
                    autoFocus
                    style={{
                      flex:1, padding:"9px 12px", resize:"none",
                      background:d?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.04)",
                      border:`1px solid ${bdr}`, borderRadius:11,
                      color:txt, fontSize:13, lineHeight:1.4, outline:"none",
                      fontFamily:"inherit", maxHeight:120, overflowY:"auto",
                    }}
                  />
                  <button onClick={toggleMic}
                    style={{
                      padding:"9px 10px", flexShrink:0,
                      background:isDictating?"rgba(167,139,250,0.18)":d?"rgba(255,255,255,0.07)":"rgba(0,0,0,0.04)",
                      border:isDictating?"1px solid rgba(167,139,250,0.35)":`1px solid ${bdr}`,
                      borderRadius:11, color:isDictating?"#a78bfa":txtSec, cursor:"pointer",
                      display:"flex", alignItems:"center",
                    }}>
                    <Mic size={13}/>
                  </button>
                  <button onClick={phase==="question"?submitAnswer:sendPrompt}
                    style={{
                      padding:"9px 11px", flexShrink:0,
                      background:"rgba(129,140,248,0.18)", border:"1px solid rgba(129,140,248,0.30)",
                      borderRadius:11, color:"#818cf8", cursor:"pointer",
                      display:"flex", alignItems:"center",
                    }}>
                    <Send size={13}/>
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </motion.div>
    </div>
  );
};
