import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, Square, Loader2, CheckCircle2, AlertTriangle, XCircle, Clock } from "lucide-react";

interface StepProgress {
  step_num: number;
  thought: string;
  tool: string | null;
  description: string;
  success: boolean;
}

export const Home: React.FC = () => {
  const { session, tasks, models, fetchLocalData } = useStore();
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<"idle" | "thinking" | "working" | "success" | "error">("idle");
  const [activeTaskDesc, setActiveTaskDesc] = useState("");
  const [liveSteps, setLiveSteps] = useState<StepProgress[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  const activeModel = models.find((m) => m.is_active);

  // Listen to live steps emitted by the ReAct planner loop in Rust
  useEffect(() => {
    let unlistenStep: (() => void) | null = null;
    let unlistenStarted: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;

    async function setupListeners() {
      unlistenStarted = await listen<any>("task:started", () => {
        setStatus("thinking");
        setLiveSteps([]);
        setErrorMsg("");
      });

      unlistenStep = await listen<StepProgress>("task:step", (event) => {
        setStatus("working");
        setLiveSteps((prev) => {
          const step = event.payload;
          // Avoid duplicate steps if re-emitted
          if (prev.some((s) => s.step_num === step.step_num)) return prev;
          return [...prev, step];
        });
      });

      unlistenDone = await listen<any>("task:done", () => {
        setStatus("success");
        fetchLocalData();
      });

      unlistenFailed = await listen<any>("task:failed", (event) => {
        setStatus("error");
        setErrorMsg(event.payload?.error || "Task failed execution.");
        fetchLocalData();
      });
    }

    setupListeners();

    return () => {
      if (unlistenStep) unlistenStep();
      if (unlistenStarted) unlistenStarted();
      if (unlistenDone) unlistenDone();
      if (unlistenFailed) unlistenFailed();
    };
  }, [fetchLocalData]);

  const handleStartTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instruction.trim() || !session) return;

    setStatus("thinking");
    setActiveTaskDesc(instruction);
    setLiveSteps([]);
    setErrorMsg("");

    try {
      await invoke("run_task", {
        instruction,
        userId: session.user.id
      });
    } catch (e: any) {
      console.error(e);
      setStatus("error");
      setErrorMsg(e.toString());
    }
  };

  const handleStopTask = async () => {
    try {
      await invoke("cancel_task");
      setStatus("idle");
    } catch (e) {
      console.error("Failed to cancel task", e);
    }
  };

  // Helper Stats Calculation
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;
  const timeSaved = completedTasks * 2.5; // 2.5 minutes saved per completed task

  // Heatmap helper (last 14 days activity)
  const getLastFortnight = () => {
    const dates = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      dates.push(d);
    }
    return dates;
  };

  const activityHeatmap = getLastFortnight().map((d) => {
    const dStr = d.toISOString().split("T")[0];
    const dayTasksCount = tasks.filter((t) => t.created_at.startsWith(dStr)).length;
    return { date: dStr, count: dayTasksCount };
  });

  return (
    <div className="space-y-6">
      {/* Page Title & Active Model Info */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-text">Dashboard</h1>
          <p className="text-text-secondary text-sm">Monitor agent activities and trigger automated workflows.</p>
        </div>
        {activeModel && (
          <div className="px-3 py-1.5 bg-accent-dim/20 border border-accent/25 rounded-md flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-semibold text-text">Active Model: {activeModel.display_name} ({activeModel.model_name})</span>
          </div>
        )}
      </div>

      {/* Live Status Banner */}
      <div className={`p-5 rounded-xl border transition-all duration-300 ${
        status === "idle" ? "bg-surface border-border" :
        status === "thinking" ? "bg-accent-dim/15 border-accent/40 text-text" :
        status === "working" ? "bg-accent-dim/20 border-accent/50 text-text animate-pulse" :
        status === "success" ? "bg-success/15 border-success/30 text-success" :
        "bg-error-dim/15 border-error/30 text-error"
      }`}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            {status === "idle" && <CheckCircle2 className="w-5 h-5 text-text-muted" />}
            {status === "thinking" && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
            {status === "working" && <Loader2 className="w-5 h-5 animate-spin text-accent" />}
            {status === "success" && <CheckCircle2 className="w-5 h-5 text-success" />}
            {status === "error" && <AlertTriangle className="w-5 h-5 text-error" />}

            <div>
              <h3 className="font-semibold text-sm">
                {status === "idle" && "Omni is Idle"}
                {status === "thinking" && "Omni is Orchestrating..."}
                {status === "working" && `Executing Task: ${activeTaskDesc}`}
                {status === "success" && "Task Completed Successfully!"}
                {status === "error" && "Execution Error Encountered"}
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                {status === "idle" && "Ready to take tasks. Hold Ctrl + Shift + A to speak (or type below). Customize in Settings → Hotkeys."}
                {status === "thinking" && "Analyzing instruction and mapping system dependencies."}
                {status === "working" && `Step ${liveSteps.length + 1} - Routing actions.`}
                {status === "success" && "All actions resolved successfully. State saved locally."}
                {status === "error" && errorMsg}
              </p>
            </div>
          </div>

          {status !== "idle" && status !== "success" && status !== "error" && (
            <button
              onClick={handleStopTask}
              className="px-3 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Square className="w-3.5 h-3.5" /> Stop Task
            </button>
          )}
        </div>

        {/* Live ReAct Step Timeline */}
        {liveSteps.length > 0 && (
          <div className="mt-4 border-t border-border pt-4 space-y-3 max-h-52 overflow-y-auto pr-2">
            <h4 className="text-xs font-bold text-text-secondary uppercase tracking-wider">Live Action Stream</h4>
            {liveSteps.map((step) => (
              <div key={step.step_num} className="p-3 bg-surface2 border border-border rounded-lg flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-accent-dim text-accent flex items-center justify-center text-xs font-bold shrink-0">
                  {step.step_num}
                </span>
                <div className="flex-1 space-y-1">
                  <p className="text-xs font-bold text-text">{step.thought}</p>
                  {step.tool && (
                    <span className="inline-block px-1.5 py-0.5 bg-surface3 border border-border rounded text-[10px] font-mono text-accent">
                      Tool Call: {step.tool}
                    </span>
                  )}
                  <p className="text-xs text-text-secondary">{step.description}</p>
                </div>
                {step.success ? (
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Command Box */}
      {status === "idle" && (
        <form onSubmit={handleStartTask} className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-3">
          <label className="block text-xs font-semibold text-text uppercase tracking-wider">Type a Command</label>
          <div className="relative">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Open notepad and write a summary of the current marketing report..."
              rows={2}
              className="w-full bg-surface2 border border-border rounded-lg px-4 py-3 text-text text-sm focus:outline-none focus:border-accent resize-none placeholder:text-text-muted"
            />
            <button
              type="submit"
              disabled={!instruction.trim()}
              className="absolute right-3 bottom-3 p-2 bg-accent hover:bg-accent-hover text-accent-contrast rounded-md transition-colors disabled:opacity-40"
            >
              <Play className="w-4 h-4 fill-current" />
            </button>
          </div>
        </form>
      )}

      {/* Quick Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Tasks Run", value: totalTasks, desc: "Across this workspace" },
          { label: "Time Saved", value: `${timeSaved}m`, desc: "Total accumulated hours" },
          { label: "Success Rate", value: `${successRate}%`, desc: "Completed tasks without error" },
          { label: "Active LLM Provider", value: activeModel?.provider_type || "None", desc: activeModel?.model_name || "Configure in Settings" }
        ].map((card, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-1">
            <span className="text-xs font-semibold text-text-secondary">{card.label}</span>
            <div className="text-2xl font-bold text-text tracking-tight">{card.value}</div>
            <p className="text-xs text-text-muted">{card.desc}</p>
          </div>
        ))}
      </div>

      {/* Lower Row: Heatmap & Recent Tasks */}
      <div className="grid grid-cols-12 gap-6">
        {/* Heatmap Card */}
        <div className="col-span-4 bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="font-semibold text-text text-sm">Fortnight Activity</h3>
            <p className="text-xs text-text-secondary">Task volume over the past two weeks.</p>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {activityHeatmap.map((item, index) => (
              <div
                key={index}
                title={`${item.date}: ${item.count} tasks`}
                className={`aspect-square rounded-md flex flex-col items-center justify-center text-[10px] font-semibold transition-colors ${
                  item.count === 0 ? "bg-surface2 text-text-muted border border-border" :
                  item.count < 3 ? "bg-accent-dim/30 border border-accent/20 text-accent-hover" :
                  "bg-accent text-accent-contrast border border-accent"
                } shadow-sm font-semibold`}
              >
                {item.count > 0 ? item.count : ""}
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-text-muted">
            <span>14 days ago</span>
            <span>Today</span>
          </div>
        </div>

        {/* Recent tasks feed */}
        <div className="col-span-8 bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="font-semibold text-text text-sm">Recent Task Executions</h3>
            <p className="text-xs text-text-secondary">Latest tasks run by the agent.</p>
          </div>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {tasks.slice(0, 5).map((task) => (
              <div key={task.id} className="p-3 bg-surface2 border border-border rounded-lg flex justify-between items-center">
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-text truncate max-w-md">{task.description}</p>
                  <div className="flex gap-2 items-center text-[10px] text-text-muted">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(task.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                  task.status === "completed" ? "bg-success/10 text-success border border-success/20" :
                  task.status === "failed" ? "bg-error/10 text-error border border-error/20" :
                  task.status === "cancelled" ? "bg-warning/10 text-warning border border-warning/20" :
                  "bg-accent-dim/25 text-accent border border-accent/30 animate-pulse"
                }`}>
                  {task.status}
                </span>
              </div>
            ))}
            {tasks.length === 0 && (
              <p className="text-xs text-text-muted text-center py-8">No tasks recorded in this session.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
