import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Play, Square, Loader2, CheckCircle2, AlertTriangle,
  XCircle, Clock, AlertCircle, Eye, EyeOff, RefreshCw
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
  // Pending question from the agent (free-text answer needed)
  const [pendingQuestion, setPendingQuestion] = useState<{ id: string; question: string } | null>(null);
  const [answerText, setAnswerText] = useState("");

  // Find the active vision model
  const activeVisionModel = models.find((m) => m.is_active && m.role_vision);
  const activeAnyModel = models.find((m) => m.is_active);
  const hasVision = modelHasVision(activeVisionModel || activeAnyModel);
  const hasAnyModel = models.length > 0;

  // Listen to live task events
  useEffect(() => {
    const cleanups: Array<() => void> = [];

    async function setup() {
      cleanups.push(
        await listen<any>("task:started", () => {
          setStatus("thinking");
          setIsTaskRunning(true);
          setLiveSteps([]);
          setErrorMsg("");
        })
      );

      cleanups.push(
        await listen<StepProgress>("task:step", (event) => {
          setStatus("working");
          setLiveSteps((prev) => {
            const step = event.payload;
            if (prev.some((s) => s.step_num === step.step_num)) return prev;
            return [...prev, step];
          });
        })
      );

      cleanups.push(
        await listen<any>("task:done", () => {
          setStatus("success");
          setIsTaskRunning(false);
          setPendingQuestion(null);
          fetchLocalData();
          // Auto-reset to idle after 3s
          setTimeout(() => setStatus("idle"), 3000);
        })
      );

      cleanups.push(
        await listen<any>("task:failed", (event) => {
          setStatus("error");
          setIsTaskRunning(false);
          setPendingQuestion(null);
          setErrorMsg(event.payload?.error || "Task failed.");
          fetchLocalData();
        })
      );

      cleanups.push(
        await listen("agent:killed", () => {
          setStatus("idle");
          setIsTaskRunning(false);
          setPendingQuestion(null);
          setLiveSteps([]);
        })
      );

      // Agent asks a free-text question — show the answer box
      cleanups.push(
        await listen<{ id: string; question: string }>("question:request", (event) => {
          setPendingQuestion({ id: event.payload.id, question: event.payload.question });
          setAnswerText("");
        })
      );

      // From voice/text overlay — track running state
      cleanups.push(
        await listen<any>("voice:transcript", (event) => {
          setStatus("thinking");
          setIsTaskRunning(true);
          setActiveTaskDesc(event.payload.text || "Voice command");
          setLiveSteps([]);
          setErrorMsg("");
        })
      );
    }

    setup();
    return () => cleanups.forEach((fn) => fn());
  }, [fetchLocalData]);

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
      setPendingQuestion(null);
      setLiveSteps([]);
    } catch (e) {
      console.error("Failed to cancel task", e);
    }
  };

  // Submit the typed answer to the agent's question
  const handleSubmitAnswer = async () => {
    if (!pendingQuestion) return;
    const ans = answerText.trim();
    if (!ans) return;
    try {
      await invoke("answer_question", { id: pendingQuestion.id, answer: ans });
      setPendingQuestion(null);
      setAnswerText("");
    } catch (e) {
      console.error("Failed to submit answer", e);
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

  // Heatmap
  const activityHeatmap = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    const dStr = d.toISOString().split("T")[0];
    return { date: dStr, count: tasks.filter((t) => t.created_at.startsWith(dStr)).length };
  });

  const isRunning = status === "thinking" || status === "working";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-text">Dashboard</h1>
          <p className="text-text-secondary text-sm">Monitor agent activities and trigger automated workflows.</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Vision capability badge */}
          {hasAnyModel && (
            <div className={`px-2.5 py-1 rounded-md border flex items-center gap-1.5 text-xs font-semibold ${
              hasVision
                ? "bg-success/10 border-success/20 text-success"
                : "bg-warning/10 border-warning/20 text-warning"
            }`}>
              {hasVision
                ? <><Eye className="w-3.5 h-3.5" /> Screen Vision</>
                : <><EyeOff className="w-3.5 h-3.5" /> Text Only</>
              }
            </div>
          )}

          {activeAnyModel && (
            <div className="px-3 py-1.5 bg-accent-dim/20 border border-accent/25 rounded-md flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-xs font-semibold text-text">
                {activeAnyModel.display_name} · {activeAnyModel.model_name}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* No model warning */}
      {!hasAnyModel && (
        <div className="p-4 bg-error-dim/20 border border-error/30 rounded-xl flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error shrink-0" />
          <div>
            <p className="text-sm font-semibold text-error">No AI model configured</p>
            <p className="text-xs text-text-secondary mt-0.5">
              Go to <strong>Settings → Model Registry</strong> and add an AI model to enable automation.
            </p>
          </div>
        </div>
      )}

      {/* Text-only warning (no vision model) */}
      {hasAnyModel && !hasVision && (
        <div className="p-4 bg-warning/10 border border-warning/25 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-warning">Running in text-only mode</p>
            <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
              Your current model (<strong>{activeAnyModel?.model_name}</strong>) does not support screen vision.
              Automation will work based on task description only — the AI cannot see your screen.
              Add a vision model (GPT-4o, Claude 3, or Gemini) in <strong>Settings → Model Registry</strong> for full screen automation.
            </p>
          </div>
        </div>
      )}

      {/* Live Status Banner */}
      <div className={`p-5 rounded-xl border transition-all duration-300 ${
        status === "idle"    ? "bg-surface border-border" :
        status === "thinking"? "bg-accent-dim/15 border-accent/40" :
        status === "working" ? "bg-accent-dim/20 border-accent/50 animate-pulse" :
        status === "success" ? "bg-success/15 border-success/30" :
                               "bg-error-dim/15 border-error/30"
      }`}>
        <div className="flex justify-between items-start gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="mt-0.5 shrink-0">
              {status === "idle"     && <CheckCircle2 className="w-5 h-5 text-text-muted" />}
              {status === "thinking" && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
              {status === "working"  && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
              {status === "success"  && <CheckCircle2 className="w-5 h-5 text-success" />}
              {status === "error"    && <AlertTriangle className="w-5 h-5 text-error" />}
            </div>

            <div className="flex-1 min-w-0">
              <h3 className={`font-semibold text-sm ${
                status === "success" ? "text-success" :
                status === "error"   ? "text-error"   : "text-text"
              }`}>
                {status === "idle"     && "Omni is ready"}
                {status === "thinking" && "Planning task..."}
                {status === "working"  && `Executing: ${activeTaskDesc}`}
                {status === "success"  && "Task completed!"}
                {status === "error"    && "Task failed"}
              </h3>
              <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                {status === "idle" && (
                  <>
                    Hold <kbd className="px-1 py-0.5 bg-surface2 border border-border rounded text-[10px] font-mono text-text">Ctrl+Shift+A</kbd> to speak, or type below. {!hasVision && <span className="text-warning">Screen vision disabled.</span>}
                  </>
                )}
                {status === "thinking" && "AI is analyzing the instruction and planning actions..."}
                {status === "working"  && `Step ${liveSteps.length} completed — continuing...`}
                {status === "success"  && "All actions resolved. Task saved to Activity log."}
                {status === "error"    && <span className="font-mono text-[11px] break-all">{errorMsg}</span>}
              </p>
            </div>
          </div>

          {/* Stop button — always shows when task is running */}
          {isRunning && (
            <button
              onClick={handleStopTask}
              className="px-3 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0"
            >
              <Square className="w-3.5 h-3.5 fill-current" /> Stop
            </button>
          )}

          {status === "error" && (
            <button
              onClick={handleDismissError}
              className="p-1.5 text-text-muted hover:text-text shrink-0"
            >
              <XCircle className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Live step timeline */}
        {liveSteps.length > 0 && (
          <div className="mt-4 border-t border-border pt-4 space-y-2 max-h-56 overflow-y-auto pr-1">
            <h4 className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Live Action Stream</h4>
            {liveSteps.map((step) => (
              <div key={step.step_num} className="p-2.5 bg-surface2 border border-border rounded-lg flex items-start gap-2.5">
                <span className="w-5 h-5 rounded-full bg-accent-dim/30 border border-accent/25 text-accent flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                  {step.step_num}
                </span>
                <div className="flex-1 space-y-0.5 min-w-0">
                  <p className="text-xs font-semibold text-text leading-tight">{step.thought}</p>
                  {step.tool && (
                    <span className="inline-block px-1.5 py-0.5 bg-surface3 border border-border rounded text-[10px] font-mono text-accent">
                      {step.tool}
                    </span>
                  )}
                  <p className="text-[11px] text-text-secondary break-words">{step.description}</p>
                </div>
                {step.success
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-1" />
                  : <XCircle    className="w-3.5 h-3.5 text-error shrink-0 mt-1" />
                }
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent Question — chat answer box (appears only when agent asks something) */}
      {pendingQuestion && (
        <div className="bg-gradient-to-br from-accent/10 to-surface border-2 border-accent/40 rounded-xl p-5 shadow-lg space-y-3 animate-[fadeIn_0.25s_ease-out]">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
              <AlertCircle className="w-4 h-4 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-accent uppercase tracking-wider mb-1">Agent needs your answer</p>
              <p className="text-sm font-semibold text-text leading-snug">{pendingQuestion.question}</p>
            </div>
          </div>
          <div className="relative">
            <input
              autoFocus
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmitAnswer();
                }
              }}
              placeholder="Type your answer and press Enter…"
              className="w-full bg-surface2 border border-accent/30 rounded-lg px-4 py-3 pr-14 text-text text-sm focus:outline-none focus:border-accent placeholder:text-text-muted"
            />
            <button
              onClick={handleSubmitAnswer}
              disabled={!answerText.trim()}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-accent hover:bg-accent-hover text-accent-contrast rounded-md transition-colors disabled:opacity-40"
              title="Send answer (Enter)"
            >
              <Play className="w-4 h-4 fill-current" />
            </button>
          </div>
          <p className="text-[10px] text-text-muted">
            The agent is paused waiting for this answer. You can also answer from the floating overlay.
          </p>
        </div>
      )}

      {/* Command Box — always visible, disabled while running */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-text uppercase tracking-wider">Type a Command</label>
          {isRunning && (
            <span className="text-[10px] text-text-muted flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Agent is running...
            </span>
          )}
        </div>
        <form onSubmit={handleStartTask}>
          <div className="relative">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleStartTask(e as any);
                }
              }}
              disabled={isRunning || !hasAnyModel}
              placeholder={
                !hasAnyModel
                  ? "Add a model in Settings to enable commands..."
                  : isRunning
                  ? "Agent is currently running a task..."
                  : "e.g. Open Notepad and write 'Hello World'... (Enter to run)"
              }
              rows={2}
              className="w-full bg-surface2 border border-border rounded-lg px-4 py-3 pr-14 text-text text-sm focus:outline-none focus:border-accent resize-none placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {!isRunning && (
              <button
                type="submit"
                disabled={!instruction.trim() || !hasAnyModel}
                className="absolute right-3 bottom-3 p-2 bg-accent hover:bg-accent-hover text-accent-contrast rounded-md transition-colors disabled:opacity-40"
                title="Run command (Enter)"
              >
                <Play className="w-4 h-4 fill-current" />
              </button>
            )}
            {isRunning && (
              <button
                type="button"
                onClick={handleStopTask}
                className="absolute right-3 bottom-3 p-2 bg-error/20 hover:bg-error/35 text-error border border-error/30 rounded-md transition-colors"
                title="Stop task"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Tasks Run",   value: totalTasks,       desc: "Across all sessions" },
          { label: "Time Saved",        value: `${timeSaved}m`,  desc: "At 2.5 min per task" },
          { label: "Success Rate",      value: totalTasks > 0 ? `${successRate}%` : "—", desc: "Completed without error" },
          { label: "Active Provider",   value: activeAnyModel?.provider_type || "None", desc: activeAnyModel?.model_name || "Configure in Settings" },
        ].map((card, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-1">
            <span className="text-xs font-semibold text-text-secondary">{card.label}</span>
            <div className="text-2xl font-bold text-text tracking-tight">{card.value}</div>
            <p className="text-xs text-text-muted">{card.desc}</p>
          </div>
        ))}
      </div>

      {/* Lower Row */}
      <div className="grid grid-cols-12 gap-6">
        {/* Heatmap */}
        <div className="col-span-4 bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="font-semibold text-text text-sm">Fortnight Activity</h3>
            <p className="text-xs text-text-secondary">Task volume over the past 14 days.</p>
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {activityHeatmap.map((item, i) => (
              <div
                key={i}
                title={`${item.date}: ${item.count} tasks`}
                className={`aspect-square rounded flex items-center justify-center text-[9px] font-bold transition-colors ${
                  item.count === 0   ? "bg-surface2 border border-border text-text-muted" :
                  item.count < 3     ? "bg-accent/20 border border-accent/25 text-accent" :
                                       "bg-accent text-accent-contrast border border-accent"
                }`}
              >
                {item.count > 0 ? item.count : ""}
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-text-muted">
            <span>14 days ago</span><span>Today</span>
          </div>
        </div>

        {/* Recent tasks */}
        <div className="col-span-8 bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-text text-sm">Recent Task Executions</h3>
              <p className="text-xs text-text-secondary">Latest tasks run by the agent.</p>
            </div>
            <button
              onClick={fetchLocalData}
              className="p-1.5 text-text-muted hover:text-text border border-border hover:border-border-light rounded-lg bg-surface2 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {tasks.slice(0, 5).map((task) => (
              <div key={task.id} className="p-3 bg-surface2 border border-border rounded-lg flex justify-between items-center gap-2">
                <div className="space-y-0.5 flex-1 min-w-0">
                  <p className="text-xs font-semibold text-text truncate">{task.description}</p>
                  <div className="flex gap-2 items-center text-[10px] text-text-muted">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>{new Date(task.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                  task.status === "completed" ? "bg-success/10 text-success border border-success/20" :
                  task.status === "failed"    ? "bg-error/10 text-error border border-error/20" :
                  task.status === "cancelled" ? "bg-warning/10 text-warning border border-warning/20" :
                                               "bg-accent/10 text-accent border border-accent/20 animate-pulse"
                }`}>
                  {task.status}
                </span>
              </div>
            ))}
            {tasks.length === 0 && (
              <p className="text-xs text-text-muted text-center py-10">No tasks recorded yet. Type a command above to start.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
