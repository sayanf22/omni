/**
 * TextInputOverlay — floating quick-command bar (Spotlight / Raycast style)
 *
 * Triggered by Ctrl+Shift+T. A single clean rounded pill on a transparent window.
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

  // Make the window background fully transparent so only the rounded card shows
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  const hide = async () => {
    setValue("");
    setRunning(false);
    setError(null);
    try { await getCurrentWindow().hide(); } catch (_) {}
  };

  const handleStop = async () => {
    try { await invoke("cancel_task"); } catch (_) {}
    setRunning(false);
    await hide();
  };

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 80);
    const cleanups: Array<() => void> = [];

    (async () => {
      cleanups.push(await listen("hotkey:text_mode", () => {
        setValue(""); setError(null); setRunning(false);
        setTimeout(() => inputRef.current?.focus(), 50);
      }));
      cleanups.push(await listen("task:done", async () => { await hide(); }));
      cleanups.push(await listen<any>("task:failed", async (e) => {
        setError(e.payload?.error || "Task failed"); setRunning(false);
      }));
      cleanups.push(await listen("agent:killed", async () => { await hide(); }));
    })();

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
    } catch (err: any) {
      setError(err?.toString() || "Failed to start task");
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      running ? handleStop() : hide();
    }
  };

  // Border colour reflects state
  const borderColor = error ? "#7f1d1d" : running ? "#3f3f46" : "#3f3f46";

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        padding: "8px",
        boxSizing: "border-box",
      }}
    >
      <form
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#161618",
          border: `1px solid ${borderColor}`,
          borderRadius: "16px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        {/* Main input row */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "14px 16px" }}>
          {/* Omni logo */}
          <div
            style={{
              width: "26px", height: "26px", borderRadius: "8px",
              background: running ? "#6366F1" : "#ffffff",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {running
              ? <Loader2 style={{ width: 14, height: 14, color: "#fff", animation: "omspin 0.9s linear infinite" }} />
              : <span style={{ color: "#09090B", fontSize: "12px", fontWeight: 900 }}>Ω</span>
            }
          </div>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={running ? "Working on your task…" : "Type a command, e.g. open Notepad and write Hello"}
            disabled={running}
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#fafafa",
              fontSize: "15px",
              fontWeight: 500,
            }}
          />

          {/* Action button */}
          {running ? (
            <button
              type="button"
              onClick={handleStop}
              style={{
                display: "flex", alignItems: "center", gap: "5px",
                padding: "6px 12px", background: "#EF4444", border: "none",
                borderRadius: "9px", color: "#fff", fontSize: "12px", fontWeight: 700,
                cursor: "pointer", flexShrink: 0,
              }}
              title="Stop task (Esc)"
            >
              <Square style={{ width: 11, height: 11, fill: "#fff" }} /> Stop
            </button>
          ) : value ? (
            <button
              type="submit"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "7px", background: "#ffffff", border: "none",
                borderRadius: "9px", cursor: "pointer", flexShrink: 0,
              }}
              title="Run (Enter)"
            >
              <Send style={{ width: 15, height: 15, color: "#09090B" }} />
            </button>
          ) : (
            <button
              type="button"
              onClick={hide}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "6px", background: "transparent", border: "none",
                color: "#71717A", cursor: "pointer", flexShrink: 0, borderRadius: "8px",
              }}
              title="Close (Esc)"
            >
              <X style={{ width: 18, height: 18 }} />
            </button>
          )}
        </div>

        {/* Slim footer hint / error — always inside the rounded card */}
        <div
          style={{
            padding: "7px 16px",
            background: "#0e0e10",
            borderTop: "1px solid #232327",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <span style={{ color: error ? "#f87171" : "#52525B", fontSize: "11px", fontWeight: error ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {error
              ? error
              : running
              ? "Executing on your PC — press Esc or Stop to cancel"
              : "Enter to run  •  Esc to close  •  Ctrl+Shift+A for voice"}
          </span>
          <span style={{ color: "#3f3f46", fontSize: "10px", fontWeight: 700, flexShrink: 0, fontFamily: "monospace" }}>
            OMNI
          </span>
        </div>
      </form>

      <style>{`@keyframes omspin { to { transform: rotate(360deg); } }
        input::placeholder { color: #52525B; }`}</style>
    </div>
  );
};

export default TextInputOverlay;
