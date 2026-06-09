import React, { useState } from "react";
import { useStore } from "../store";
import { Search, Download, ChevronDown, ChevronUp, Calendar, Clock } from "lucide-react";

export const Activity: React.FC = () => {
  const { tasks } = useStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "failed" | "cancelled">("all");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const toggleExpand = (taskId: string) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
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
    link.setAttribute("href", url);
    link.setAttribute("download", `omni_task_history_${new Date().toISOString().split("T")[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filter Tasks
  const filteredTasks = tasks.filter((t) => {
    const matchesSearch = t.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Title */}
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

      {/* Filters & Search Bar */}
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
          {(["all", "completed", "failed", "cancelled"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors capitalize ${
                statusFilter === tab
                  ? "bg-accent text-accent-contrast"
                  : "text-text-secondary hover:text-text"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Task List */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="divide-y divide-border">
          {filteredTasks.map((task) => {
            const isExpanded = expandedTaskId === task.id;
            let steps = [];
            try {
              steps = JSON.parse(task.steps_json);
            } catch (e) {
              console.error("Failed to parse steps JSON", e);
            }

            return (
              <div key={task.id} className="transition-colors hover:bg-surface2/30">
                {/* Header Row */}
                <div
                  onClick={() => toggleExpand(task.id)}
                  className="p-4 flex items-center justify-between cursor-pointer select-none"
                >
                  <div className="flex-1 min-w-0 pr-4 space-y-1">
                    <p className="text-sm font-semibold text-text truncate">{task.description}</p>
                    <div className="flex gap-4 items-center text-xs text-text-secondary">
                      <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> {new Date(task.created_at).toLocaleString()}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {steps.length} Steps</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      task.status === "completed" ? "bg-success/10 text-success border border-success/20" :
                      task.status === "failed" ? "bg-error/10 text-error border border-error/20" :
                      task.status === "cancelled" ? "bg-warning/10 text-warning border border-warning/20" :
                      "bg-accent-dim/20 text-accent border border-accent/30"
                    }`}>
                      {task.status}
                    </span>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                  </div>
                </div>

                {/* Collapsible Details */}
                {isExpanded && (
                  <div className="p-5 bg-surface2/45 border-t border-border space-y-4">
                    {/* Metadata Grid */}
                    <div className="grid grid-cols-3 gap-4 text-xs">
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Task Identifier</span>
                        <p className="font-mono text-text font-semibold break-all">{task.id}</p>
                      </div>
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Task Status</span>
                        <p className="capitalize text-text font-semibold">{task.status}</p>
                      </div>
                      <div className="bg-surface border border-border rounded-lg p-3 space-y-1">
                        <span className="text-text-muted font-medium">Resolution Outcome</span>
                        <p className="text-text font-semibold">{task.outcome || "No output reported"}</p>
                      </div>
                    </div>

                    {/* Step Timeline */}
                    <div className="space-y-3">
                      <h4 className="text-xs font-bold text-text-secondary uppercase tracking-wider">Planner Steps</h4>
                      <div className="space-y-3 relative before:absolute before:left-5 before:top-2 before:bottom-2 before:w-0.5 before:bg-border">
                        {steps.map((step: any, idx: number) => (
                          <div key={idx} className="flex gap-4 relative">
                            {/* Number dot */}
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
                                <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Result Description</span>
                                <p className="text-xs text-text-secondary mt-0.5">{step.description}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                        {steps.length === 0 && (
                          <p className="text-xs text-text-muted pl-6">No planner step records stored for this task.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filteredTasks.length === 0 && (
            <div className="p-8 text-center text-text-muted text-sm">
              No tasks match the selected search query and filter.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
