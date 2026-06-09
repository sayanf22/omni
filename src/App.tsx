import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Login } from "./components/Login";
import { Onboarding } from "./components/Onboarding";
import { Dashboard } from "./components/Dashboard";
import { FloatingOverlay } from "./components/FloatingOverlay";
import { TextInputOverlay } from "./components/TextInputOverlay";

function App() {
  const { session, setSession, models, fetchLocalData } = useStore();
  const [windowLabel, setWindowLabel] = useState<string>("main");
  const [authLoading, setAuthLoading] = useState(true);

  // 1. Detect current window label
  useEffect(() => {
    try {
      const appWindow = getCurrentWindow();
      setWindowLabel(appWindow.label);
    } catch (e) {
      console.warn("Could not retrieve current window label, defaulting to main", e);
    }
  }, []);

  // 2. Setup secure backend auth session check on startup
  useEffect(() => {
    invoke("get_supabase_session")
      .then((user) => {
        if (user) {
          setSession({ user });
          fetchLocalData();
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
  }, [setSession, fetchLocalData]);

  // If in the overlay window, load FloatingOverlay directly
  if (windowLabel === "overlay") {
    return <FloatingOverlay />;
  }

  // If in the text input window, load TextInputOverlay directly
  if (windowLabel === "textinput") {
    return <TextInputOverlay />;
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
    return <Login />;
  }

  // Handle Onboarding routing (authenticated but has no custom models registered)
  const hasModels = models.length > 0;
  if (!hasModels) {
    return <Onboarding onComplete={fetchLocalData} />;
  }

  // Main Dashboard View
  return <Dashboard />;
}

export default App;
