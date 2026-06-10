import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Download, ChevronDown,
  Calendar, Square, Terminal, Eye, MessageSquare, CheckCircle2, XCircle, AlertTriangle
} from "lucide-react";

// ── Tool badge colour ───────────────────────────────────────────────────────
const toolColor = (tool: string | null) => {
  if (!tool) return "text-text-muted bg-surface3 border-border";
  const t = tool.toLowerCase();
  if (t === "mouse")     return "text-blue-400 bg-blue-400/10 border-blue-400/25";
  if (t === "keyboard")  return "text-purple-400 bg-purple-400/10 border-purple-400/25";
  if (t === "screen")    return "text-cyan-400 bg-cyan-400/10 border-cyan-400/25";
  if (t === "app")       return "text-orange-400 bg-orange-400/10 border-orange-400/25";
  if (t === "file")      return "text-yellow-400 bg-yellow-400/10 border-yellow-400/25";
  if (t === "clipboard") return "text-green-400 bg-green-400/10 border-green-400/25";
  return "text-text-muted bg-surface3 border-border";
};

export const Activity: React.FC = () => {
  const { tasks, fetchLocalData } = useStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed" | "failed" | "cancelled">("all");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const runningTasks = tasks.filter((t) => t.status === "running");

  // Refresh on mount + listen to task events
  useEffect(() => {
    fetchLocalData();
    const cleanups: Array<() => void> = [];
    (async () => {
      for (const evt of ["task:started", "task:step", "task:done", "task:failed", "agent:killed"]) {
        cleanups.push(await listen(evt, () => fetchLocalData()));
      }
    })();
    return () => cleanups.forEach((fn) => fn());
  }, [fetchLocalData]);

  // Poll while running
  useEffect(() => {
    if (runningTasks.length === 0) return;
    const id = setInterval(() => fetchLocalData(), 2000);
    return () => clearInterval(id);
  }, [runningTasks.length, fetchLocalData]);

  const toggleExpand = (taskId: string) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  const handleStopTask = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setStoppingId(taskId);
    try {
      await invoke("cancel_task");
      await invoke("force_cancel_task", { taskId });
      await new Promise((r) => setTimeout(r, 400));
      await fetchLocalData();
    } catch (err) {
      console.error("Failed to stop task:", err);
      await fetchLocalData();
    } finally {
      setStoppingId(null);
    }
  };

  const handleExportCSV = () => {
    if (tasks.length === 0) return;
    const rows = tasks.map((t) => [t.id, `"${t.description.replace(/"/g, '""')}"`, t.status, t.outcome ? `"${t.outcome.replace(/"/g, '""')}"` : "", t.created_at]);
    const csv = [["ID","Description","Status","Outcome","Created"].join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `omni_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const filtered = tasks.filter((t) => {
    const ms = t.description.toLowerCase().includes(searchQuery.toLowerCase());
    const mf = statusFilter === "all" || t.status === statusFilter;
    return ms && mf;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-text">Activity Logs</h1>
          <p className="text-text-secondary text-sm">Full execution audits — every thought, tool call, and result.</p>
        </div>
        <button onClick={handleExportCSV} disabled={tasks.length === 0}
          className="px-3 py-1.5 border border-border hover:border-border-light bg-surface2 text-text text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-40">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {/* Running banner */}
      {runningTasks.length > 0 && (
        <div className="p-4 bg-accent/5 border border-accent/25 rounded-xl space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-sm font-semibold text-text">{runningTasks.length} task{runningTasks.length > 1 ? "s" : ""} running</span>
          </div>
          {runningTasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 pl-4">
              <p className="text-xs text-text-secondary truncate flex-1">{t.description}</p>
              <button onClick={(e) => handleStopTask(e, t.id)} disabled={stoppingId === t.id}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-xs font-bold transition-colors disabled:opacity-50">
                <Square className="w-3 h-3 fill-current" />
                {stoppingId === t.id ? "Stopping…" : "Stop"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-full bg-surface border border-border rounded-lg pl-9 pr-4 py-2 text-text text-sm focus:outline-none focus:border-accent placeholder:text-text-muted" />
        </div>
        <div className="flex bg-surface p-1 rounded-lg border border-border gap-0.5">
          {(["all","running","completed","failed","cancelled"] as const).map((tab) => (
            <button key={tab} onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors capitalize ${statusFilter === tab ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text"}`}>
              {tab === "running" && runningTasks.length > 0 ? `running (${runningTasks.length})` : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden shadow-sm">
        <div className="divide-y divide-border">
          {filtered.map((task) => {
            const isExpanded = expandedTaskId === task.id;
            const isRunning = task.status === "running";
            let steps: any[] = [];
            try { steps = JSON.parse(task.steps_json); } catch (_) {}

            return (
              <div key={task.id} className={`${isRunning ? "bg-accent/3" : ""}`}>
                {/* ── Task header row ─────────────────────────────────────── */}
                <button
                  onClick={() => toggleExpand(task.id)}
                  className="w-full p-4 flex items-center justify-between text-left hover:bg-surface2/40 transition-colors"
                >
                  <div className="flex-1 min-w-0 pr-4 space-y-1">
                    <p className="text-sm font-semibold text-text truncate">{task.description}</p>
                    <div className="flex gap-3 items-center text-xs text-text-secondary">
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(task.created_at).toLocaleString()}</span>
                      <span className="flex items-center gap-1"><Terminal className="w-3 h-3" />{steps.length} steps</span>
                      {task.outcome && (
                        <span className="flex items-center gap-1 truncate max-w-[200px]">
                          <MessageSquare className="w-3 h-3 shrink-0" />
                          <span className="truncate">{task.outcome}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isRunning && (
                      <button onClick={(e) => handleStopTask(e, task.id)} disabled={stoppingId === task.id}
                        className="flex items-center gap-1 px-2 py-1 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-[10px] font-bold transition-colors"
                        title="Stop">
                        <Square className="w-2.5 h-2.5 fill-current" />
                        {stoppingId === task.id ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      task.status === "completed" ? "bg-success/10 text-success border border-success/20" :
                      task.status === "failed"    ? "bg-error/10 text-error border border-error/20" :
                      task.status === "cancelled" ? "bg-warning/10 text-warning border border-warning/20" :
                      "bg-accent/10 text-accent border border-accent/20 animate-pulse"
                    }`}>
                      {task.status}
                    </span>
                    <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                      <ChevronDown className="w-4 h-4 text-text-muted" />
                    </motion.div>
                  </div>
                </button>

                {/* ── Animated expand ─────────────────────────────────────── */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      key="expanded"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-5 bg-surface2/30 border-t border-border space-y-4">
                        {/* Metadata row */}
                        <div className="grid grid-cols-3 gap-3 pt-4">
                          {[
                            { label: "Task ID", val: task.id.slice(0,8) + "…", mono: true },
                            { label: "Status",  val: task.status, mono: false },
                            { label: "Result",  val: task.outcome || "—", mono: false },
                          ].map((c) => (
                            <div key={c.label} className="bg-surface border border-border rounded-lg p-3 space-y-1">
                              <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider">{c.label}</p>
                              <p className={`text-xs font-semibold text-text ${c.mono ? "font-mono" : ""}`}>{c.val}</p>
                            </div>
                          ))}
                        </div>

                        {/* Running stop CTA */}
                        {isRunning && (
                          <div className="flex items-center justify-between p-3 bg-accent/8 border border-accent/20 rounded-xl">
                            <div>
                              <p className="text-xs font-semibold text-text">Running now</p>
                              <p className="text-[10px] text-text-muted mt-0.5">Agent is executing steps on your PC.</p>
                            </div>
                            <button onClick={(e) => handleStopTask(e, task.id)} disabled={stoppingId === task.id}
                              className="flex items-center gap-2 px-3 py-2 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-xs font-bold transition-colors">
                              <Square className="w-3 h-3 fill-current" />{stoppingId === task.id ? "Stopping…" : "Stop Task"}
                            </button>
                          </div>
                        )}

                        {/* ── Step timeline ─────────────────────────────── */}
                        {steps.length > 0 ? (
                          <div className="space-y-3">
                            <p className="text-[10px] font-bold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                              <Eye className="w-3 h-3" /> What the agent did — step by step
                            </p>
                            <div className="space-y-2">
                              {steps.map((step: any, idx: number) => (
                                <div key={idx} className="flex gap-3 items-start">
                                  {/* Step number */}
                                  <div className="w-7 h-7 rounded-full bg-surface border border-border text-text-muted flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                                    {step.step_num}
                                  </div>

                                  <div className="flex-1 bg-surface border border-border rounded-xl p-3 space-y-2 min-w-0">
                                    {/* Thought (what the AI decided) */}
                                    {step.thought && (
                                      <div className="flex items-start gap-2">
                                        <span className="text-[9px] font-bold text-accent uppercase tracking-wider mt-0.5 shrink-0 w-12">Think</span>
                                        <p className="text-xs text-text leading-relaxed">{step.thought}</p>
                                      </div>
                                    )}

                                    {/* Tool used */}
                                    {step.tool && (
                                      <div className="flex items-center gap-2">
                                        <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider shrink-0 w-12">Tool</span>
                                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-md border font-mono ${toolColor(step.tool)}`}>
                                          {step.tool}
                                        </span>
                                      </div>
                                    )}

                                    {/* Result / outcome */}
                                    {step.description && (
                                      <div className="flex items-start gap-2">
                                        <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider mt-0.5 shrink-0 w-12">Result</span>
                                        <p className={`text-xs leading-relaxed break-words ${step.success !== false ? "text-text-secondary" : "text-error"}`}>
                                          {step.description}
                                        </p>
                                      </div>
                                    )}

                                    {/* Success/fail indicator */}
                                    <div className="flex justify-end">
                                      {step.success === false
                                        ? <XCircle className="w-3.5 h-3.5 text-error" />
                                        : <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                                      }
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 py-4 text-text-muted">
                            <AlertTriangle className="w-4 h-4" />
                            <p className="text-xs">No step details recorded for this task yet.</p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="p-10 text-center text-text-muted text-sm">No tasks match this filter.</div>
          )}
        </div>
      </div>
    </div>
  );
};
