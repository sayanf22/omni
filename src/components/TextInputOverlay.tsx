/**
 * TextInputOverlay — floating command input window
 *
 * Triggered by Ctrl+Shift+T (default). Shows a centered pill-style input.
 * User types a command → hits Enter → run_task fires → window hides.
 * Esc dismisses without running.
 */
import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Send, X, Loader2 } from "lucide-react";

export const TextInputOverlay: React.FC = () => {
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hide = async () => {
    setValue("");
    setRunning(false);
    setError(null);
    try { await getCurrentWindow().hide(); } catch (_) {}
  };

  useEffect(() => {
    // Auto-focus when the window appears
    const focusInput = () => {
      setTimeout(() => inputRef.current?.focus(), 80);
    };
    focusInput();

    const cleanups: Array<() => void> = [];

    async function setup() {
      // When text_mode hotkey fires, refocus and clear
      cleanups.push(
        await listen("hotkey:text_mode", () => {
          setValue("");
          setError(null);
          setRunning(false);
          setTimeout(() => inputRef.current?.focus(), 50);
        })
      );

      // Collapse when task finishes or errors
      cleanups.push(
        await listen("task:done", async () => {
          await hide();
        })
      );
      cleanups.push(
        await listen<any>("task:failed", async (e) => {
          setError(e.payload?.error || "Task failed");
          setRunning(false);
          // Keep window open so user can see error & retry
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
      // Fire run_task — user_id empty string; planner uses session from keychain
      await invoke("run_task", { instruction, userId: "" });
      // Success handled by task:done listener
    } catch (err: any) {
      setError(err?.toString() || "Failed to start task");
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center p-2">
      <form
        onSubmit={handleSubmit}
        className="w-full flex items-center gap-2 bg-surface/90 backdrop-blur-xl border border-border rounded-2xl px-4 py-2.5 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        {/* Omni logo dot */}
        <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center shrink-0">
          <span className="text-[9px] font-extrabold text-accent-contrast">Ω</span>
        </div>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={error || "Type a command… (Enter to run, Esc to close)"}
          disabled={running}
          className={`flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-text-muted ${
            error ? "placeholder:text-error" : "text-text"
          } disabled:opacity-60`}
          autoComplete="off"
          spellCheck={false}
        />

        {/* Status / Submit */}
        {running ? (
          <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
        ) : value ? (
          <button
            type="submit"
            className="p-1.5 bg-accent hover:bg-accent-hover text-accent-contrast rounded-lg shrink-0 transition-colors"
            title="Run command (Enter)"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={hide}
            className="p-1 text-text-muted hover:text-text shrink-0 transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </form>
    </div>
  );
};

export default TextInputOverlay;
