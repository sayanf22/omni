/**
 * TextInputOverlay — floating quick-command window
 *
 * Triggered by Ctrl+Shift+T. A centered, fully opaque pill-style input.
 * Type a command → Enter to run, Esc to close.
 */
import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Send, X, Loader2, Square } from "lucide-react";

export const TextInputOverlay: React.FC = () => {
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Apply dark theme immediately so CSS vars work in this isolated window
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  }, []);

  const hide = async () => {
    setValue("");
    setRunning(false);
    setError(null);
    try { await getCurrentWindow().hide(); } catch (_) {}
  };

  const handleStop = async () => {
    try {
      await invoke("cancel_task");
    } catch (_) {}
    setRunning(false);
    await hide();
  };

  useEffect(() => {
    // Auto-focus when shown
    setTimeout(() => inputRef.current?.focus(), 80);

    const cleanups: Array<() => void> = [];

    async function setup() {
      cleanups.push(
        await listen("hotkey:text_mode", () => {
          setValue("");
          setError(null);
          setRunning(false);
          setTimeout(() => inputRef.current?.focus(), 50);
        })
      );
      cleanups.push(
        await listen("task:done", async () => {
          await hide();
        })
      );
      cleanups.push(
        await listen<any>("task:failed", async (e) => {
          setError(e.payload?.error || "Task failed");
          setRunning(false);
        })
      );
      cleanups.push(
        await listen("agent:killed", async () => {
          await hide();
        })
      );
    }

    setup();
    return () => cleanups.forEach((fn) => fn());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const instruction = value.trim();
    if (!instruction || running) return;
    setRunning(true);
    setError(null);
    try {
      invoke("run_task", { instruction, userId: "" });
      // Don't await — fire and forget; task:done/failed will close window
    } catch (err: any) {
      setError(err?.toString() || "Failed to start task");
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (running) {
        handleStop();
      } else {
        hide();
      }
    }
  };

  return (
    // Full-window wrapper — dark, fully opaque, no transparency
    <div
      className="w-screen h-screen flex items-center justify-center p-3"
      style={{ background: "#0a0a0f" }}
    >
      <div
        className="w-full max-w-2xl rounded-2xl overflow-hidden shadow-2xl"
        style={{ border: "1px solid #27272A" }}
        onKeyDown={handleKeyDown}
      >
        {/* Header bar */}
        <div
          className="flex items-center justify-between px-4 py-2.5"
          style={{ background: "#18181B", borderBottom: "1px solid #27272A" }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center"
              style={{ background: "#ffffff" }}
            >
              <span style={{ color: "#09090B", fontSize: "9px", fontWeight: 900 }}>Ω</span>
            </div>
            <span style={{ color: "#fafafa", fontSize: "13px", fontWeight: 600 }}>
              {running ? "Running task…" : "Quick Command"}
            </span>
          </div>
          <button
            type="button"
            onClick={running ? handleStop : hide}
            style={{
              color: "#71717A",
              padding: "4px",
              borderRadius: "6px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
            title={running ? "Stop task (Esc)" : "Close (Esc)"}
          >
            {running
              ? <Square style={{ width: 14, height: 14, fill: "#EF4444", color: "#EF4444" }} />
              : <X style={{ width: 14, height: 14 }} />
            }
          </button>
        </div>

        {/* Input area */}
        <div style={{ background: "#09090B", padding: "12px 16px" }}>
          <form onSubmit={handleSubmit} className="flex items-center gap-3">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                running
                  ? "Task is running…"
                  : error
                  ? error
                  : "Type a command and press Enter… (Esc to close)"
              }
              disabled={running}
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: error && !running ? "#EF4444" : "#fafafa",
                fontSize: "14px",
                fontWeight: 500,
                opacity: running ? 0.5 : 1,
              }}
            />
            {running ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Loader2 style={{ width: 16, height: 16, color: "#ffffff", animation: "spin 1s linear infinite" }} />
                <button
                  type="button"
                  onClick={handleStop}
                  style={{
                    padding: "4px 10px",
                    background: "#EF4444",
                    border: "none",
                    borderRadius: "8px",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Stop
                </button>
              </div>
            ) : value ? (
              <button
                type="submit"
                style={{
                  padding: "5px 7px",
                  background: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                }}
                title="Run (Enter)"
              >
                <Send style={{ width: 13, height: 13, color: "#09090B" }} />
              </button>
            ) : (
              <span style={{ color: "#52525B", fontSize: "11px", whiteSpace: "nowrap" }}>
                Enter ↵
              </span>
            )}
          </form>
        </div>

        {/* Hint bar */}
        <div
          style={{
            background: "#18181B",
            padding: "6px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ color: "#52525B", fontSize: "10px" }}>
            {running ? "Executing on your PC…" : "Ctrl+Shift+A for voice • Esc to dismiss"}
          </span>
          {error && !running && (
            <span style={{ color: "#EF4444", fontSize: "10px", fontWeight: 600 }}>
              {error.length > 60 ? error.slice(0, 57) + "…" : error}
            </span>
          )}
        </div>
      </div>

      {/* Add spin keyframe */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default TextInputOverlay;
