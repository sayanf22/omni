import React, { useState } from "react";
import { useStore } from "../store";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Check, ChevronRight, ChevronLeft, Loader2, Sparkles } from "lucide-react";

interface OnboardingProps {
  onComplete: () => void;
}

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [step, setStep] = useState(1);
  const [direction, setDirection] = useState(1);
  const [displayName, setDisplayName] = useState("Primary OpenAI");
  const [provider, setProvider] = useState("openai");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const goToStep = (newStep: number) => {
    setDirection(newStep > step ? 1 : -1);
    setStep(newStep);
  };

  const addCustomModel = useStore((state) => state.addCustomModel);
  const testModel = useStore((state) => state.testModel);

  const handleProviderChange = (p: string) => {
    setProvider(p);
    setTestResult(null);
    if (p === "openai") {
      setDisplayName("Primary OpenAI");
      setModelName("gpt-4o-mini");
      setBaseUrl("");
    } else if (p === "anthropic") {
      setDisplayName("Primary Anthropic");
      setModelName("claude-3-5-sonnet-latest");
      setBaseUrl("");
    } else if (p === "deepseek") {
      setDisplayName("Primary DeepSeek");
      setModelName("deepseek-chat");
      setBaseUrl("");
    } else if (p === "openrouter") {
      setDisplayName("OpenRouter Auto");
      setModelName("google/gemini-2.5-flash");
      setBaseUrl("");
    } else {
      setDisplayName("Custom Endpoint");
      setModelName("my-custom-model");
      setBaseUrl("http://localhost:1234/v1");
    }
  };

  const handleTestConnection = async () => {
    if (!apiKey) {
      setTestResult({ success: false, message: "API Key is required to test." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testModel(provider, modelName, baseUrl || null, apiKey);
      setTestResult({ success: true, message: `Successfully connected: "${result}"` });
    } catch (e: any) {
      setTestResult({ success: false, message: e || "Failed to establish connection." });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveModel = async () => {
    if (!apiKey) {
      setTestResult({ success: false, message: "Please enter your API key before proceeding." });
      return;
    }
    setSaving(true);
    try {
      await addCustomModel({
        provider_type: provider,
        model_name: modelName,
        display_name: displayName,
        base_url: baseUrl || null,
        role_coding: true,
        role_vision: true,
        role_writing: true,
        is_active: true,
      }, apiKey);
      goToStep(4);
    } catch (e: any) {
      setTestResult({ success: false, message: `Failed to save model: ${e.message || e}` });
    } finally {
      setSaving(false);
    }
  };

  const handleSkipModelSetup = async () => {
    setSaving(true);
    try {
      await addCustomModel({
        provider_type: provider,
        model_name: modelName,
        display_name: displayName,
        base_url: baseUrl || null,
        role_coding: true,
        role_vision: true,
        role_writing: true,
        is_active: true,
      }, "mock-key-setup-later");
      goToStep(4);
    } catch (e: any) {
      setTestResult({ success: false, message: `Failed to skip: ${e.message || e}` });
    } finally {
      setSaving(false);
    }
  };

  const stepVariants = {
    enter: (dir: number) => ({
      x: dir > 0 ? 100 : -100,
      opacity: 0
    }),
    center: {
      x: 0,
      opacity: 1
    },
    exit: (dir: number) => ({
      x: dir < 0 ? 100 : -100,
      opacity: 0
    })
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-surface border border-border rounded-xl p-8 shadow-2xl relative overflow-hidden">
        {/* Step Indicator Header */}
        <div className="flex justify-between items-center mb-8 border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-accent" />
            </div>
            <span className="font-bold text-text">Omni Setup Wizard</span>
          </div>
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  s === step ? "w-8 bg-accent" : s < step ? "w-3 bg-accent/45" : "w-3 bg-border"
                }`}
              />
            ))}
          </div>
        </div>

        <div className="min-h-[360px] flex flex-col justify-between">
          <AnimatePresence mode="wait" custom={direction}>
            {step === 1 && (
              <motion.div
                key="step1"
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <h2 className="text-2xl font-bold text-text">Welcome to Omni Agent</h2>
                <p className="text-text-secondary text-sm leading-relaxed">
                  Omni is a state-of-the-art Windows Desktop Assistant that executes tasks directly on your screen.
                  Instead of typing messages in a browser tab, Omni clicks, types, and automates processes just like a human operator.
                </p>
                <div className="bg-surface2 border border-border rounded-lg p-4 space-y-3">
                  <h3 className="text-xs font-semibold text-text uppercase tracking-wider">How to activate:</h3>
                  <div className="flex items-start gap-3 text-sm">
                    <span className="w-5 h-5 rounded-full bg-accent-dim text-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">1</span>
                    <p className="text-text-secondary">Hold <kbd className="px-1.5 py-0.5 bg-surface3 border border-border rounded text-text text-xs">Ctrl + Shift + A</kbd> (default) to activate voice listening. Customizable in Settings.</p>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <span className="w-5 h-5 rounded-full bg-accent-dim text-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">2</span>
                    <p className="text-text-secondary">Speak your instruction (e.g. <i>"Email Sarah the Q2 report"</i>).</p>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <span className="w-5 h-5 rounded-full bg-accent-dim text-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">3</span>
                    <p className="text-text-secondary">Release key to let Omni work, watch screen execution live.</p>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <h2 className="text-2xl font-bold text-text">Verify System Access</h2>
                <p className="text-text-secondary text-sm leading-relaxed">
                  Omni requires standard Windows permissions to read the screen (WinRT OCR) and simulate inputs (keyboard / mouse).
                </p>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-surface2 border border-border rounded-lg">
                    <Shield className="w-5 h-5 text-success shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-text">Offline WinRT OCR Ready</h4>
                      <p className="text-xs text-text-muted">Built-in Windows OCR will run natively for text detection.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-surface2 border border-border rounded-lg">
                    <Shield className="w-5 h-5 text-success shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-text">Enigo Simulation Driver Available</h4>
                      <p className="text-xs text-text-muted">Required to move mouse cursor, click buttons, and type text.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-surface2 border border-border rounded-lg">
                    <Shield className="w-5 h-5 text-warning shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-text">Approval Gate Enabled</h4>
                      <p className="text-xs text-text-muted">High-risk actions (file deletion, posting content) will pause and prompt for confirmation.</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <h2 className="text-2xl font-bold text-text">Configure Your Primary AI Model</h2>
                <p className="text-text-secondary text-sm leading-relaxed">
                  Connect Omni to your preferred LLM provider. Since keys are saved securely in your Windows Credential Manager, your key never leaves your local system.
                </p>

                <div className="grid grid-cols-5 gap-2 mb-4">
                  {["openai", "anthropic", "deepseek", "openrouter", "custom"].map((p) => (
                    <button
                      key={p}
                      onClick={() => handleProviderChange(p)}
                      className={`py-2 px-1 text-xs font-semibold rounded-md border text-center capitalize transition-colors ${
                        provider === p
                          ? "bg-accent border-accent text-accent-contrast shadow-sm"
                          : "bg-surface2 border-border text-text-secondary hover:text-text"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Display Name</label>
                      <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Model Slug</label>
                      <input
                        type="text"
                        value={modelName}
                        onChange={(e) => setModelName(e.target.value)}
                        className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                  </div>

                  {provider === "custom" && (
                    <div>
                      <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Base URL</label>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="e.g. http://localhost:1234/v1"
                        className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">API Key</label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-sm focus:outline-none focus:border-accent font-mono"
                    />
                  </div>

                  <div className="flex gap-2 items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={testing || !apiKey}
                      className="px-4 py-2 border border-border hover:border-border-light bg-surface2 text-text text-xs rounded font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                      {testing ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                          Testing...
                        </>
                      ) : (
                        "Test Connection"
                      )}
                    </button>

                    {testResult && (
                      <span className={`text-xs font-semibold ${testResult.success ? "text-success" : "text-error"}`}>
                        {testResult.success ? "✓ Connected Successfully" : "✗ Connection Failed"}
                      </span>
                    )}
                  </div>

                  {testResult && !testResult.success && (
                    <div className="p-2.5 bg-error-dim/20 border border-error/30 rounded text-xs text-error max-h-20 overflow-y-auto">
                      {testResult.message}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {step === 4 && (
              <motion.div
                key="step4"
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2 }}
                className="space-y-4 text-center py-6"
              >
                <div className="w-16 h-16 rounded-full bg-success/10 border border-success/20 flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-success" />
                </div>
                <h2 className="text-2xl font-bold text-text">Omni is Ready!</h2>
                <p className="text-text-secondary text-sm leading-relaxed max-w-md mx-auto">
                  Onboarding complete. Your API credential has been securely written to your local credential manager and your dashboard is primed.
                </p>
                <div className="bg-surface2 border border-border rounded-lg p-4 max-w-sm mx-auto text-left text-xs space-y-1 text-text-secondary">
                  <div className="flex justify-between"><span className="font-semibold text-text">Mic Activation</span> <span>Ctrl + Shift + A</span></div>
                  <div className="flex justify-between"><span className="font-semibold text-text">Text Command Mode</span> <span>Ctrl + Shift + T</span></div>
                  <div className="flex justify-between"><span className="font-semibold text-text">Cancel Current Task</span> <span>Esc × 2</span></div>
                  <div className="flex justify-between"><span className="font-semibold text-text">Change Hotkeys</span> <span>Settings → Hotkeys</span></div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation Buttons */}
          <div className="flex justify-between border-t border-border pt-6 mt-8">
            {step > 1 && step < 4 ? (
              <button
                onClick={() => goToStep(step - 1)}
                className="px-4 py-2 border border-border hover:border-border-light bg-surface2 text-text text-sm rounded font-medium flex items-center gap-2 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            ) : (
              <div />
            )}

            {step < 3 ? (
              <button
                onClick={() => goToStep(step + 1)}
                className="px-5 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-sm rounded font-semibold flex items-center gap-2 transition-colors ml-auto"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            ) : step === 3 ? (
              <div className="flex gap-2 ml-auto">
                <button
                  type="button"
                  onClick={handleSkipModelSetup}
                  disabled={saving}
                  className="px-4 py-2 border border-border hover:border-border-light bg-surface2 text-text-secondary hover:text-text text-sm rounded font-medium transition-colors"
                >
                  Skip for now
                </button>
                <button
                  onClick={handleSaveModel}
                  disabled={saving || !apiKey}
                  className="px-5 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-sm rounded font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-accent-contrast" />
                      Saving...
                    </>
                  ) : (
                    <>
                      Complete Setup <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            ) : (
              <button
                onClick={onComplete}
                className="w-full py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-sm rounded font-semibold transition-colors"
              >
                Launch Dashboard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
