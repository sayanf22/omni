import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Search, Download, ChevronDown, ChevronUp,
  Calendar, Clock, Square
} from "lucide-react";

export const Activity: React.FC = () => {
  const { tasks, fetchLocalData } = useStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "failed" | "cancelled" | "running">("all");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const runningTasks = tasks.filter((t) => t.status === "running");

  // Refresh on mount, listen to task lifecycle events, and poll while tasks run
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

  // While there are running tasks, poll every 2s so status updates promptly
  useEffect(() => {
    if (runningTasks.length === 0) return;
    const id = setInterval(() => fetchLocalData(), 2000);
    return () => clearInterval(id);
  }, [runningTasks.length, fetchLocalData]);

  const toggleExpand = (taskId: string) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  // Stop a RUNNING task — cancels the live agent AND force-marks the DB row cancelled
  const handleStopTask = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation(); // don't toggle expand
    setStoppingId(taskId);
    try {
      // 1. Signal the live planner loop (if this task is running in the current session)
      await invoke("cancel_task");
      // 2. Force-mark the task cancelled in SQLite — handles orphaned tasks from
      //    a previous session whose loop is no longer alive.
      await invoke("force_cancel_task", { taskId });
      // 3. Give the DB write a moment, then refresh the list
      await new Promise((r) => setTimeout(r, 400));
      await fetchLocalData();
    } catch (err) {
      console.error("Failed to stop task:", err);
      // Even on error, refresh so the UI reflects reality
      await fetchLocalData();
    } finally {
      setStoppingId(null);
    }
  };

  const handleExportCSV = () => {
    if (tasks.length === 0) return;
    const headers = ["ID", "Description", "Status", "Outcome", "Created At"];
    const rows = tasks.map((t) => [
      t.id,
      `"${t.description.replace(/"/g, '""')}"`,
      t.status,
      t.outcome ? `"${t.outcome.replace(/"/g, '""')}"` : "",
      t.created_at,
    ]);
    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `omni_task_history_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filter based on statusFilter + search
  const properlyFiltered = tasks.filter((t) => {
    const matchesSearch = t.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Title + Export */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-text">Activity Logs</h1>
          <p className="text-text-secondary text-sm">Review full execution audits and historical planner cycles.</p>
        </div>
        <button
          onClick={handleExportCSV}
          disabled={tasks.length === 0}
          className="px-3 py-1.5 border border-border hover:border-border-light bg-surface2 hover:bg-surface3 text-text text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-45"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Running tasks banner — shown whenever there are active tasks */}
      {runningTasks.length > 0 && (
        <div className="p-4 bg-accent-dim/20 border border-accent/30 rounded-xl space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-sm font-semibold text-text">
              {runningTasks.length} task{runningTasks.length > 1 ? "s" : ""} currently running
            </span>
          </div>
          {runningTasks.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 pl-4">
              <p className="text-xs text-text-secondary truncate flex-1">{t.description}</p>
              <button
                onClick={(e) => handleStopTask(e, t.id)}
                disabled={stoppingId === t.id}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
              >
                <Square className="w-3 h-3 fill-current" />
                {stoppingId === t.id ? "Stopping…" : "Stop"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks by description..."
            className="w-full bg-surface border border-border rounded-lg pl-9 pr-4 py-2 text-text text-sm focus:outline-none focus:border-accent placeholder:text-text-muted"
          />
        </div>
        <div className="flex bg-surface p-1 rounded-lg border border-border">
          {(["all", "running", "completed", "failed", "cancelled"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors capitalize ${
                statusFilter === tab
                  ? "bg-accent text-accent-contrast"
                  : "text-text-secondary hover:text-text"
              }`}
            >
              {tab === "running" && runningTasks.length > 0
                ? `running (${runningTasks.length})`
                : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Task List */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="divide-y divide-border">
          {properlyFiltered.map((task) => {
            const isExpanded = expandedTaskId === task.id;
            const isRunning = task.status === "running";
            let steps: any[] = [];
            try { steps = JSON.parse(task.steps_json); } catch (_) {}

            return (
              <div key={task.id} className={`transition-colors hover:bg-surface2/30 ${isRunning ? "bg-accent-dim/5" : ""}`}>
                {/* Header Row */}
                <div
                  onClick={() => toggleExpand(task.id)}
                  className="p-4 flex items-center justify-between cursor-pointer select-none"
                >
                  <div className="flex-1 min-w-0 pr-4 space-y-1">
                    <p className="text-sm font-semibold text-text truncate">{task.description}</p>
                    <div className="flex gap-4 items-center text-xs text-text-secondary">
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5" />
                        {new Date(task.created_at).toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {steps.length} Steps
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Stop button — only on running tasks, right in the row */}
                    {isRunning && (
                      <button
                        onClick={(e) => handleStopTask(e, task.id)}
                        disabled={stoppingId === task.id}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-[10px] font-bold transition-colors disabled:opacity-50"
                        title="Stop this task"
                      >
                        <Square className="w-3 h-3 fill-current" />
                        {stoppingId === task.id ? "Stopping…" : "Stop"}
                      </button>
                    )}

                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      task.status === "completed" ? "bg-success/10 text-success border border-success/20" :
                      task.status === "failed"    ? "bg-error/10 text-error border border-error/20" :
                      task.status === "cancelled" ? "bg-warning/10 text-warning border border-warning/20" :
                      /* running */                 "bg-accent-dim/20 text-accent border border-accent/30 animate-pulse"
                    }`}>
                      {task.status}
                    </span>

                    {isExpanded
                      ? <ChevronUp className="w-4 h-4 text-text-muted" />
                      : <ChevronDown className="w-4 h-4 text-text-muted" />}
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="p-5 bg-surface2/45 border-t border-border space-y-4">
                    <div className="grid grid-cols-3 gap-4 text-xs">
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Task ID</span>
                        <p className="font-mono text-text font-semibold break-all text-[10px]">{task.id}</p>
                      </div>
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Status</span>
                        <p className="capitalize text-text font-semibold">{task.status}</p>
                      </div>
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Outcome</span>
                        <p className="text-text font-semibold">{task.outcome || "No output reported"}</p>
                      </div>
                    </div>

                    {/* If running, show a stop call-to-action in expanded view too */}
                    {isRunning && (
                      <div className="flex items-center justify-between p-3 bg-accent-dim/15 border border-accent/20 rounded-lg">
                        <div>
                          <p className="text-xs font-semibold text-text">Task is currently executing</p>
                          <p className="text-[10px] text-text-muted mt-0.5">The agent is working on this task right now.</p>
                        </div>
                        <button
                          onClick={(e) => handleStopTask(e, task.id)}
                          disabled={stoppingId === task.id}
                          className="flex items-center gap-2 px-3 py-2 bg-error/15 hover:bg-error/25 text-error border border-error/30 rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          {stoppingId === task.id ? "Stopping…" : "Stop Task"}
                        </button>
                      </div>
                    )}

                    {/* Step Timeline */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-bold text-text-secondary uppercase tracking-wider">Planner Steps</h4>
                      <div className="space-y-3 relative before:absolute before:left-5 before:top-2 before:bottom-2 before:w-0.5 before:bg-border">
                        {steps.map((step: any, idx: number) => (
                          <div key={idx} className="flex gap-4 relative">
                            <span className="w-10 h-10 rounded-full bg-surface border border-border text-text flex items-center justify-center text-xs font-bold shrink-0 z-10">
                              #{step.step_num}
                            </span>
                            <div className="flex-1 bg-surface border border-border rounded-lg p-4 space-y-2">
                              <div>
                                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Thought</span>
                                <p className="text-xs font-semibold text-text leading-relaxed mt-0.5">{step.thought}</p>
                              </div>
                              {step.tool && (
                                <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface2 border border-border rounded text-[10px] font-mono text-accent">
                                  Tool: {step.tool}
                                </div>
                              )}
                              <div>
                                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Result</span>
                                <p className="text-xs text-text-secondary mt-0.5">{step.description}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                        {steps.length === 0 && (
                          <p className="text-xs text-text-muted pl-6">No steps recorded yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {properlyFiltered.length === 0 && (
            <div className="p-8 text-center text-text-muted text-sm">
              No tasks match the selected filter.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
