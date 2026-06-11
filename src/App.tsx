import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Login } from "./components/Login";
import { Onboarding } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { FloatingOverlay } from "./components/FloatingOverlay";
import { VoicePill } from "./components/VoicePill";

function App() {
  const { session, setSession, models, fetchLocalData } = useStore();
  // Detect the window label SYNCHRONOUSLY on first render. Critical: the overlay
  // and textinput windows must render their own component immediately and never
  // briefly mount the full main app (which could error/hang and leave the
  // floating window as a dark empty box).
  const [windowLabel] = useState<string>(() => {
    try { return getCurrentWindow().label; }
    catch (e) { console.warn("Could not retrieve window label, defaulting to main", e); return "main"; }
  });
  const [authLoading, setAuthLoading] = useState(true);

  // 2. Setup secure backend auth session check on startup
  useEffect(() => {
    invoke("get_supabase_session")
      .then((user) => {
        if (user) {
          setSession({ user });
        } else {
          setSession(null);
        }
        setAuthLoading(false);
      })
      .catch((err) => {
        console.error("Failed to check session on startup:", err);
        setSession(null);
        setAuthLoading(false);
      });
  }, [setSession]);

  // Fetch local database data (models, tasks, audits) when session becomes active
  useEffect(() => {
    if (session) {
      fetchLocalData();
    }
  }, [session, fetchLocalData]);

  // If in the overlay window, load FloatingOverlay directly
  if (windowLabel === "overlay") {
    return <FloatingOverlay />;
  }

  // Handle loading state
  if (authLoading) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center text-text font-sans">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-semibold text-text-secondary">Securing session...</p>
        </div>
      </div>
    );
  }

  // Handle Authentication routing
  if (!session) {
    return <><Login /><VoicePill /></>;
  }

  // Handle Onboarding routing (authenticated but has no custom models registered)
  const hasModels = models.length > 0;
  if (!hasModels) {
    return <><Onboarding onComplete={fetchLocalData} /><VoicePill /></>;
  }

  // Main Dashboard View
  return <><Dashboard /><VoicePill /></>;
}

export default App;
