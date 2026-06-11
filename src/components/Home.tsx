import React, { useState, useEffect, useRef } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Square, Loader2, CheckCircle2, AlertTriangle,
  XCircle, AlertCircle, Eye, EyeOff,
  MessageCircle, Mail, FileText, Compass,
  ChevronRight, Mic
} from "lucide-react";

interface StepProgress {
  step_num: number;
  thought: string;
  tool: string | null;
  description: string;
  success: boolean;
}

/** Determines if the currently active model supports screen vision */
function modelHasVision(model: { provider_type: string; model_name: string; role_vision: boolean } | undefined): boolean {
  if (!model) return false;
  if (!model.role_vision) return false;
  const p = model.provider_type.toLowerCase();
  const m = model.model_name.toLowerCase();
  // DeepSeek never supports vision regardless of role flag
  if (p === "deepseek") return false;
  if (p === "openai") return m.includes("gpt-4o") || m.includes("gpt-4-turbo") || m.includes("o1") || m.includes("o3") || m.includes("o4");
  if (p === "anthropic") return m.includes("claude-3") || m.includes("claude-opus") || m.includes("claude-sonnet") || m.includes("claude-haiku");
  if (p === "openrouter") return m.includes("gpt-4o") || m.includes("claude-3") || m.includes("gemini") || m.includes("vision") || m.includes("qwen");
  if (p === "custom") return m.includes("vision") || m.includes("llava");
  return false;
}

export const Home: React.FC = () => {
  const { session, tasks, models, fetchLocalData } = useStore();
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<"idle" | "thinking" | "working" | "success" | "error">("idle");
  const [activeTaskDesc, setActiveTaskDesc] = useState("");
  const [liveSteps, setLiveSteps] = useState<StepProgress[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [isTaskRunning, setIsTaskRunning] = useState(false);
  // Voice listening state for the dashboard Command Center waveform
  const [isListening, setIsListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Find the active vision model
  const activeVisionModel = models.find((m) => m.is_active && m.role_vision);
  const activeAnyModel = models.find((m) => m.is_active);
  const hasVision = modelHasVision(activeVisionModel || activeAnyModel);
  const hasAnyModel = models.length > 0;

  // Listen to live task events safely without unmount memory leaks
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

      await addListener("task:started", (event: any) => {
        setStatus("thinking");
        setIsTaskRunning(true);
        setLiveSteps([]);
        setErrorMsg("");
        // Capture the instruction so the chat thread can show what the user asked
        if (event.payload?.instruction) {
          setActiveTaskDesc(event.payload.instruction);
        }
      });

      await addListener("task:step", (event: any) => {
        setStatus("working");
        setLiveSteps((prev) => {
          const step = event.payload;
          // Replace in-place if step_num matches (running preview → completed update)
          const idx = prev.findIndex((s) => s.step_num === step.step_num);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = step;
            return next;
          }
          return [...prev, step];
        });
      });

      await addListener("task:done", () => {
        setStatus("success");
        setIsTaskRunning(false);
        fetchLocalData();
        // Auto-reset to idle after 3s
        setTimeout(() => setStatus("idle"), 3000);
      });

      await addListener("task:failed", (event: any) => {
        setStatus("error");
        setIsTaskRunning(false);
        setErrorMsg(event.payload?.error || "Task failed.");
        fetchLocalData();
      });

      await addListener("agent:killed", () => {
        setStatus("idle");
        setIsTaskRunning(false);
        setLiveSteps([]);
      });

      // NOTE: question:request is handled exclusively by FloatingOverlay (top-right card)

      // From voice/text overlay — track running state
      await addListener("voice:transcript", (event: any) => {
        setIsListening(false);
        setAudioLevel(0);
        setStatus("thinking");
        setIsTaskRunning(true);
        setActiveTaskDesc(event.payload.text || "Voice command");
        setLiveSteps([]);
        setErrorMsg("");
      });

      // ── Voice listening events (Dashboard waveform) ──────────────────────
      await addListener("hotkey:mic_start", () => {
        setIsListening(true);
        setAudioLevel(0);
      });
      await addListener("voice:level", (e: any) => {
        if (typeof e.payload === "number") setAudioLevel(e.payload);
      });
      await addListener("hotkey:mic_stop", () => {
        setIsListening(false);
        setAudioLevel(0);
      });
    }

    setup();
    return () => {
      active = false;
      unsubscribes.forEach((fn) => fn());
    };
  }, [fetchLocalData]);

  // Auto-resize the textarea height based on content size
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [instruction]);

  const handleStartTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || isTaskRunning) return;

    setStatus("thinking");
    setIsTaskRunning(true);
    setActiveTaskDesc(trimmed);
    setLiveSteps([]);
    setErrorMsg("");
    setInstruction("");

    // FIRE AND FORGET — do NOT await run_task
    // Tauri IPC has a timeout; long-running tasks must be event-driven.
    // The task status is tracked via task:started / task:step / task:done / task:failed events.
    invoke("run_task", {
      instruction: trimmed,
      userId: session?.user?.id || "",
    }).catch((err) => {
      console.error("run_task invocation error:", err);
      setStatus("error");
      setIsTaskRunning(false);
      setErrorMsg(err?.toString() || "Failed to start task.");
    });
  };

  const handleStopTask = async () => {
    try {
      await invoke("cancel_task");
      setStatus("idle");
      setIsTaskRunning(false);
      setLiveSteps([]);
    } catch (e) {
      console.error("Failed to cancel task", e);
    }
  };

  const handleDismissError = () => {
    setStatus("idle");
    setErrorMsg("");
  };

  // Stats
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const timeSaved = completedTasks * 2.5;


  const isRunning = isTaskRunning;

  // ── Inline waveform bars for the Command Center listening mode ──────
  const WaveformBars: React.FC<{ level: number }> = ({ level }) => {
    const bars = 13;
    const shape = [0.35, 0.5, 0.7, 0.85, 0.95, 1, 1, 1, 0.95, 0.85, 0.7, 0.5, 0.35];
    const lvl = Math.max(0, Math.min(1, level));
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 48, justifyContent: "center" }}>
        {Array.from({ length: bars }).map((_, i) => {
          const base = 6, max = 44;
          const h = Math.max(base, Math.min(max, base + lvl * (max - base) * shape[i]));
          return (
            <span key={i} className="home-wavebar" style={{
              width: 4, height: h, borderRadius: 4,
              background: "linear-gradient(180deg, #a78bfa, #38bdf8)",
              transition: "height 80ms cubic-bezier(0.4,0,0.2,1)",
              display: "inline-block",
            }} />
          );
        })}
      </div>
    );
  };
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // Group tasks by day
  const groupedTasks = React.useMemo(() => {
    const groups: { [key: string]: typeof tasks } = {};
    tasks.forEach((task) => {
      const date = new Date(task.created_at);
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);

      let dateStr = "";
      if (date.toDateString() === today.toDateString()) {
        dateStr = "TODAY";
      } else if (date.toDateString() === yesterday.toDateString()) {
        dateStr = "YESTERDAY";
      } else {
        dateStr = date.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        }).toUpperCase();
      }

      if (!groups[dateStr]) {
        groups[dateStr] = [];
      }
      groups[dateStr].push(task);
    });
    return groups;
  }, [tasks]);

  const userName = React.useMemo(() => {
    const email = session?.user?.email || "Sayan";
    const prefix = email.split("@")[0];
    if (prefix.toLowerCase().includes("sayan")) {
      return "Sayan";
    }
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }, [session]);

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }).toLowerCase();
  };

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="font-sans text-5xl font-black tracking-tight text-text leading-tight">
            Welcome back, {userName}
          </h1>
          <p className="text-text-secondary text-[16px] mt-2.5">
            Monitor agent activities and trigger automated workflows.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Vision capability badge */}
          {hasAnyModel && (
            <div className={`px-4.5 py-2 rounded-2xl border flex items-center gap-2 text-[13px] font-extrabold ${
              hasVision
                ? "bg-success/10 border-success/20 text-success"
                : "bg-warning/10 border-warning/20 text-warning"
            }`}>
              {hasVision
                ? <><Eye className="w-4.5 h-4.5" /> Screen Vision</>
                : <><EyeOff className="w-4.5 h-4.5" /> Text Only</>
              }
            </div>
          )}

          {activeAnyModel && (
            <div className="px-5 py-2.5 bg-accent-dim border border-border/60 rounded-2xl flex items-center gap-2.5 shadow-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-success animate-pulse" />
              <span className="text-[13px] font-extrabold text-text">
                {activeAnyModel.display_name} · {activeAnyModel.model_name}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Warnings */}
      {!hasAnyModel && (
        <div className="p-6 bg-error-dim/20 border border-error/30 rounded-[24px] flex items-center gap-4.5 shadow-sm">
          <AlertCircle className="w-6 h-6 text-error shrink-0" />
          <div>
            <p className="text-base font-extrabold text-error">No AI model configured</p>
            <p className="text-sm text-text-secondary mt-1">
              Go to <strong>Settings → Model Registry</strong> and add an AI model to enable automation.
            </p>
          </div>
        </div>
      )}

      {hasAnyModel && !hasVision && (
        <div className="p-6 bg-warning/15 border border-warning/30 rounded-[24px] flex items-start gap-4.5 shadow-sm">
          <AlertTriangle className="w-6 h-6 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-base font-extrabold text-warning">Running in text-only mode</p>
            <p className="text-sm text-text-secondary mt-1 leading-relaxed">
              Your active model doesn't support screen vision. Automation will rely on text commands and code tools.
            </p>
          </div>
        </div>
      )}

      {/* Main Content Layout */}
      <div className="grid grid-cols-12 gap-10 items-start">
        
        {/* Left Column */}
        <div className="col-span-8 space-y-10">
          
          {/* Banner Card */}
          <div className="relative overflow-hidden p-10 min-h-[220px] flex flex-col justify-between modern-banner">
            <div className="relative max-w-[58%] z-10">
              <h2 className="font-serif text-3xl font-bold tracking-tight text-text leading-tight">
                Omni automates your screen tasks
              </h2>
              <p className="text-text-secondary text-sm mt-3 leading-relaxed font-normal">
                Type instructions, speak commands, or run custom skills. Omni automates your applications, files, and browser tasks seamlessly.
              </p>
            </div>

            {/* Floating application squircles (iOS scattered style with rotation and depth) */}
            <div className="absolute right-8 top-0 bottom-0 w-[38%] pointer-events-none z-0">
              {/* Messages */}
              <div 
                className="absolute right-28 top-[30px] w-[54px] h-[54px] rounded-[13px] bg-gradient-to-tr from-[#34C759] to-[#54D970] border border-white/20 dark:border-white/5 flex items-center justify-center shadow-[0_10px_24px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.2)] rotate-[-6deg] animate-pulse"
                style={{ animationDuration: "3s" }}
              >
                <MessageCircle className="w-6 h-6 text-white fill-white/10" />
              </div>
              {/* Mail */}
              <div 
                className="absolute right-8 top-[40px] w-[58px] h-[58px] rounded-[14px] bg-gradient-to-tr from-[#007AFF] to-[#34A8FF] border border-white/20 dark:border-white/5 flex items-center justify-center shadow-[0_12px_28px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.2)] rotate-[8deg] animate-pulse"
                style={{ animationDuration: "3.5s", animationDelay: "0.3s" }}
              >
                <Mail className="w-6 h-6 text-white" />
              </div>
              {/* Notes */}
              <div 
                className="absolute right-24 bottom-[35px] w-[54px] h-[54px] rounded-[13px] bg-gradient-to-tr from-[#E5A93C] to-[#F3D17C] border border-white/20 dark:border-white/5 flex items-center justify-center shadow-[0_10px_24px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.2)] rotate-[12deg] animate-pulse"
                style={{ animationDuration: "4s", animationDelay: "0.6s" }}
              >
                <FileText className="w-6 h-6 text-white" />
              </div>
              {/* Browser / Safari */}
              <div 
                className="absolute right-5 bottom-[24px] w-[56px] h-[56px] rounded-[13.5px] bg-gradient-to-tr from-[#0055FF] to-[#1AD6FD] border border-white/20 dark:border-white/5 flex items-center justify-center shadow-[0_12px_26px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.2)] rotate-[-10deg] animate-pulse"
                style={{ animationDuration: "3.8s", animationDelay: "0.9s" }}
              >
                <Compass className="w-[26px] h-[26px] text-white" />
              </div>
            </div>

            <div className="relative flex gap-4.5 mt-8 z-10">
              <button
                onClick={() => textareaRef.current?.focus()}
                className="px-7 py-3 text-sm font-extrabold rounded-full hover:shadow-lg transition-all bg-accent hover:bg-accent-hover text-accent-contrast shadow-sm"
              >
                Automate task
              </button>
              <button
                onClick={() => textareaRef.current?.focus()}
                className="px-7 py-3 text-sm font-extrabold rounded-full transition-all border border-border hover:bg-surface2 text-text"
              >
                How it works
              </button>
            </div>
          </div>

          {/* Error Banner */}
          <AnimatePresence>
            {status === "error" && errorMsg && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-4 bg-error/10 border border-error/20 dark:border-error/10 rounded-2xl text-sm text-error font-medium break-all flex justify-between items-center gap-4"
              >
                <div className="flex items-center gap-2.5">
                  <AlertCircle className="w-5 h-5 text-error shrink-0" />
                  <span>{errorMsg}</span>
                </div>
                <button onClick={handleDismissError} className="p-1.5 hover:bg-error/10 rounded-xl text-error shrink-0">
                  <XCircle className="w-5 h-5" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ──────────────── Unified Command Center ──────────────── */}
          <motion.div
            layout
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            className={`relative overflow-hidden rounded-[28px] transition-colors duration-300 ${
              isListening
                ? "bg-gradient-to-br from-[#2d1b69]/40 via-surface to-surface2 border border-[#7c3aed]/40 dark:border-[#7c3aed]/25 shadow-[0_16px_56px_rgba(124,58,237,0.12)] dark:shadow-[0_20px_64px_rgba(124,58,237,0.25)]"
                : isRunning
                ? "bg-gradient-to-br from-surface via-surface to-surface2 border border-success/35 dark:border-success/15 shadow-[0_12px_48px_rgba(16,185,129,0.06)] dark:shadow-[0_16px_56px_rgba(0,0,0,0.6)]"
                : "premium-card border border-border/40 dark:border-border/10 shadow-[0_12px_40px_rgba(0,0,0,0.04)] dark:shadow-[0_16px_56px_rgba(0,0,0,0.6)]"
            }`}
          >
            {/* Status Indicator Bar */}
            <AnimatePresence>
              {(isRunning || isListening) && (
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  exit={{ scaleX: 0 }}
                  transition={{ duration: 0.5 }}
                  className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent ${isListening ? "via-[#a78bfa]" : "via-success"} to-transparent origin-left`}
                />
              )}
            </AnimatePresence>

            <div className="p-8 space-y-5">
              {/* Header Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {isListening ? (
                    <div className="w-8 h-8 rounded-xl bg-[#7c3aed]/15 dark:bg-[#7c3aed]/10 border border-[#7c3aed]/30 dark:border-[#7c3aed]/15 flex items-center justify-center shrink-0">
                      <Mic className="w-4 h-4 text-[#a78bfa]" />
                    </div>
                  ) : isRunning ? (
                    <div className="w-8 h-8 rounded-xl bg-success/10 dark:bg-success/5 border border-success/20 dark:border-success/10 flex items-center justify-center shrink-0">
                      <Loader2 className="w-4 h-4 animate-spin text-success" />
                    </div>
                  ) : null}
                  <div className="min-w-0">
                    <h3 className="text-lg font-black text-text tracking-tight leading-tight">
                      {isListening
                        ? "Listening…"
                        : isRunning
                        ? status === "thinking" ? "Planning your task..." : "Executing task"
                        : "Run Automation Task"}
                    </h3>
                    {!isRunning && !isListening && (
                      <p className="text-xs text-text-muted mt-0.5">
                        Natural language instructions → automated actions
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isListening && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-[10px] bg-[#7c3aed]/15 border border-[#7c3aed]/25 px-2.5 py-1 rounded-full text-[#a78bfa] flex items-center gap-1.5 font-black uppercase tracking-wider"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[#a78bfa] animate-pulse" />
                      Listening
                    </motion.span>
                  )}
                  {isRunning && !isListening && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-[10px] bg-success/10 border border-success/20 dark:border-success/10 px-2.5 py-1 rounded-full text-success flex items-center gap-1.5 font-black uppercase tracking-wider"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                      Live
                    </motion.span>
                  )}
                  {isRunning && (
                    <button
                      onClick={handleStopTask}
                      className="px-3.5 py-1.5 bg-error/10 hover:bg-error/20 text-error border border-error/20 dark:border-error/10 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors"
                    >
                      <Square className="w-3 h-3 fill-current" /> Stop
                    </button>
                  )}
                </div>
              </div>

              {/* ─── Live Voice Waveform (when listening via mic) ─── */}
              <AnimatePresence>
                {isListening && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col items-center gap-3 py-6 px-4">
                      <WaveformBars level={audioLevel} />
                      <p className="text-xs text-[#a78bfa] font-bold uppercase tracking-widest">
                        🎙 Speak now — Omni is listening
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>



              {/* ─── Live Execution Steps (when running) ─── */}
              <AnimatePresence>
                {liveSteps.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {liveSteps.map((step) => (
                        <motion.div
                          key={step.step_num}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.2 }}
                          className="flex items-start gap-3 p-3 bg-surface2/60 border border-border/20 dark:border-border/5 rounded-xl"
                        >
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 mt-0.5 ${
                            step.success ? "bg-success/15 text-success" : "bg-error/15 text-error"
                          }`}>
                            {step.success ? "✓" : "✗"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-text leading-tight truncate">{step.thought}</p>
                            {step.description && (
                              <p className="text-xs text-text-muted mt-0.5 truncate">{step.description}</p>
                            )}
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ─── Running Status Text (when running, no steps yet) ─── */}
              <AnimatePresence>
                {isRunning && liveSteps.length === 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-3 text-sm text-text-secondary"
                  >
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                    <span>{status === "thinking" ? "Analyzing instruction and planning actions..." : `Working on: ${activeTaskDesc}`}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ─── Dynamic Input Area (when idle or when question pending) ─── */}
              {!isListening && (
              <form onSubmit={handleStartTask}>
                <div className={`relative bg-surface2/80 rounded-2xl transition-all duration-200 ${
                  isRunning
                    ? "opacity-40 pointer-events-none"
                    : "focus-within:ring-4 focus-within:ring-accent/10 focus-within:shadow-[0_0_24px_rgba(244,244,245,0.03)]"
                } border border-border/30 dark:border-border/10 focus-within:border-accent/30`}>
                  <textarea
                    ref={textareaRef}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleStartTask(e as any);
                      }
                    }}
                    disabled={isRunning}
                    placeholder={
                      !hasAnyModel
                        ? "Configure an AI model in Settings to start automation..."
                        : isRunning
                        ? "Task in progress..."
                        : "Tell Omni what to do — e.g. \"Open Chrome, search for Nvidia stock price, and paste it into Notepad\""
                    }
                    rows={1}
                    className="w-full bg-transparent border-0 px-5 pt-4.5 pb-1 text-text text-[15px] focus:ring-0 focus:outline-none resize-none placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed overflow-hidden"
                    style={{ minHeight: "42px", maxHeight: "208px" }}
                  />

                  <div className="flex justify-between items-center px-5 pb-3.5 pt-1">
                    <span className="text-[11px] text-text-muted font-medium select-none">
                      {instruction.length > 0
                        ? `${instruction.length} chars`
                        : "↵ Enter to send · ⇧↵ new line"
                      }
                    </span>

                    <motion.button
                      type="submit"
                      disabled={!instruction.trim() || !hasAnyModel || isRunning}
                      whileHover={{ scale: 1.03 }}
                      whileTap={{ scale: 0.95 }}
                      className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-accent-contrast rounded-xl font-bold text-sm flex items-center gap-2 transition-all disabled:opacity-20 shadow-sm"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Run</span>
                    </motion.button>
                  </div>
                </div>
              </form>
              )}
            </div>
          </motion.div>

          {/* Timeline Feed */}
          <div className="space-y-8">
            {Object.keys(groupedTasks).map((dateStr) => (
              <div key={dateStr} className="space-y-4">
                <h3 className="text-[11px] font-black text-text-muted tracking-widest uppercase mt-4 mb-2">
                  {dateStr}
                </h3>
                
                <div className="bg-surface border border-border dark:border-border/20 rounded-[28px] overflow-hidden shadow-sm divide-y divide-border/40 dark:divide-border/15 premium-card">
                  {groupedTasks[dateStr].map((task) => {
                    const isExpanded = expandedTaskId === task.id;
                    let parsedSteps: StepProgress[] = [];
                    if (task.steps_json) {
                      try { parsedSteps = JSON.parse(task.steps_json); } catch(_) {}
                    }
                              return (
                      <div key={task.id} className="transition-all">
                        {/* Task Row Header */}
                        <div
                          onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                          className="w-full px-9 py-5.5 flex items-start justify-between gap-5 hover:bg-surface2/30 transition-colors cursor-pointer select-none"
                        >
                          {/* Time & Glowing Status Dot */}
                          <div className="flex items-center gap-3 shrink-0 w-28 text-text-muted">
                            <span className="text-xs font-semibold">
                              {formatTime(task.created_at)}
                            </span>
                            <span className={`w-2 h-2 rounded-full shrink-0 ${
                              task.status === "completed" ? "status-dot-completed" :
                              task.status === "failed" ? "status-dot-failed" :
                              task.status === "cancelled" ? "status-dot-cancelled" :
                                                           "status-dot-running animate-pulse"
                            }`} title={task.status} />
                          </div>

                          {/* Task Description (serif Georgia font for a clean notebook feel) */}
                          <p className="flex-1 min-w-0 text-[16px] font-serif font-medium text-text leading-relaxed pr-3 whitespace-pre-wrap">
                            {task.description}
                          </p>

                          {/* Chevron Action */}
                          <div className="shrink-0 pt-0.5">
                            <ChevronRight className={`w-4.5 h-4.5 text-text-muted transition-transform ${isExpanded ? "rotate-90 text-text" : ""}`} />
                          </div>
                        </div>

                        {/* Collapsible Steps */}
                        <AnimatePresence initial={false}>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden bg-surface2/15 border-t border-border/40"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="p-6.5 space-y-4">
                                <div className="flex items-center justify-between border-b border-border/40 pb-3.5 mb-2.5">
                                  <div className="text-[11px] font-black text-text-muted uppercase tracking-wider">
                                    Execution Steps ({parsedSteps.length})
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-text-muted font-bold uppercase tracking-wider">Status:</span>
                                    <span className={`px-2.5 py-1 rounded-xl text-[10.5px] font-black uppercase tracking-wider flex items-center gap-1.5 border ${
                                      task.status === "completed" ? "bg-success/10 text-success border-success/20" :
                                      task.status === "failed"    ? "bg-error-dim/20 text-error border-error/20" :
                                      task.status === "cancelled" ? "bg-warning/10 text-warning border-warning/20" :
                                                                   "bg-accent/10 text-accent border-accent/20"
                                    }`}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${
                                        task.status === "completed" ? "bg-success" :
                                        task.status === "failed" ? "bg-error" :
                                        task.status === "cancelled" ? "bg-warning" :
                                                                     "bg-accent animate-pulse"
                                      }`} />
                                      {task.status}
                                    </span>
                                  </div>
                                </div>
                                {parsedSteps.length > 0 ? (
                                  <div className="space-y-3">
                                    {parsedSteps.map((step) => (
                                      <div key={step.step_num} className="p-4 bg-surface border border-border/60 rounded-2xl flex items-start gap-3.5 shadow-sm">
                                        <span className="w-6.5 h-6.5 rounded-full bg-accent-dim border border-border text-accent flex items-center justify-center text-xs font-black shrink-0 mt-0.5">
                                          {step.step_num}
                                        </span>
                                        <div className="flex-1 space-y-1 min-w-0">
                                          <p className="text-sm font-extrabold text-text leading-tight">{step.thought}</p>
                                          <p className="text-xs text-text-secondary break-words">{step.description}</p>
                                        </div>
                                        {step.success ? (
                                          <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                                        ) : (
                                          <XCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-sm text-text-muted italic">No step logs available for this task.</p>
                                )}
                                
                                {task.outcome && (
                                  <div className="mt-4 p-4 bg-surface border border-border/40 rounded-2xl">
                                    <div className="text-[11px] font-black text-text-muted uppercase tracking-wider">Final Outcome</div>
                                    <p className="text-sm text-text mt-1.5 leading-relaxed font-normal">{task.outcome}</p>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            
            {tasks.length === 0 && (
              <p className="text-sm text-text-muted text-center py-16">No tasks recorded yet. Type a command above to start.</p>
            )}
          </div>

        </div>

        {/* Right Column */}
        <div className="col-span-4 space-y-8">
          
          {/* Stats Card */}
          <div className="premium-card p-8 space-y-7">
            <div>
              <div className="text-5xl font-serif font-black text-text tracking-tight">
                {totalTasks}
              </div>
              <div className="text-[11.5px] font-sans font-black text-text-muted uppercase tracking-widest mt-1.5">
                total tasks
              </div>
            </div>
            
            <div className="border-t border-border/40 dark:border-border/10" />
            
            <div>
              <div className="text-5xl font-serif font-black text-text tracking-tight">
                {totalTasks > 0 ? `${successRate}%` : "—"}
              </div>
              <div className="text-[11.5px] font-sans font-black text-text-muted uppercase tracking-widest mt-1.5">
                success rate
              </div>
            </div>

            <div className="border-t border-border/40 dark:border-border/10" />

            <div>
              <div className="text-5xl font-serif font-black text-text tracking-tight">
                {timeSaved}m
              </div>
              <div className="text-[11.5px] font-sans font-black text-text-muted uppercase tracking-widest mt-1.5">
                time saved
              </div>
            </div>
          </div>

          {/* Voice Profile Card */}
          <div className="premium-card p-8 flex justify-between items-center gap-5 shadow-md rounded-[28px]">
            <div className="space-y-1.5">
              <div className="text-[12px] font-black text-text-muted uppercase tracking-wider">Voice Profile</div>
              <div className="text-lg font-black text-text">Research Navigator</div>
              <p className="text-xs text-text-secondary leading-normal">Optimized for keyboard & screen automation</p>
            </div>
            <div className="w-14 h-14 rounded-[18px] bg-accent-dim border border-border/85 flex items-center justify-center text-2xl shrink-0 shadow-sm">
              🎙️
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
