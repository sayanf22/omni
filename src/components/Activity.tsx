import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Download, ChevronDown,
  Square, Terminal, Eye, MessageSquare, CheckCircle2, XCircle, AlertTriangle
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

  // Refresh on mount + listen to task events safely without unmount memory leaks
  useEffect(() => {
    fetchLocalData();
    let active = true;
    const unsubscribes: Array<() => void> = [];

    (async () => {
      for (const evt of ["task:started", "task:step", "task:done", "task:failed", "agent:killed"]) {
        const unsub = await listen(evt, () => fetchLocalData());
        if (active) {
          unsubscribes.push(unsub);
        } else {
          unsub();
        }
      }
    })();

    return () => {
      active = false;
      unsubscribes.forEach((fn) => fn());
    };
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

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }).toLowerCase();
  };

  const groupedTasks = React.useMemo(() => {
    const groups: { [key: string]: typeof tasks } = {};
    filtered.forEach((task) => {
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
  }, [filtered]);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-black text-text">Activity Logs</h1>
          <p className="text-text-secondary text-[16px] mt-2">Full execution audits — every thought, tool call, and result.</p>
        </div>
        <button onClick={handleExportCSV} disabled={tasks.length === 0}
          className="px-4.5 py-2.5 border border-border hover:border-border-light bg-surface2 text-text text-sm font-extrabold rounded-xl flex items-center gap-2 transition-colors disabled:opacity-40 shadow-sm">
          <Download className="w-4.5 h-4.5" /> Export CSV
        </button>
      </div>

      {/* Running banner */}
      {runningTasks.length > 0 && (
        <div className="p-6 bg-accent/5 border border-accent/25 rounded-[24px] space-y-3 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
            <span className="text-base font-extrabold text-text">{runningTasks.length} task{runningTasks.length > 1 ? "s" : ""} running</span>
          </div>
          {runningTasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4 pl-5">
              <p className="text-sm text-text-secondary truncate flex-1">{t.description}</p>
              <button onClick={(e) => handleStopTask(e, t.id)} disabled={stoppingId === t.id}
                className="shrink-0 flex items-center gap-2 px-4 py-2 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-xl text-xs font-black transition-colors disabled:opacity-50">
                <Square className="w-3.5 h-3.5 fill-current" />
                {stoppingId === t.id ? "Stopping…" : "Stop"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4">
        <div className="flex-1 relative">
          <Search className="w-5 h-5 text-text-muted absolute left-4 top-1/2 -translate-y-1/2" />
          <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-full bg-surface border border-border rounded-2xl pl-11 pr-5 py-3 text-text text-base focus:outline-none focus:border-accent placeholder:text-text-muted shadow-sm" />
        </div>
        <div className="flex bg-surface p-1.5 rounded-2xl border border-border gap-1 shadow-sm">
          {(["all","running","completed","failed","cancelled"] as const).map((tab) => (
            <button key={tab} onClick={() => setStatusFilter(tab)}
              className={`px-4.5 py-2 text-sm font-extrabold rounded-xl transition-colors capitalize ${statusFilter === tab ? "bg-accent text-accent-contrast shadow-sm" : "text-text-secondary hover:text-text"}`}>
              {tab === "running" && runningTasks.length > 0 ? `running (${runningTasks.length})` : tab}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-10">
        {Object.keys(groupedTasks).map((dateStr) => (
          <div key={dateStr} className="space-y-4">
            <h3 className="text-[11px] font-black text-text-muted tracking-widest uppercase mt-4 mb-2">
              {dateStr}
            </h3>
            
            <div className="bg-surface border border-border rounded-[28px] overflow-hidden shadow-md divide-y divide-border/60 premium-card">
              {groupedTasks[dateStr].map((task) => {
                const isExpanded = expandedTaskId === task.id;
                const isRunning = task.status === "running";
                let steps: any[] = [];
                try { steps = JSON.parse(task.steps_json); } catch (_) {}

                return (
                  <div key={task.id} className={`${isRunning ? "bg-accent/3" : ""} transition-all`}>
                    {/* ── Task header row ─────────────────────────────────────── */}
                    <div
                      onClick={() => toggleExpand(task.id)}
                      className="w-full px-9 py-5.5 flex items-start justify-between text-left hover:bg-surface2/40 transition-colors cursor-pointer gap-5 select-none"
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

                      {/* Task Description (serif Georgia, wraps naturally) */}
                      <div className="flex-1 min-w-0 pr-3">
                        <p className="text-[16px] font-serif font-medium text-text leading-relaxed whitespace-pre-wrap">
                          {task.description}
                        </p>
                        <div className="flex gap-4.5 items-center text-xs text-text-muted mt-2">
                          <span className="flex items-center gap-1.5"><Terminal className="w-3.5 h-3.5" />{steps.length} steps</span>
                          {task.outcome && (
                            <span className="flex items-center gap-1.5 truncate max-w-[420px]">
                              <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{task.outcome}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions & Chevron */}
                      <div className="flex items-center gap-3.5 shrink-0">
                        {isRunning && (
                          <button onClick={(e) => handleStopTask(e, task.id)} disabled={stoppingId === task.id}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-xl text-xs font-black transition-colors"
                            title="Stop">
                            <Square className="w-3 h-3 fill-current" />
                            {stoppingId === task.id ? "Stopping…" : "Stop"}
                          </button>
                        )}
                        <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="pt-0.5">
                          <ChevronDown className="w-4.5 h-4.5 text-text-muted" />
                        </motion.div>
                      </div>
                    </div>

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
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="px-6 pb-6 bg-surface2/30 border-t border-border space-y-5">
                            {/* Metadata row */}
                            <div className="grid grid-cols-3 gap-4 pt-5">
                              {[
                                { label: "Task ID", val: task.id.slice(0,12) + "…", mono: true },
                                { label: "Status",  val: task.status, mono: false },
                                { label: "Result",  val: task.outcome || "—", mono: false },
                              ].map((c) => (
                                <div key={c.label} className="bg-surface border border-border rounded-2xl p-4.5 space-y-1.5 shadow-sm">
                                  <p className="text-xs text-text-muted font-bold uppercase tracking-wider">{c.label}</p>
                                  <p className={`text-sm font-extrabold text-text ${c.mono ? "font-mono" : ""}`}>{c.val}</p>
                                </div>
                              ))}
                            </div>

                            {/* Running stop CTA */}
                            {isRunning && (
                              <div className="flex items-center justify-between p-4 bg-accent-dim/10 border border-accent/20 rounded-2xl shadow-sm">
                                <div>
                                  <p className="text-sm font-extrabold text-text">Running now</p>
                                  <p className="text-xs text-text-muted mt-0.5">Agent is executing steps on your PC.</p>
                                </div>
                                <button onClick={(e) => handleStopTask(e, task.id)} disabled={stoppingId === task.id}
                                  className="flex items-center gap-2 px-4.5 py-2.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-xl text-xs font-black transition-colors">
                                  <Square className="w-3.5 h-3.5 fill-current" />{stoppingId === task.id ? "Stopping…" : "Stop Task"}
                                </button>
                              </div>
                            )}

                            {/* ── Step timeline ─────────────────────────────── */}
                            {steps.length > 0 ? (
                              <div className="space-y-4 pt-1">
                                <p className="text-xs font-black text-text-secondary uppercase tracking-wider flex items-center gap-2">
                                  <Eye className="w-4 h-4" /> What the agent did — step by step
                                </p>
                                <div className="space-y-3">
                                  {steps.map((step: any, idx: number) => (
                                    <div key={idx} className="flex gap-4 items-start">
                                      {/* Step number */}
                                      <div className="w-8.5 h-8.5 rounded-full bg-surface border border-border text-text-muted flex items-center justify-center text-xs font-black shrink-0 mt-0.5 shadow-sm">
                                        {step.step_num}
                                      </div>

                                      <div className="flex-1 bg-surface border border-border rounded-2xl p-4.5 space-y-3 min-w-0 shadow-sm">
                                        {/* Thought (what the AI decided) */}
                                        {step.thought && (
                                          <div className="flex items-start gap-2.5">
                                            <span className="text-xs font-black text-accent uppercase tracking-wider mt-0.5 shrink-0 w-14">Think</span>
                                            <p className="text-sm text-text leading-relaxed font-medium">{step.thought}</p>
                                          </div>
                                        )}

                                        {/* Tool used */}
                                        {step.tool && (
                                          <div className="flex items-center gap-2.5">
                                            <span className="text-xs font-black text-text-muted uppercase tracking-wider shrink-0 w-14">Tool</span>
                                            <span className={`text-xs font-black uppercase px-2.5 py-1 rounded-lg border font-mono ${toolColor(step.tool)}`}>
                                              {step.tool}
                                            </span>
                                          </div>
                                        )}

                                        {/* Result / outcome */}
                                        {step.description && (
                                          <div className="flex items-start gap-2.5">
                                            <span className="text-xs font-black text-text-muted uppercase tracking-wider mt-0.5 shrink-0 w-14">Result</span>
                                            <p className={`text-sm leading-relaxed break-words font-medium ${step.success !== false ? "text-text-secondary" : "text-error"}`}>
                                              {step.description}
                                            </p>
                                          </div>
                                        )}

                                        {/* Success/fail indicator */}
                                        <div className="flex justify-end pt-1">
                                          {step.success === false
                                            ? <XCircle className="w-4.5 h-4.5 text-error" />
                                            : <CheckCircle2 className="w-4.5 h-4.5 text-success" />
                                          }
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 py-5 text-text-muted">
                                <AlertTriangle className="w-4.5 h-4.5" />
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
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="p-12 text-center text-text-muted text-base bg-surface border border-border rounded-[28px] premium-card">No tasks match this filter.</div>
        )}
      </div>
    </div>
  );
};
