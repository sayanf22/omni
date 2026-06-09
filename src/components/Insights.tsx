import React from "react";
import { useStore } from "../store";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, LineChart, Line, PieChart, Pie, Cell } from "recharts";
import { TrendingUp, Clock, Activity } from "lucide-react";

export const Insights: React.FC = () => {
  const { tasks } = useStore();

  // Helper: calculate tasks by day for the last 7 days (real data only)
  const getDailyStats = () => {
    const stats = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dayStr = d.toLocaleDateString("en-US", { weekday: "short" });
      const dateStr = d.toISOString().split("T")[0];
      const count = tasks.filter((t) => t.created_at.startsWith(dateStr)).length;
      stats.push({ day: dayStr, Tasks: count });
    }
    return stats;
  };

  // Helper: calculate cumulative time saved over the last 7 days (real data only, 2.5min per completed task)
  const getTimeSavedStats = () => {
    const stats = [];
    const now = new Date();
    let cumulativeSaved = 0;
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dayStr = d.toLocaleDateString("en-US", { weekday: "short" });
      const dateStr = d.toISOString().split("T")[0];
      const count = tasks.filter((t) => t.created_at.startsWith(dateStr) && t.status === "completed").length;
      cumulativeSaved += count * 2.5;
      stats.push({ day: dayStr, MinutesSaved: parseFloat(cumulativeSaved.toFixed(1)) });
    }
    return stats;
  };

  // Tool Usage Share — only real counts from steps_json (no hardcoded baseline)
  const getToolUsageData = () => {
    const toolCounts: Record<string, number> = {};

    tasks.forEach((t) => {
      try {
        const steps = JSON.parse(t.steps_json);
        steps.forEach((s: any) => {
          if (s.tool) {
            toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
          }
        });
      } catch (e) {}
    });

    // If no real data yet, return empty array (chart will be empty but accurate)
    return Object.entries(toolCounts).map(([name, value]) => ({
      name: name.toUpperCase(),
      value
    }));
  };

  const toolData = getToolUsageData();
  const COLORS = ["#6366F1", "#818CF8", "#4F46E5", "#34D399", "#FBBF24", "#F87171"];

  // Real stats from task data
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const successRate = totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : "0";

  const avgStepsPerTask = (() => {
    let totalSteps = 0;
    let count = 0;
    tasks.forEach((t) => {
      try {
        const steps = JSON.parse(t.steps_json);
        if (steps.length > 0) {
          totalSteps += steps.length;
          count++;
        }
      } catch (e) {}
    });
    return count > 0 ? (totalSteps / count).toFixed(1) : "0";
  })();

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-text">Performance Insights</h1>
        <p className="text-text-secondary text-sm">Analyze time allocation and productivity analytics.</p>
      </div>

      {/* Top Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-5 flex items-center gap-4 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-accent-dim/20 border border-accent/25 flex items-center justify-center text-accent">
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-text-secondary">Avg Steps per Task</span>
            <h4 className="text-xl font-bold text-text mt-0.5">{avgStepsPerTask} steps</h4>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 flex items-center gap-4 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-success/15 border border-success/20 flex items-center justify-center text-success">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-text-secondary">Total Tasks Run</span>
            <h4 className="text-xl font-bold text-text mt-0.5">{totalTasks} tasks</h4>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 flex items-center gap-4 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-warning/15 border border-warning/20 flex items-center justify-center text-warning">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-text-secondary">AI Dispatch Success Rate</span>
            <h4 className="text-xl font-bold text-text mt-0.5">{successRate}%</h4>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-12 gap-6">
        {/* Bar chart - daily task volume */}
        <div className="col-span-8 bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
          <div>
            <h3 className="font-semibold text-text text-sm">Daily Automation Volume</h3>
            <p className="text-xs text-text-secondary">Number of execution pipelines triggered daily.</p>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={getDailyStats()} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <XAxis dataKey="day" stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <YAxis stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "8px" }}
                  labelStyle={{ color: "#F1F1F8", fontSize: "12px", fontWeight: "bold" }}
                  itemStyle={{ color: "#818CF8", fontSize: "12px" }}
                />
                <Bar dataKey="Tasks" fill="#6366F1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Donut chart - tool usage share */}
        <div className="col-span-4 bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
          <div>
            <h3 className="font-semibold text-text text-sm">Tool Execution Share</h3>
            <p className="text-xs text-text-secondary">Distribution of automation commands.</p>
          </div>
          <div className="h-56 relative flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={toolData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={75}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {toolData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "8px" }}
                  itemStyle={{ color: "#F1F1F8", fontSize: "12px" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Legend */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border">
            {toolData.map((entry, idx) => (
              <div key={idx} className="flex items-center gap-1.5 text-[9px] font-semibold text-text-secondary">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                <span className="truncate">{entry.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Line chart - time saved weekly trend */}
        <div className="col-span-12 bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
          <div>
            <h3 className="font-semibold text-text text-sm">Productivity Trend (Time Saved)</h3>
            <p className="text-xs text-text-secondary">Cumulative time saved in minutes over the current week.</p>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={getTimeSavedStats()} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <XAxis dataKey="day" stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <YAxis stroke="#5C5C7A" fontSize={11} tickLine={false} unit="m" />
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "8px" }}
                  labelStyle={{ color: "#F1F1F8", fontSize: "12px", fontWeight: "bold" }}
                  itemStyle={{ color: "#34D399", fontSize: "12px" }}
                />
                <Line type="monotone" dataKey="MinutesSaved" stroke="#34D399" strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
