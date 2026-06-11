import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./App.css";

// Mock Tauri environment when running in standard web browsers for visual testing
if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
  console.warn("Tauri environment not detected. Running with simulated mock backend.");
  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any) => {
      console.log("[Mock Tauri Invoke]", cmd, args);
      if (cmd === "get_hotkeys") return { mic: "Ctrl+Shift+A", text: "Ctrl+Shift+T" };
      if (cmd === "get_stt_status") return { engine: "local_whisper", local_whisper_available: true, elevenlabs_configured: false };
      if (cmd === "piper_installed") return true;
      if (cmd === "get_setting") {
        if (args?.key === "mem0_type") return "cloud";
        if (args?.key === "mem0_url") return "https://api.mem0.ai";
        return "";
      }
      if (cmd === "get_api_key") return "••••••••••••";
      if (cmd === "test_elevenlabs_key") return true;
      if (cmd === "probe_model_vision") return true;
      if (cmd === "probe_model_audio") return false;
      if (cmd === "probe_model_video") return false;
      if (cmd === "detect_model_reasoning") return false;
      if (cmd === "get_custom_models") return [{
        id: "mock-model-id",
        provider_type: "openai",
        model_name: "gpt-4o-mini",
        display_name: "OpenAI GPT-4o mini",
        base_url: null,
        role_vision: true,
        role_coding: true,
        role_writing: true,
        is_active: true
      }];
      if (cmd === "get_recent_tasks") return [];
      if (cmd === "get_audit_log") return [];
      return null;
    },
    transformCallback: (callback: any, _once: boolean) => {
      const id = Math.floor(Math.random() * 1000000);
      (window as any)[`_${id}`] = callback;
      return id;
    },
    metadata: {
      eventListeners: {}
    },
    plugins: {
      event: {
        listen: async (event: string, _handler: any) => {
          console.log("[Mock Tauri Listen]", event);
          return () => {};
        }
      }
    }
  };
}


ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
