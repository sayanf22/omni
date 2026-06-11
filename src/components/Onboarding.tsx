import React, { useState } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield, Check, ChevronRight, ChevronLeft,
  Loader2, Sparkles, Zap, Lock, Brain, Sun, Moon
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
  const theme          = useStore((s) => s.theme);
  const toggleTheme    = useStore((s) => s.toggleTheme);
  
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
    <div className="min-h-screen bg-bg flex items-center justify-center p-4 transition-colors duration-200">
      {/* Outer card */}
      <div className="w-full max-w-lg bg-surface border border-border rounded-xl shadow-2xl overflow-hidden transition-colors duration-200">
        {/* Header */}
        <div className="px-7 py-5 border-b border-border/60 flex items-center justify-between transition-colors duration-200">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-surface2 border border-border flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-text" />
            </div>
            <span className="text-text text-sm font-extrabold">Omni Setup Wizard</span>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Step dots */}
            <div className="flex gap-1.5 items-center">
              {[1, 2, 3, 4].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    s === step
                      ? "bg-text w-5"
                      : s < step
                      ? "bg-text/40 w-1.5"
                      : "bg-text/15 w-1.5"
                  }`}
                />
              ))}
            </div>

            {/* Theme Toggle Button */}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg bg-surface border border-border text-text-secondary hover:text-text hover:bg-surface2 transition-all shadow-sm shrink-0"
              title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
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
                <h2 className="text-text text-xl font-extrabold mb-2">Welcome to Omni Agent</h2>
                <p className="text-text-secondary text-xs leading-relaxed">
                  Omni is your Windows desktop AI agent. It controls your PC like a human — opening apps, typing text, clicking buttons, and automating any workflow you describe.
                </p>
                <div className="bg-surface2 border border-border/80 rounded-xl p-4.5 space-y-3">
                  <p className="text-text-muted text-[10px] font-extrabold uppercase tracking-wider">How it works</p>
                  {[
                    { k: "Ctrl+Shift+A", v: "Hold to speak a command, release to execute" },
                    { k: "Ctrl+Shift+T", v: "Type a command in the floating bar" },
                    { k: "Esc × 2", v: "Emergency stop — kills all running tasks" },
                  ].map((row) => (
                    <div key={row.k} className="flex items-center gap-3">
                      <kbd className="bg-surface3 border border-border px-2 py-0.5 rounded-md text-text text-[11px] font-mono font-bold whitespace-nowrap shrink-0">{row.k}</kbd>
                      <span className="text-text-secondary text-[12px]">{row.v}</span>
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
                <h2 className="text-text text-xl font-extrabold mb-2">System Permissions</h2>
                <p className="text-text-secondary text-xs leading-relaxed">
                  Omni needs standard Windows access to see the screen and simulate inputs. No elevated permissions required.
                </p>
                <div className="space-y-2">
                  {[
                    { icon: <Shield className="w-4 h-4 text-success" />, title: "WinRT OCR (offline)", desc: "Reads text on screen — no API needed" },
                    { icon: <Shield className="w-4 h-4 text-success" />, title: "Input simulation (enigo)", desc: "Mouse clicks and keyboard typing" },
                    { icon: <Zap className="w-4 h-4 text-warning" />, title: "Approval gate", desc: "Destructive actions ask for your OK first" },
                  ].map((item) => (
                    <div key={item.title} className="bg-surface2 border border-border/80 rounded-xl p-3 flex items-start gap-3">
                      <div className="mt-0.5 flex-shrink-0">{item.icon}</div>
                      <div>
                        <p className="text-text text-[13px] font-semibold">{item.title}</p>
                        <p className="text-text-secondary text-[11px] mt-0.5">{item.desc}</p>
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
                <h2 className="text-text text-xl font-extrabold mb-1">Connect AI Model</h2>
                <p className="text-text-secondary text-xs leading-relaxed mb-3">
                  Add your AI provider key to get started.
                </p>

                {/* ── Security notice ── */}
                <div className="flex items-start gap-3 bg-success/8 border border-success/20 rounded-xl p-3 mb-3.5">
                  <Lock className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-success text-[11px] font-extrabold mb-0.5">
                      Your API keys are private and stay on your device
                    </p>
                    <p className="text-text-secondary text-[11px] leading-relaxed">
                      Keys are stored in <strong className="text-text">Windows Credential Manager</strong> (DPAPI-encrypted).
                      They are never sent to Omni servers, never logged, and never leave your PC.
                      Only the AI provider you choose receives them.
                    </p>
                  </div>
                </div>

                {/* Provider tabs */}
                <div className="flex gap-1.5 flex-wrap mb-3.5">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id} type="button"
                      onClick={() => handleProviderChange(p.id)}
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                        provider === p.id
                          ? "bg-accent border-accent-hover text-accent-contrast shadow-sm"
                          : "bg-surface2 border-border/60 text-text-secondary hover:text-text hover:bg-surface3"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {/* Input fields */}
                <div className="space-y-3 mb-3">
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      { label: "Display Name", val: displayName, set: setDisplayName, ph: "My GPT-4o" },
                      { label: "Model ID", val: modelName, set: setModelName, ph: "gpt-4o-mini", mono: true },
                    ].map((f) => (
                      <div key={f.label}>
                        <label className="block text-text-muted text-[10px] font-extrabold uppercase tracking-wider mb-1">{f.label}</label>
                        <input
                          value={f.val} onChange={(e) => f.set(e.target.value)}
                          placeholder={f.ph}
                          className={`w-full bg-surface2 border border-border/80 rounded-lg px-3 py-2 text-text text-sm outline-none focus:border-text-secondary transition-all ${
                            f.mono ? "font-mono text-xs" : ""
                          }`}
                        />
                      </div>
                    ))}
                  </div>

                  {provider === "custom" && (
                    <div>
                      <label className="block text-text-muted text-[10px] font-extrabold uppercase tracking-wider mb-1">Base URL</label>
                      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="http://localhost:1234/v1"
                        className="w-full bg-surface2 border border-border/80 rounded-lg px-3 py-2 text-text text-xs font-mono outline-none focus:border-text-secondary transition-all"
                      />
                    </div>
                  )}

                  {/* Reasoning auto-detect badge */}
                  {isReasoningModel !== null && modelName.trim() && (
                    <div className={`flex items-center gap-3 border rounded-xl p-3 ${
                      isReasoningModel
                        ? "bg-purple-500/8 border-purple-500/20 text-purple-400"
                        : "bg-surface2 border-border/80 text-text-secondary"
                    }`}>
                      {isReasoningModel
                        ? <Brain className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                        : <Zap className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                      }
                      <p className="text-[11px] leading-relaxed">
                        {isReasoningModel
                          ? "Reasoning model detected — Omni will auto-route analytical tasks (analyze, solve, compare…) to this model."
                          : "Standard model — handles everyday tasks (browse, write, code, automate)."}
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="block text-text-muted text-[10px] font-extrabold uppercase tracking-wider mb-1">API Key</label>
                    <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-… or your provider key"
                      className="w-full bg-surface2 border border-border/80 rounded-lg px-3 py-2 text-text text-sm font-mono outline-none focus:border-text-secondary transition-all"
                    />
                  </div>
                </div>

                {/* Test button */}
                <button type="button" onClick={handleTest}
                  disabled={testing || !apiKey.trim()}
                  className="w-full py-2.5 bg-surface2 hover:bg-surface3 border border-border rounded-lg text-text text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 mb-2.5"
                >
                  {testing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing capabilities…</>
                    : "Test API Key & Detect Capabilities"
                  }
                </button>

                {/* Capability results — only after test */}
                {tested && (
                  <div className="bg-surface2 border border-border/80 rounded-xl p-3.5 mb-2">
                    <p className="text-text-muted text-[10px] font-extrabold uppercase tracking-wider mb-1.5">Detected Capabilities</p>
                    <CapRow label="Text & Chat" sub="Basic reasoning, coding, writing" state={capText} />
                    <CapRow label="Screen Vision" sub="Can see screenshots / images" state={capVision} />
                    <CapRow label="Audio Input" sub="Accepts audio clips" state={capAudio} />
                    <CapRow label="Video Input" sub="Accepts video clips" state={capVideo} />
                  </div>
                )}

                {testError && (
                  <div className="bg-error-dim border border-error/20 rounded-lg p-2 text-xs text-error mb-2">
                    {testError}
                  </div>
                )}
                {saveError && (
                  <div className="bg-error-dim border border-error/20 rounded-lg p-2 text-xs text-error">
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
                <div className="w-14 h-14 rounded-full bg-success/10 border border-success/25 flex items-center justify-center">
                  <Check className="w-7 h-7 text-success" />
                </div>
                <div>
                  <h2 className="text-text text-xl font-extrabold mb-1">Omni is Ready!</h2>
                  <p className="text-text-secondary text-xs leading-relaxed max-w-xs mx-auto">
                    Your credential is saved securely. The agent will stay logged in automatically — no repeated sign-ins.
                  </p>
                </div>
                <div className="bg-surface2 border border-border/80 rounded-xl p-3.5 w-full max-w-xs text-left space-y-2">
                  {[
                    { k: "Ctrl+Shift+A", v: "Voice command" },
                    { k: "Ctrl+Shift+T", v: "Type command" },
                    { k: "Esc × 2", v: "Emergency stop" },
                  ].map((row) => (
                    <div key={row.k} className="flex justify-between items-center">
                      <span className="text-text-secondary text-[12px]">{row.v}</span>
                      <kbd className="bg-surface3 border border-border px-1.5 py-0.5 rounded text-text text-[10px] font-mono">{row.k}</kbd>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer nav */}
        <div className="px-7 py-5 border-t border-border/60 flex justify-between items-center transition-colors duration-200">
          {(step > 1 && step < 4) ? (
            <button onClick={() => goTo(step - 1)} className="px-4 py-2 bg-surface2 border border-border/80 rounded-lg text-text-secondary hover:text-text hover:bg-surface3 text-sm font-semibold flex items-center gap-1.5">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          ) : <div />}

          {step < 3 && (
            <button onClick={() => goTo(step + 1)} className="px-5 py-2 bg-accent border border-accent-hover text-accent-contrast rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-accent-hover">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}

          {step === 3 && (
            <div className="flex gap-2">
              <button onClick={handleSkip} disabled={saving} className="px-4 py-2 bg-surface2 border border-border/80 rounded-lg text-text-secondary hover:text-text hover:bg-surface3 text-sm font-semibold">
                Skip for now
              </button>
              <button onClick={handleSave} disabled={saving || !tested || capText !== "yes"} className="px-5 py-2 bg-accent border border-accent-hover text-accent-contrast rounded-lg text-sm font-bold flex items-center gap-1.5 hover:bg-accent-hover disabled:opacity-40">
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : <>Complete Setup <ChevronRight className="w-4 h-4" /></>}
              </button>
            </div>
          )}

          {step === 4 && (
            <button onClick={onComplete} className="w-full py-2.5 bg-accent border border-accent-hover text-accent-contrast rounded-lg text-sm font-bold hover:bg-accent-hover transition-all">
              Launch Dashboard
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
