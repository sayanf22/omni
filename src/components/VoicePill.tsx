/**
 * VoicePill — a guaranteed-visible voice indicator rendered INSIDE the main
 * window (fixed, top-right). Unlike the separate transparent overlay window
 * (which can fail to composite / show), this always renders because it's part
 * of the main React tree. Shows a live waveform that moves with your voice,
 * the transcribed text, and task progress.
 */
import React, { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Mic, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

type PillState = "hidden" | "listening" | "transcribing" | "thinking" | "working" | "done" | "error";

const Bars: React.FC<{ level: number }> = ({ level }) => {
  const bars = 13;
  const shape = [0.35, 0.5, 0.7, 0.85, 0.95, 1, 1, 1, 0.95, 0.85, 0.7, 0.5, 0.35];
  const lvl = Math.max(0, Math.min(1, level));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height: 24 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = 4, max = 22;
        const h = Math.max(base, Math.min(max, base + lvl * (max - base) * shape[i]));
        return (
          <span key={i} className="vp-bar" style={{
            width: 3, height: h, borderRadius: 3,
            background: "linear-gradient(180deg,#a78bfa,#38bdf8)",
            transition: "height 80ms cubic-bezier(0.4,0,0.2,1)",
            animationDelay: `${i * 0.07}s`,
            animationDuration: lvl > 0.1 ? "0.55s" : "1.2s",
          }} />
        );
      })}
    </div>
  );
};

export const VoicePill: React.FC = () => {
  const [state, setState] = useState<PillState>("hidden");
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState("");
  const [msg, setMsg] = useState("");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHide = (ms: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setState("hidden"), ms);
  };
  const cancelHide = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };

  useEffect(() => {
    let active = true;
    const unsubscribes: Array<() => void> = [];

    async function setup() {
      const addListener = async (evt: string, cb: (...args: any[]) => void) => {
        const unsub = await listen(evt, cb);
        if (active) {
          unsubscribes.push(unsub);
        } else {
          unsub();
        }
      };

      await addListener("hotkey:mic_start", () => {
        cancelHide(); setHeard(""); setMsg(""); setLevel(0); setState("listening");
      });
      await addListener("voice:level", (e: any) => {
        if (typeof e.payload === "number") setLevel(e.payload);
      });
      await addListener("hotkey:mic_stop", () => {
        setState("transcribing");
      });
      await addListener("voice:transcript", (e: any) => {
        setHeard((e.payload?.text || "").trim());
        setState("thinking");
      });
      await addListener("voice:test_result", (e: any) => {
        if (e.payload?.ok) { setHeard((e.payload.text || "").trim()); setState("done"); setMsg("Heard you clearly"); }
        else { setMsg(e.payload?.error || "Couldn't transcribe"); setState("error"); }
        scheduleHide(5000);
      });
      await addListener("task:started", (e: any) => {
        const instr = (e.payload?.instruction || "").trim();
        if (instr) setHeard(instr);
        cancelHide(); setState("thinking");
      });
      await addListener("task:step", (e: any) => {
        cancelHide(); setState("working");
        setMsg(e.payload?.thought || e.payload?.description || "Working…");
      });
      await addListener("task:done", (e: any) => {
        setState("done"); setMsg(e.payload?.result || "Done"); scheduleHide(5000);
      });
      await addListener("task:failed", (e: any) => {
        setState("error"); setMsg(e.payload?.error || "Task failed"); scheduleHide(6000);
      });
      await addListener("agent:killed", () => { setState("hidden"); });
    }

    setup();
    return () => {
      active = false;
      unsubscribes.forEach((fn) => fn());
    };
  }, []);

  if (state === "hidden") return null;

  const cfg = {
    listening:    { c: "#a78bfa", label: "Listening", icon: <Mic size={13} /> },
    transcribing: { c: "#818CF8", label: "Transcribing…", icon: <Loader2 size={13} className="vp-spin" /> },
    thinking:     { c: "#818CF8", label: "Thinking", icon: <Loader2 size={13} className="vp-spin" /> },
    working:      { c: "#38bdf8", label: "Working", icon: <Loader2 size={13} className="vp-spin" /> },
    done:         { c: "#34d399", label: "Done", icon: <CheckCircle2 size={13} /> },
    error:        { c: "#f87171", label: "Error", icon: <AlertCircle size={13} /> },
  }[state]!;

  return (
    <div style={{
      position: "fixed", top: 16, right: 16, zIndex: 99999,
      width: 320, maxWidth: "calc(100vw - 32px)",
      background: "linear-gradient(135deg, rgba(20,20,28,0.92), rgba(12,12,18,0.92))",
      backdropFilter: "blur(24px) saturate(160%)",
      WebkitBackdropFilter: "blur(24px) saturate(160%)",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 18,
      boxShadow: "0 12px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)",
      padding: "12px 14px",
      animation: "vpIn 0.22s cubic-bezier(0.34,1.2,0.64,1)",
      userSelect: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{
          display: "flex", alignItems: "center", gap: 5, padding: "3px 9px 3px 7px",
          background: `${cfg.c}22`, border: `1px solid ${cfg.c}55`, borderRadius: 99, flexShrink: 0,
          color: cfg.c, fontSize: 10, fontWeight: 700,
        }}>
          {cfg.icon}{cfg.label}
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
          {state === "listening" || state === "transcribing"
            ? <Bars level={state === "listening" ? level : 0.15} />
            : <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{msg}</span>}
        </div>
      </div>

      {heard && (
        <div style={{
          marginTop: 9, padding: "8px 10px", borderRadius: 11,
          background: "linear-gradient(135deg, rgba(56,189,248,0.10), rgba(129,140,248,0.06))",
          border: "1px solid rgba(56,189,248,0.20)",
        }}>
          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 2 }}>You said</p>
          <p style={{ color: "rgba(255,255,255,0.92)", fontSize: 12, lineHeight: 1.45, wordBreak: "break-word" }}>{heard}</p>
        </div>
      )}
    </div>
  );
};

export default VoicePill;

// Inject keyframes once
if (typeof document !== "undefined" && !document.getElementById("voicepill-styles")) {
  const s = document.createElement("style");
  s.id = "voicepill-styles";
  s.textContent = `
    @keyframes vpIn { from { opacity:0; transform: translateY(-8px) scale(0.96);} to {opacity:1; transform:none;} }
    @keyframes vpSpin { to { transform: rotate(360deg);} }
    @keyframes vpWave { 0%,100%{transform:scaleY(0.5);} 50%{transform:scaleY(1);} }
    .vp-spin { animation: vpSpin 0.8s linear infinite; }
    .vp-bar { animation: vpWave 1.2s ease-in-out infinite; transform-origin:center; }
  `;
  document.head.appendChild(s);
}
