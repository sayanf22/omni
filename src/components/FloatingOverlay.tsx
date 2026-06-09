import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mic, Loader2, CheckCircle2, AlertCircle, X, ShieldAlert } from "lucide-react";

type OverlayState = "idle" | "listening" | "thinking" | "working" | "approval" | "success" | "error";

interface PermissionRequest {
  id: string;
  tool: string;
  action: string;
  description: string;
  preview: string | null;
}

const showWindow = async () => {
  try {
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
  } catch (e) {
    console.error("Failed to show overlay window:", e);
  }
};

const hideWindow = async () => {
  try {
    await getCurrentWindow().hide();
  } catch (e) {
    console.error("Failed to hide overlay window:", e);
  }
};

export const FloatingOverlay: React.FC = () => {
  const [state, setState] = useState<OverlayState>("idle");
  const [text, setText] = useState("");
  const [permissionReq, setPermissionReq] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const cleanups: Array<() => void> = [];

    async function setupListeners() {
      cleanups.push(
        await listen("hotkey:mic_start", async () => {
          await showWindow();
          setState("listening");
          setText("Listening...");
        })
      );

      cleanups.push(
        await listen("hotkey:mic_stop", () => {
          setState("thinking");
          setText("Processing audio...");
        })
      );

      cleanups.push(
        await listen<any>("task:step", async (event) => {
          await showWindow();
          setState("working");
          setText(event.payload.thought || event.payload.description || "Thinking...");
        })
      );

      cleanups.push(
        await listen<PermissionRequest>("permission:request", async (event) => {
          await showWindow();
          setState("approval");
          setPermissionReq(event.payload);
        })
      );

      cleanups.push(
        await listen("task:done", async () => {
          setState("success");
          setText("Task Completed!");
          setTimeout(async () => {
            setState("idle");
            await hideWindow();
          }, 2500);
        })
      );

      cleanups.push(
        await listen<any>("task:failed", async (event) => {
          setState("error");
          setText(event.payload?.error || "Task Failed.");
          setTimeout(async () => {
            setState("idle");
            await hideWindow();
          }, 3000);
        })
      );

      cleanups.push(
        await listen("agent:killed", async () => {
          setState("idle");
          await hideWindow();
        })
      );

      // voice:transcript — Rust transcribed speech via STT; auto-trigger the task
      cleanups.push(
        await listen<{ text: string }>("voice:transcript", async (event) => {
          const transcript = event.payload.text;
          await showWindow();
          setState("thinking");
          setText(`"${transcript}"`);
          try {
            await invoke("run_task", { instruction: transcript, userId: "" });
          } catch (e: any) {
            setState("error");
            setText(e?.toString() || "Failed to start task.");
            setTimeout(async () => {
              setState("idle");
              await hideWindow();
            }, 3000);
          }
        })
      );
    }

    setupListeners();

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const handleApprove = async (approved: boolean) => {
    if (!permissionReq) return;
    try {
      await invoke("approve_request", { id: permissionReq.id, approved });
      setPermissionReq(null);
      setState("working");
      setText("Resuming task...");
    } catch (e) {
      console.error("Failed to respond to permission gate", e);
    }
  };

  const handleCancelTask = async () => {
    try {
      await invoke("cancel_task");
      setState("idle");
      await hideWindow();
    } catch (e) {
      console.error(e);
    }
  };

  if (state === "idle") return null;

  return (
    <div className="w-full h-full bg-bg/75 backdrop-blur-md border border-border rounded-xl p-4 flex items-center justify-between text-text select-none shadow-2xl overflow-hidden">
      {state === "listening" && (
        <div className="flex items-center gap-3.5 w-full">
          <div className="w-9 h-9 rounded-full bg-text/10 border border-border flex items-center justify-center text-text shrink-0 relative">
            <span className="absolute inset-0 rounded-full bg-text/5 animate-ping" />
            <Mic className="w-4 h-4" />
          </div>
          <div className="flex-1 space-y-1">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wider font-mono">Voice Capture Active</span>
            <div className="flex items-center gap-1">
              {[12, 24, 16, 28, 14, 20, 8, 18].map((h, i) => (
                <div
                  key={i}
                  className="bg-text rounded-full animate-bounce"
                  style={{ width: "3px", height: `${h}px`, animationDelay: `${i * 80}ms`, animationDuration: "750ms" }}
                />
              ))}
              <span className="text-xs font-semibold pl-2 text-text-secondary">Hold Ctrl+Shift+A to speak</span>
            </div>
          </div>
        </div>
      )}

      {state === "thinking" && (
        <div className="flex items-center gap-3 w-full">
          <div className="w-8 h-8 rounded-full bg-accent-dim/30 border border-accent/35 flex items-center justify-center text-accent shrink-0">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
          <div>
            <span className="text-[10px] font-bold text-accent uppercase tracking-wider">Cognitive Planner</span>
            <p className="text-xs font-semibold text-text-secondary mt-0.5">{text}</p>
          </div>
        </div>
      )}

      {state === "working" && (
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-accent-dim/30 border border-accent/35 flex items-center justify-center text-accent shrink-0">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Agent Executing</span>
              <p className="text-xs font-semibold text-text-secondary truncate mt-0.5 max-w-[170px]">{text}</p>
            </div>
          </div>
          <button
            onClick={handleCancelTask}
            className="p-1.5 bg-error-dim/20 hover:bg-error-dim/40 text-error border border-error/30 rounded-md text-xs font-bold transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {state === "approval" && permissionReq && (
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full bg-error-dim/30 border border-error/35 flex items-center justify-center text-error shrink-0 animate-pulse">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div className="min-w-0 leading-tight">
              <span className="text-[9px] font-bold text-error uppercase tracking-wider">Risk Permission Required</span>
              <p className="text-xs font-bold text-text truncate mt-0.5 max-w-[130px]">{permissionReq.description}</p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => handleApprove(false)}
              className="px-2.5 py-1.5 bg-surface3 border border-border hover:border-border-light text-text text-[10px] font-bold rounded"
            >
              Deny
            </button>
            <button
              onClick={() => handleApprove(true)}
              className="px-2.5 py-1.5 bg-success hover:bg-success/80 text-bg text-[10px] font-bold rounded"
            >
              Approve
            </button>
          </div>
        </div>
      )}

      {state === "success" && (
        <div className="flex items-center gap-3 w-full">
          <div className="w-8 h-8 rounded-full bg-success/20 border border-success/35 flex items-center justify-center text-success shrink-0">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[10px] font-bold text-success uppercase tracking-wider">Success</span>
            <p className="text-xs font-semibold text-text-secondary mt-0.5">{text}</p>
          </div>
        </div>
      )}

      {state === "error" && (
        <div className="flex items-center justify-between w-full gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-error-dim/30 border border-error/35 flex items-center justify-center text-error shrink-0">
              <AlertCircle className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-bold text-error uppercase tracking-wider">Error Encountered</span>
              <p className="text-xs font-semibold text-text-secondary truncate mt-0.5 max-w-[180px]">{text}</p>
            </div>
          </div>
          <button
            onClick={async () => {
              setState("idle");
              await hideWindow();
            }}
            className="text-text-muted hover:text-text"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
};

export default FloatingOverlay;
