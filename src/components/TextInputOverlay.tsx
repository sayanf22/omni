/**
 * TextInputOverlay — Spotlight-style floating command bar
 * Ctrl+Shift+T to open · Enter to run · Esc always closes/stops
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

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
  }, []);

  const hide = async () => {
    setValue(""); setRunning(false); setError(null);
    try { await getCurrentWindow().hide(); } catch (_) {}
  };

  const handleStop = async () => {
    try { await invoke("cancel_task"); } catch (_) {}
    setRunning(false);
    await hide();
  };

  // ── GLOBAL Esc handler — catches Esc at the document level no matter what ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (running) handleStop();
        else hide();
      }
    };
    // capture:true so we intercept before anything else
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [running]); // re-register when running changes so we call the right handler

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
    setRunning(true); setError(null);
    try {
      invoke("run_task", { instruction, userId: "" });
    } catch (err: any) {
      setError(err?.toString() || "Failed"); setRunning(false);
    }
  };

  return (
    <div style={{
      width: "100vw", height: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "transparent", padding: "8px", boxSizing: "border-box",
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          width: "100%",
          display: "flex", flexDirection: "column",
          background: "#141416",
          border: `1px solid ${error ? "#7f1d1d" : "#2e2e34"}`,
          borderRadius: "18px",
          boxShadow: "0 24px 80px rgba(0,0,0,0.75), 0 4px 20px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Input row */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "15px 18px" }}>
          <div style={{
            width: 28, height: 28, borderRadius: 9,
            background: running ? "#6366F1" : "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, transition: "background 0.2s",
          }}>
            {running
              ? <Loader2 style={{ width: 14, height: 14, color: "#fff", animation: "omspin 0.85s linear infinite" }} />
              : <span style={{ color: "#09090B", fontSize: "13px", fontWeight: 900 }}>Ω</span>
            }
          </div>

          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={running ? "Running task…" : "Type a command and press Enter…"}
            disabled={running}
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1, minWidth: 0,
              background: "transparent", border: "none", outline: "none",
              color: "#f4f4f5", fontSize: "15px", fontWeight: 500,
              caretColor: "#6366F1",
            }}
          />

          {running ? (
            <button type="button" onClick={handleStop} style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "6px 14px", background: "#ef4444", border: "none",
              borderRadius: 10, color: "#fff", fontSize: 12, fontWeight: 700,
              cursor: "pointer", flexShrink: 0,
            }}>
              <Square style={{ width: 10, height: 10, fill: "#fff" }} /> Stop
            </button>
          ) : value ? (
            <button type="submit" style={{
              padding: "7px 8px", background: "#fff", border: "none",
              borderRadius: 10, cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center",
            }}>
              <Send style={{ width: 14, height: 14, color: "#09090B" }} />
            </button>
          ) : (
            <button type="button" onClick={hide} style={{
              padding: 6, background: "transparent", border: "none",
              color: "#52525B", cursor: "pointer", flexShrink: 0,
              borderRadius: 8, display: "flex", alignItems: "center",
            }} title="Close (Esc)">
              <X style={{ width: 17, height: 17 }} />
            </button>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "7px 18px",
          background: "#0d0d0f",
          borderTop: "1px solid #1e1e22",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{
            color: error ? "#f87171" : "#3f3f46",
            fontSize: 11, fontWeight: error ? 600 : 400,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {error ? error : running ? "Press Esc to stop" : "Enter to run  ·  Esc to close"}
          </span>
          <kbd style={{ color: "#2e2e36", fontSize: 10, fontFamily: "monospace", fontWeight: 700 }}>ESC</kbd>
        </div>
      </form>
      <style>{`
        @keyframes omspin { to { transform: rotate(360deg); } }
        input::placeholder { color: #3f3f46 !important; }
      `}</style>
    </div>
  );
};

export default TextInputOverlay;
