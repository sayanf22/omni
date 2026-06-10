import React, { useState } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield, Check, ChevronRight, ChevronLeft,
  Loader2, Sparkles, Zap, Lock, Brain
} from "lucide-react";

interface OnboardingProps {
  onComplete: () => void;
}

// ── Capability state type ──────────────────────────────────────────────────────
type CapResult = null | "testing" | "yes" | "no";

// ── Provider metadata — NO pre-judgement, just labels ──────────────────────────
const PROVIDERS = [
  { id: "openai",     label: "OpenAI",      defaultModel: "gpt-4o-mini",              defaultName: "Primary OpenAI" },
  { id: "anthropic",  label: "Anthropic",   defaultModel: "claude-3-5-sonnet-latest", defaultName: "Primary Anthropic" },
  { id: "deepseek",   label: "DeepSeek",    defaultModel: "deepseek-chat",            defaultName: "Primary DeepSeek" },
  { id: "openrouter", label: "OpenRouter",  defaultModel: "google/gemini-2.5-flash",  defaultName: "OpenRouter Gemini" },
  { id: "custom",     label: "Custom",      defaultModel: "my-model",                 defaultName: "Custom Endpoint" },
];

// ── Small status indicator ─────────────────────────────────────────────────────
const CapRow: React.FC<{ label: string; sub: string; state: CapResult }> = ({ label, sub, state }) => (
  <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
    <div>
      <p className="text-xs font-semibold text-text">{label}</p>
      <p className="text-[10px] text-text-muted">{sub}</p>
    </div>
    <div className="shrink-0 ml-3">
      {state === null && <span className="text-[10px] text-text-muted">–</span>}
      {state === "testing" && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />}
      {state === "yes" && (
        <span className="px-2 py-0.5 rounded-md bg-success/15 border border-success/25 text-success text-[10px] font-bold uppercase">
          ✓ Yes
        </span>
      )}
      {state === "no" && (
        <span className="px-2 py-0.5 rounded-md bg-surface3 border border-border text-text-muted text-[10px] font-bold uppercase">
          – No
        </span>
      )}
    </div>
  </div>
);

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [step, setStep] = useState(1);
  const [dir, setDir] = useState(1);

  // Step 3 — model config
  const [provider, setProvider]     = useState("openai");
  const [displayName, setDisplayName] = useState("Primary OpenAI");
  const [modelName, setModelName]   = useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl]       = useState("");
  const [apiKey, setApiKey]         = useState("");
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);

  // Capability detection — shown ONLY after testing
  const [testing, setTesting]       = useState(false);
  const [tested, setTested]         = useState(false);
  const [testError, setTestError]   = useState<string | null>(null);
  const [capText, setCapText]       = useState<CapResult>(null);
  const [capVision, setCapVision]   = useState<CapResult>(null);
  const [capAudio, setCapAudio]     = useState<CapResult>(null);
  const [capVideo, setCapVideo]     = useState<CapResult>(null);

  // Auto-detect reasoning from model name
  const [isReasoningModel, setIsReasoningModel] = useState<boolean | null>(null);
  React.useEffect(() => {
    if (!modelName.trim()) { setIsReasoningModel(null); return; }
    invoke<boolean>("detect_model_reasoning", { providerType: provider, modelName: modelName.trim() })
      .then(setIsReasoningModel).catch(() => setIsReasoningModel(null));
  }, [provider, modelName]);

  const addCustomModel = useStore((s) => s.addCustomModel);
  const testModelFn    = useStore((s) => s.testModel);

  const goTo = (n: number) => { setDir(n > step ? 1 : -1); setStep(n); };

  const handleProviderChange = (p: string) => {
    const found = PROVIDERS.find((x) => x.id === p);
    if (!found) return;
    setProvider(p);
    if (!apiKey) {
      setDisplayName(found.defaultName);
      setModelName(found.defaultModel);
      setBaseUrl(p === "custom" ? "http://localhost:1234/v1" : "");
    } else {
      setModelName(found.defaultModel);
      setBaseUrl(p === "custom" ? "http://localhost:1234/v1" : "");
    }
    // Reset test results when provider changes — never pre-judge
    setTested(false);
    setTestError(null);
    setCapText(null); setCapVision(null); setCapAudio(null); setCapVideo(null);
  };

  // ── Sequential capability test ─────────────────────────────────────────────
  const handleTest = async () => {
    if (!apiKey.trim()) { setTestError("Enter your API key first."); return; }
    setTesting(true);
    setTested(true);
    setTestError(null);
    setCapText("testing"); setCapVision(null); setCapAudio(null); setCapVideo(null);

    const args = { providerType: provider, modelName, baseUrl: baseUrl || null, apiKey: apiKey.trim() };

    // 1. Text (basic connection)
    try {
      await testModelFn(provider, modelName, baseUrl || null, apiKey.trim());
      setCapText("yes");
    } catch (e: any) {
      setCapText("no");
      const raw = typeof e === "string" ? e : e?.message || String(e);
      const isAuth = /401|unauthoriz|invalid.*key|authentication/i.test(raw);
      setTestError(isAuth
        ? "Authentication failed — this API key is invalid or expired."
        : raw || "Connection failed. Check the model ID.");
      setTesting(false);
      return;
    }

    // 2. Vision
    setCapVision("testing");
    try { const v = await invoke<boolean>("probe_model_vision", args); setCapVision(v ? "yes" : "no"); }
    catch { setCapVision("no"); }

    // 3. Audio
    setCapAudio("testing");
    try { const a = await invoke<boolean>("probe_model_audio", args); setCapAudio(a ? "yes" : "no"); }
    catch { setCapAudio("no"); }

    // 4. Video
    setCapVideo("testing");
    try { const vid = await invoke<boolean>("probe_model_video", args); setCapVideo(vid ? "yes" : "no"); }
    catch { setCapVideo("no"); }

    setTesting(false);
  };

  const handleSave = async () => {
    if (!apiKey.trim()) { setSaveError("Enter your API key first."); return; }
    if (!tested) { setSaveError("Run the test first so we can detect capabilities."); return; }
    if (capText !== "yes") { setSaveError("Fix the connection error before saving."); return; }

    setSaving(true); setSaveError(null);
    try {
      await addCustomModel({
        provider_type: provider,
        model_name: modelName,
        display_name: displayName,
        base_url: baseUrl || null,
        role_coding: true,
        role_vision: capVision === "yes",
        role_writing: true,
        is_active: true,
      }, apiKey.trim());
      goTo(4);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    setSaving(true);
    try {
      await addCustomModel({
        provider_type: provider, model_name: modelName, display_name: displayName,
        base_url: baseUrl || null, role_coding: true, role_vision: false, role_writing: true, is_active: true,
      }, "mock-key-setup-later");
      goTo(4);
    } catch { /* ignore */ } finally { setSaving(false); }
  };

  const slideVariants = {
    enter: (d: number) => ({ x: d > 0 ? 60 : -60, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d < 0 ? 60 : -60, opacity: 0 }),
  };
  const trans = { duration: 0.22, ease: [0.4, 0, 0.2, 1] };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "#050507" }}
    >
      {/* Outer card */}
      <div
        className="w-full max-w-lg"
        style={{
          background: "#111113",
          border: "1px solid #232327",
          borderRadius: "24px",
          boxShadow: "0 32px 100px rgba(0,0,0,0.7), 0 8px 32px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 28px 16px",
            borderBottom: "1px solid #1e1e22",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 10,
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Sparkles className="w-4 h-4 text-text" />
            </div>
            <span style={{ color: "#f4f4f5", fontSize: 14, fontWeight: 700 }}>Omni Setup Wizard</span>
          </div>
          {/* Step dots */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {[1,2,3,4].map((s) => (
              <div key={s} style={{
                height: 5, borderRadius: 99,
                background: s === step ? "#fff" : s < step ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)",
                width: s === step ? 24 : 10,
                transition: "all 0.3s cubic-bezier(0.4,0,0.2,1)",
              }} />
            ))}
          </div>
        </div>

        {/* Content area — FIXED height so card never resizes */}
        <div style={{ position: "relative", height: 440, overflow: "hidden" }}>
          <AnimatePresence mode="wait" custom={dir}>
            {step === 1 && (
              <motion.div key="s1" custom={dir} variants={slideVariants}
                initial="enter" animate="center" exit="exit" transition={trans}
                style={{ position: "absolute", inset: 0, padding: "28px 28px 0" }}
                className="space-y-4 overflow-y-auto"
              >
                <h2 style={{ color: "#f4f4f5", fontSize: 22, fontWeight: 800 }}>Welcome to Omni Agent</h2>
                <p style={{ color: "#71717A", fontSize: 13, lineHeight: 1.7 }}>
                  Omni is your Windows desktop AI agent. It controls your PC like a human — opening apps, typing text, clicking buttons, and automating any workflow you describe.
                </p>
                <div style={{ background: "#1a1a1d", border: "1px solid #2e2e34", borderRadius: 14, padding: "16px 18px" }} className="space-y-3">
                  <p style={{ color: "#71717A", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>How it works</p>
                  {[
                    { k: "Ctrl+Shift+A", v: "Hold to speak a command, release to execute" },
                    { k: "Ctrl+Shift+T", v: "Type a command in the floating bar" },
                    { k: "Esc × 2", v: "Emergency stop — kills all running tasks" },
                  ].map((row) => (
                    <div key={row.k} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <kbd style={{
                        background: "#232327", border: "1px solid #3a3a40", borderRadius: 7,
                        padding: "3px 8px", fontSize: 11, color: "#f4f4f5", fontFamily: "monospace",
                        whiteSpace: "nowrap", flexShrink: 0,
                      }}>{row.k}</kbd>
                      <span style={{ color: "#a1a1aa", fontSize: 12 }}>{row.v}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div key="s2" custom={dir} variants={slideVariants}
                initial="enter" animate="center" exit="exit" transition={trans}
                style={{ position: "absolute", inset: 0, padding: "28px 28px 0" }}
                className="space-y-4 overflow-y-auto"
              >
                <h2 style={{ color: "#f4f4f5", fontSize: 22, fontWeight: 800 }}>System Permissions</h2>
                <p style={{ color: "#71717A", fontSize: 13, lineHeight: 1.7 }}>
                  Omni needs standard Windows access to see the screen and simulate inputs. No elevated permissions required.
                </p>
                <div className="space-y-2">
                  {[
                    { icon: <Shield className="w-4 h-4 text-success" />, title: "WinRT OCR (offline)", desc: "Reads text on screen — no API needed" },
                    { icon: <Shield className="w-4 h-4 text-success" />, title: "Input simulation (enigo)", desc: "Mouse clicks and keyboard typing" },
                    { icon: <Zap className="w-4 h-4 text-warning" />, title: "Approval gate", desc: "Destructive actions ask for your OK first" },
                  ].map((item) => (
                    <div key={item.title} style={{
                      background: "#1a1a1d", border: "1px solid #2e2e34",
                      borderRadius: 12, padding: "12px 16px",
                      display: "flex", alignItems: "flex-start", gap: 12,
                    }}>
                      <div style={{ marginTop: 1, flexShrink: 0 }}>{item.icon}</div>
                      <div>
                        <p style={{ color: "#f4f4f5", fontSize: 13, fontWeight: 600 }}>{item.title}</p>
                        <p style={{ color: "#71717A", fontSize: 11, marginTop: 2 }}>{item.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div key="s3" custom={dir} variants={slideVariants}
                initial="enter" animate="center" exit="exit" transition={trans}
                style={{ position: "absolute", inset: 0, padding: "28px 28px 0" }}
                className="overflow-y-auto"
              >
                <h2 style={{ color: "#f4f4f5", fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Connect AI Model</h2>
                <p style={{ color: "#71717A", fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
                  Add your AI provider key to get started.
                </p>

                {/* ── Security notice ── */}
                <div style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)",
                  borderRadius: 12, padding: "10px 14px", marginBottom: 14,
                }}>
                  <Lock style={{ width: 14, height: 14, color: "#10b981", flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <p style={{ color: "#10b981", fontSize: 11, fontWeight: 700, marginBottom: 2 }}>
                      Your API keys are private and stay on your device
                    </p>
                    <p style={{ color: "#6b7280", fontSize: 11, lineHeight: 1.6 }}>
                      Keys are stored in <strong style={{ color: "#9ca3af" }}>Windows Credential Manager</strong> (DPAPI-encrypted).
                      They are never sent to Omni servers, never logged, and never leave your PC.
                      Only the AI provider you choose receives them.
                    </p>
                  </div>
                </div>

                {/* Provider tabs */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id} type="button"
                      onClick={() => handleProviderChange(p.id)}
                      style={{
                        padding: "7px 14px",
                        borderRadius: 10,
                        border: `1px solid ${provider === p.id ? "rgba(255,255,255,0.9)" : "#2e2e34"}`,
                        background: provider === p.id ? "#fff" : "#1a1a1d",
                        color: provider === p.id ? "#09090B" : "#a1a1aa",
                        fontSize: 12, fontWeight: 700,
                        cursor: "pointer", transition: "all 0.15s",
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {/* Input fields */}
                <div className="space-y-3 mb-3">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {[
                      { label: "Display Name", val: displayName, set: setDisplayName, ph: "My GPT-4o" },
                      { label: "Model ID", val: modelName, set: setModelName, ph: "gpt-4o-mini", mono: true },
                    ].map((f) => (
                      <div key={f.label}>
                        <label style={{ display: "block", color: "#52525B", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>{f.label}</label>
                        <input
                          value={f.val} onChange={(e) => f.set(e.target.value)}
                          placeholder={f.ph}
                          style={{
                            width: "100%", background: "#1a1a1d", border: "1px solid #2e2e34",
                            borderRadius: 10, padding: "9px 12px", color: "#f4f4f5",
                            fontSize: f.mono ? 12 : 13, fontFamily: f.mono ? "monospace" : "inherit",
                            outline: "none", boxSizing: "border-box",
                          }}
                          onFocus={(e) => { e.target.style.borderColor = "#5a5a6a"; }}
                          onBlur={(e) => { e.target.style.borderColor = "#2e2e34"; }}
                        />
                      </div>
                    ))}
                  </div>

                  {provider === "custom" && (
                    <div>
                      <label style={{ display: "block", color: "#52525B", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Base URL</label>
                      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="http://localhost:1234/v1"
                        style={{ width: "100%", background: "#1a1a1d", border: "1px solid #2e2e34", borderRadius: 10, padding: "9px 12px", color: "#f4f4f5", fontSize: 12, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
                        onFocus={(e) => { e.target.style.borderColor = "#5a5a6a"; }}
                        onBlur={(e) => { e.target.style.borderColor = "#2e2e34"; }}
                      />
                    </div>
                  )}

                  {/* Reasoning auto-detect badge */}
                  {isReasoningModel !== null && modelName.trim() && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8,
                      background: isReasoningModel ? "rgba(168,85,247,0.1)" : "#1a1a1d",
                      border: `1px solid ${isReasoningModel ? "rgba(168,85,247,0.3)" : "#2e2e34"}`,
                      borderRadius: 10, padding: "8px 12px",
                    }}>
                      {isReasoningModel
                        ? <Brain style={{ width: 13, height: 13, color: "#c084fc", flexShrink: 0 }} />
                        : <Zap style={{ width: 13, height: 13, color: "#6b7280", flexShrink: 0 }} />
                      }
                      <p style={{ color: isReasoningModel ? "#c084fc" : "#71717A", fontSize: 11, lineHeight: 1.4 }}>
                        {isReasoningModel
                          ? "Reasoning model detected — Omni will auto-route analytical tasks (analyze, solve, compare…) to this model."
                          : "Standard model — handles everyday tasks (browse, write, code, automate)."}
                      </p>
                    </div>
                  )}

                  <div>
                    <label style={{ display: "block", color: "#52525B", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>API Key</label>
                    <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-… or your provider key"
                      style={{ width: "100%", background: "#1a1a1d", border: "1px solid #2e2e34", borderRadius: 10, padding: "9px 12px", color: "#f4f4f5", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}
                      onFocus={(e) => { e.target.style.borderColor = "#5a5a6a"; }}
                      onBlur={(e) => { e.target.style.borderColor = "#2e2e34"; }}
                    />
                  </div>
                </div>

                {/* Test button */}
                <button type="button" onClick={handleTest}
                  disabled={testing || !apiKey.trim()}
                  style={{
                    width: "100%", padding: "10px", background: "#1e1e22",
                    border: "1px solid #2e2e34", borderRadius: 10,
                    color: testing ? "#71717A" : "#f4f4f5",
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    opacity: !apiKey.trim() ? 0.4 : 1,
                    marginBottom: 10,
                  }}
                >
                  {testing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing capabilities…</>
                    : "Test API Key & Detect Capabilities"
                  }
                </button>

                {/* Capability results — only after test */}
                {tested && (
                  <div style={{ background: "#141416", border: "1px solid #2e2e34", borderRadius: 12, padding: "10px 14px", marginBottom: 8 }}>
                    <p style={{ color: "#52525B", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>Detected Capabilities</p>
                    <CapRow label="Text & Chat" sub="Basic reasoning, coding, writing" state={capText} />
                    <CapRow label="Screen Vision" sub="Can see screenshots / images" state={capVision} />
                    <CapRow label="Audio Input" sub="Accepts audio clips" state={capAudio} />
                    <CapRow label="Video Input" sub="Accepts video clips" state={capVideo} />
                  </div>
                )}

                {testError && (
                  <div style={{ background: "rgba(127,29,29,0.25)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#f87171", marginBottom: 8 }}>
                    {testError}
                  </div>
                )}
                {saveError && (
                  <div style={{ background: "rgba(127,29,29,0.25)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#f87171" }}>
                    {saveError}
                  </div>
                )}
              </motion.div>
            )}

            {step === 4 && (
              <motion.div key="s4" custom={dir} variants={slideVariants}
                initial="enter" animate="center" exit="exit" transition={trans}
                style={{ position: "absolute", inset: 0, padding: "40px 28px 0", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 16 }}
              >
                <div style={{
                  width: 60, height: 60, borderRadius: "50%",
                  background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.25)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Check className="w-7 h-7 text-success" />
                </div>
                <div>
                  <h2 style={{ color: "#f4f4f5", fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Omni is Ready!</h2>
                  <p style={{ color: "#71717A", fontSize: 13, lineHeight: 1.7, maxWidth: 340, margin: "0 auto" }}>
                    Your credential is saved securely. The agent will stay logged in automatically — no repeated sign-ins.
                  </p>
                </div>
                <div style={{ background: "#1a1a1d", border: "1px solid #2e2e34", borderRadius: 14, padding: "14px 20px", width: "100%", maxWidth: 320, textAlign: "left" }} className="space-y-2">
                  {[
                    { k: "Ctrl+Shift+A", v: "Voice command" },
                    { k: "Ctrl+Shift+T", v: "Type command" },
                    { k: "Esc × 2", v: "Emergency stop" },
                  ].map((row) => (
                    <div key={row.k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: "#71717A", fontSize: 12 }}>{row.v}</span>
                      <kbd style={{ background: "#232327", border: "1px solid #3a3a40", borderRadius: 6, padding: "2px 7px", fontSize: 10, color: "#f4f4f5", fontFamily: "monospace" }}>{row.k}</kbd>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer nav */}
        <div style={{
          padding: "16px 28px 24px",
          borderTop: "1px solid #1e1e22",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          {(step > 1 && step < 4) ? (
            <button onClick={() => goTo(step - 1)} style={{
              padding: "9px 16px", background: "#1a1a1d", border: "1px solid #2e2e34",
              borderRadius: 10, color: "#a1a1aa", fontSize: 13, fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          ) : <div />}

          {step < 3 && (
            <button onClick={() => goTo(step + 1)} style={{
              padding: "9px 20px", background: "#fff", border: "none",
              borderRadius: 10, color: "#09090B", fontSize: 13, fontWeight: 700, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}

          {step === 3 && (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleSkip} disabled={saving} style={{
                padding: "9px 16px", background: "#1a1a1d", border: "1px solid #2e2e34",
                borderRadius: 10, color: "#71717A", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>
                Skip for now
              </button>
              <button onClick={handleSave} disabled={saving || !tested || capText !== "yes"} style={{
                padding: "9px 20px", background: "#fff", border: "none",
                borderRadius: 10, color: "#09090B", fontSize: 13, fontWeight: 700, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
                opacity: (saving || !tested || capText !== "yes") ? 0.4 : 1,
              }}>
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : <>Complete Setup <ChevronRight className="w-4 h-4" /></>}
              </button>
            </div>
          )}

          {step === 4 && (
            <button onClick={onComplete} style={{
              width: "100%", padding: "11px", background: "#fff", border: "none",
              borderRadius: 10, color: "#09090B", fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>
              Launch Dashboard
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
