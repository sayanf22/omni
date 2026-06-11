import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
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
import { ErrorBoundary } from "./ErrorBoundary";

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
        animate={{ width: collapsed ? 80 : 280 }}
        transition={{ duration: 0.25, ease: "easeInOut" }}
        className="h-full bg-bg border-r border-border/40 dark:border-border/10 flex flex-col justify-between shrink-0 select-none relative"
      >
        <div className="flex flex-col h-full overflow-y-auto no-scrollbar pt-8 pb-4">
          {/* Header */}
          <div className={`px-7 flex items-center mb-8 ${collapsed ? "justify-center" : "justify-between"}`}>
            <div className="flex items-center gap-3">
              <svg className="w-7 h-7 text-text shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M17 7v10M7 9v6" />
              </svg>
              {!collapsed && (
                <span className="font-sans font-black text-3xl tracking-tighter text-text">Omni</span>
              )}
            </div>
            {!collapsed && (
              <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-lg bg-surface3 border border-border text-text-muted select-none">
                Agent
              </span>
            )}
          </div>

          {/* Nav Links */}
          <nav className="px-4 space-y-2">
            {navItems.map((item, index) => {
              if (item.separator) {
                return <div key={`sep-${index}`} className="my-4 border-t border-border/30 dark:border-border/10 mx-4" />;
              }

              const Icon = item.icon!;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as TabType)}
                  className={`w-full flex items-center gap-4 px-4.5 py-3 rounded-xl text-[14.5px] font-bold transition-all relative ${
                    isActive
                      ? "text-text bg-surface2 border border-border/80 dark:border-border/30 shadow-[0_3px_10px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
                      : "text-text-secondary hover:text-text hover:bg-surface2/40"
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </button>
              );
            })}
          </nav>

        </div>

        {/* Bottom Sidebar Actions */}
        <div className="p-4 border-t border-border/40 dark:border-border/10 space-y-3">
          
          <div className="flex items-center justify-between p-1.5 bg-surface2 border border-border/30 dark:border-border/10 rounded-2xl shadow-sm">
            <div className="flex items-center gap-3 min-w-0 px-2 py-1.5">
              <div className="w-9 h-9 rounded-full bg-accent-dim border border-border flex items-center justify-center font-bold text-sm text-text shrink-0 uppercase">
                {session?.user?.email?.slice(0, 2) || "US"}
              </div>
              {!collapsed && (
                <div className="min-w-0">
                  <h4 className="text-sm font-extrabold text-text truncate">{session?.user?.email}</h4>
                </div>
              )}
            </div>

            {!collapsed && (
              <button
                onClick={handleLogout}
                className="p-2 text-text-muted hover:text-error hover:bg-error-dim/20 rounded-xl transition-colors"
                title="Sign Out"
              >
                <LogOut className="w-4.5 h-4.5" />
              </button>
            )}
          </div>

          {/* Toggle buttons row */}
          <div className="flex gap-2.5">
            <button
              onClick={toggleTheme}
              className="flex-1 py-2.5 border border-border/40 dark:border-border/15 hover:border-border-light bg-surface2 rounded-xl text-text-muted hover:text-text flex items-center justify-center transition-colors shadow-sm"
              title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {theme === "dark" ? <Sun className="w-4.5 h-4.5 text-warning" /> : <Moon className="w-4.5 h-4.5 text-text" />}
            </button>
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="flex-1 py-2.5 border border-border/40 dark:border-border/15 hover:border-border-light bg-surface2 rounded-xl text-text-muted hover:text-text flex items-center justify-center transition-colors shadow-sm"
            >
              {collapsed ? <ChevronRight className="w-4.5 h-4.5" /> : <ChevronLeft className="w-4.5 h-4.5" />}
            </button>
          </div>
        </div>
      </motion.div>

      {/* Main Content Area */}
      <main className="flex-1 h-full overflow-hidden p-6 bg-bg">
        <div className="h-full w-full premium-container overflow-y-auto p-10 relative">
          <ErrorBoundary>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="h-full"
            >
              {renderContent()}
            </motion.div>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
};
