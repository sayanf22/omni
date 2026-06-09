import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  ListTodo,
  BarChart2,
  Brain,
  Blocks,
  Settings as SettingsIcon,
  ShieldCheck,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon
} from "lucide-react";

import { Home } from "./Home";
import { Activity } from "./Activity";
import { Insights } from "./Insights";
import { Memory } from "./Memory";
import { Skills } from "./Skills";
import { Settings } from "./Settings";
import { Security } from "./Security";

type TabType = "home" | "activity" | "insights" | "memory" | "skills" | "settings" | "security";

export const Dashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>("home");
  const [collapsed, setCollapsed] = useState(false);
  const session = useStore((state) => state.session);
  const setSession = useStore((state) => state.setSession);
  const fetchLocalData = useStore((state) => state.fetchLocalData);
  const syncLocalToCloud = useStore((state) => state.syncLocalToCloud);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);

  // Sync sqlite to supabase in background
  useEffect(() => {
    fetchLocalData();
    syncLocalToCloud();

    // Background sync loop: sync every 60 seconds
    const interval = setInterval(() => {
      syncLocalToCloud();
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchLocalData, syncLocalToCloud]);

  const handleLogout = async () => {
    if (confirm("Are you sure you want to sign out?")) {
      await invoke("supabase_logout");
      setSession(null);
    }
  };

  const navItems = [
    { id: "home", label: "Home", icon: LayoutDashboard },
    { id: "activity", label: "Activity", icon: ListTodo },
    { id: "insights", label: "Insights", icon: BarChart2 },
    { id: "memory", label: "Memory", icon: Brain },
    { id: "skills", label: "Skills", icon: Blocks },
    { separator: true },
    { id: "settings", label: "Settings", icon: SettingsIcon },
    { id: "security", label: "Security", icon: ShieldCheck }
  ];

  const renderContent = () => {
    switch (activeTab) {
      case "home":
        return <Home />;
      case "activity":
        return <Activity />;
      case "insights":
        return <Insights />;
      case "memory":
        return <Memory />;
      case "skills":
        return <Skills />;
      case "settings":
        return <Settings />;
      case "security":
        return <Security />;
      default:
        return <Home />;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-bg text-text overflow-hidden font-sans">
      {/* Sidebar navigation */}
      <motion.div
        animate={{ width: collapsed ? 72 : 256 }}
        transition={{ duration: 0.25, ease: "easeInOut" }}
        className="h-full bg-surface border-r border-border flex flex-col justify-between shrink-0 select-none relative"
      >
        <div className="space-y-6 py-5">
          {/* Header */}
          <div className={`px-4 flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
            {!collapsed && (
              <div className="flex items-center gap-2">
                <span className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center font-bold text-lg text-accent-contrast">Ω</span>
                <span className="font-extrabold tracking-tight text-text text-base">Omni Agent</span>
              </div>
            )}
            {collapsed && (
              <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center font-bold text-lg text-accent-contrast">Ω</span>
            )}
          </div>

          {/* Nav Links */}
          <nav className="px-3 space-y-1">
            {navItems.map((item, index) => {
              if (item.separator) {
                return <div key={`sep-${index}`} className="my-4 border-t border-border mx-2" />;
              }

              const Icon = item.icon!;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as TabType)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-semibold tracking-wide transition-all relative ${
                    isActive
                      ? "text-text bg-surface2 border-l-2 border-accent"
                      : "text-text-secondary hover:text-text hover:bg-surface3/40"
                  }`}
                >
                  <Icon className="w-4.5 h-4.5 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Footer / User profile */}
        <div className="p-3 border-t border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-accent-dim/30 border border-accent/20 flex items-center justify-center font-bold text-xs text-accent shrink-0 uppercase">
                {session?.user?.email?.slice(0, 2) || "US"}
              </div>
              {!collapsed && (
                <div className="min-w-0">
                  <h4 className="text-xs font-bold text-text truncate">{session?.user?.email}</h4>
                  <span className="text-[10px] text-text-muted capitalize">Standard Tier</span>
                </div>
              )}
            </div>

            {!collapsed && (
              <button
                onClick={handleLogout}
                className="p-1.5 text-text-muted hover:text-error hover:bg-error-dim/20 rounded transition-colors"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Toggle buttons row */}
          <div className="flex gap-2">
            <button
              onClick={toggleTheme}
              className="flex-1 py-1.5 border border-border hover:border-border-light bg-surface2 rounded text-text-muted hover:text-text flex items-center justify-center transition-colors"
              title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {theme === "dark" ? <Sun className="w-4 h-4 text-warning" /> : <Moon className="w-4 h-4 text-accent" />}
            </button>
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="flex-1 py-1.5 border border-border hover:border-border-light bg-surface2 rounded text-text-muted hover:text-text flex items-center justify-center transition-colors"
            >
              {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </motion.div>

      {/* Main Content Area */}
      <main className="flex-1 h-full overflow-y-auto bg-bg p-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};
