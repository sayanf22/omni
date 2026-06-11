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
      const count = tasks.filter((t) => t.created_at && t.created_at.startsWith(dateStr)).length;
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
      const count = tasks.filter((t) => t.created_at && t.created_at.startsWith(dateStr) && t.status === "completed").length;
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
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-4xl font-black text-text">Performance Insights</h1>
        <p className="text-text-secondary text-[16px] mt-2">Analyze time allocation and productivity analytics.</p>
      </div>

      {/* Top Cards */}
      <div className="grid grid-cols-3 gap-6">
        <div className="premium-card p-6.5 flex items-center gap-5 shadow-md">
          <div className="w-13 h-13 rounded-2xl bg-accent-dim/20 border border-accent/25 flex items-center justify-center text-accent shrink-0 shadow-sm">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[12px] font-black uppercase text-text-muted tracking-wider block">Avg Steps per Task</span>
            <h4 className="text-4xl font-serif font-black text-text tracking-tight mt-1.5">{avgStepsPerTask} <span className="text-[11px] font-sans font-bold text-text-secondary uppercase tracking-wider ml-1">steps</span></h4>
          </div>
        </div>
        <div className="premium-card p-6.5 flex items-center gap-5 shadow-md">
          <div className="w-13 h-13 rounded-2xl bg-success/15 border border-success/20 flex items-center justify-center text-success shrink-0 shadow-sm">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[12px] font-black uppercase text-text-muted tracking-wider block">Total Tasks Run</span>
            <h4 className="text-4xl font-serif font-black text-text tracking-tight mt-1.5">{totalTasks} <span className="text-[11px] font-sans font-bold text-text-secondary uppercase tracking-wider ml-1">tasks</span></h4>
          </div>
        </div>
        <div className="premium-card p-6.5 flex items-center gap-5 shadow-md">
          <div className="w-13 h-13 rounded-2xl bg-warning/15 border border-warning/20 flex items-center justify-center text-warning shrink-0 shadow-sm">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[12px] font-black uppercase text-text-muted tracking-wider block">Success Rate</span>
            <h4 className="text-4xl font-serif font-black text-text tracking-tight mt-1.5">{successRate}%</h4>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-12 gap-8">
        {/* Bar chart - daily task volume */}
        <div className="col-span-8 premium-card p-7 space-y-5 shadow-md">
          <div>
            <h3 className="font-extrabold text-text text-base">Daily Automation Volume</h3>
            <p className="text-sm text-text-secondary mt-1">Number of execution pipelines triggered daily.</p>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={getDailyStats()} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <XAxis dataKey="day" stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <YAxis stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "14px" }}
                  labelStyle={{ color: "#F1F1F8", fontSize: "13px", fontWeight: "bold" }}
                  itemStyle={{ color: "#818CF8", fontSize: "13px" }}
                />
                <Bar dataKey="Tasks" fill="#6366F1" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Donut chart - tool usage share */}
        <div className="col-span-4 premium-card p-7 space-y-5 shadow-md">
          <div>
            <h3 className="font-extrabold text-text text-base">Tool Execution Share</h3>
            <p className="text-sm text-text-secondary mt-1">Distribution of automation commands.</p>
          </div>
          <div className="h-60 relative flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={toolData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {toolData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "14px" }}
                  itemStyle={{ color: "#F1F1F8", fontSize: "13px" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Legend */}
          <div className="grid grid-cols-3 gap-2.5 pt-3 border-t border-border/60">
            {toolData.map((entry, idx) => (
              <div key={idx} className="flex items-center gap-2 text-[10.5px] font-bold text-text-secondary font-mono">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                <span className="truncate">{entry.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Line chart - time saved weekly trend */}
        <div className="col-span-12 premium-card p-7 space-y-5 shadow-md">
          <div>
            <h3 className="font-extrabold text-text text-base">Productivity Trend (Time Saved)</h3>
            <p className="text-sm text-text-secondary mt-1">Cumulative time saved in minutes over the current week.</p>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={getTimeSavedStats()} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <XAxis dataKey="day" stroke="#5C5C7A" fontSize={11} tickLine={false} />
                <YAxis stroke="#5C5C7A" fontSize={11} tickLine={false} unit="m" />
                <Tooltip
                  contentStyle={{ backgroundColor: "#111116", borderColor: "#252532", borderRadius: "14px" }}
                  labelStyle={{ color: "#F1F1F8", fontSize: "13px", fontWeight: "bold" }}
                  itemStyle={{ color: "#34D399", fontSize: "13px" }}
                />
                <Line type="monotone" dataKey="MinutesSaved" stroke="#34D399" strokeWidth={3} dot={{ r: 5 }} activeDot={{ r: 7 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
