import React, { useState, useEffect } from "react";
import { useStore, CustomModel } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Trash2, Loader2, XCircle, Key, Keyboard,
  AlertTriangle, RefreshCw, Eye, EyeOff, Pencil, ChevronDown, ChevronUp, Check,
  Brain, Zap, Power, ToggleLeft, ToggleRight, Sun, Moon, Folder
} from "lucide-react";

// ── Capability detection ──────────────────────────────────────────────────────
// Uses ACTUAL probe result stored in role_vision (set by test_vision_capability)
// We show what the API actually confirmed, not just name guessing.

function capabilityLabel(model: CustomModel): {
  vision: boolean;
  label: string;
  description: string;
} {
  const provider = model.provider_type.toLowerCase();
  const name = model.model_name.toLowerCase();

  // Use the stored role_vision flag — set by the real probe test
  const vision = model.role_vision;

  let description = "";
  if (provider === "deepseek") {
    description = name.includes("vl") || name.includes("vision")
      ? "DeepSeek Vision model — image input confirmed"
      : "DeepSeek text/code model — no image input (use deepseek-vl for vision)";
  } else if (provider === "openai") {
    description = vision
      ? "GPT vision model — can see your screen"
      : "GPT text model — no image input";
  } else if (provider === "anthropic") {
    description = vision ? "Claude vision — can see your screen" : "Claude text-only";
  } else if (provider === "openrouter") {
    description = vision
      ? "Vision-capable via OpenRouter — can see your screen"
      : "Text-only model via OpenRouter";
  } else {
    description = vision ? "Vision confirmed by API test" : "Text/code only — no image input";
  }

  return { vision, label: vision ? "Screen Vision" : "Text & Code Only", description };
}

// ── Model Form ────────────────────────────────────────────────────────────────

interface ModelFormProps {
  editModel?: CustomModel;        // if set, we're editing
  onSave: () => void;
  onCancel: () => void;
  addCustomModel: (m: Omit<CustomModel, "id">, key: string) => Promise<void>;
  updateCustomModel: (id: string, m: Omit<CustomModel, "id">, key?: string) => Promise<void>;
  testModelFn: (p: string, m: string, u: string | null, k: string) => Promise<string>;
}

// Capability checklist icon (pending / spinner / check / cross)
const CapIcon: React.FC<{ state: null | "testing" | "yes" | "no" | "skip" }> = ({ state }) => {
  if (state === "testing") return <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />;
  if (state === "yes")     return <span className="w-4 h-4 rounded-full bg-success/20 border border-success/40 flex items-center justify-center shrink-0"><span className="text-success text-[10px] font-black">✓</span></span>;
  if (state === "no")      return <span className="w-4 h-4 rounded-full bg-surface3 border border-border flex items-center justify-center shrink-0"><span className="text-text-muted text-[10px] font-black">–</span></span>;
  return <span className="w-4 h-4 rounded-full border border-dashed border-border shrink-0" />;
};

const CapBadge: React.FC<{ state: null | "testing" | "yes" | "no" | "skip" }> = ({ state }) => {
  if (state === "testing") return <span className="text-[10px] font-bold text-accent">testing…</span>;
  if (state === "yes")     return <span className="text-[10px] font-bold uppercase text-success px-1.5 py-0.5 rounded bg-success/10 border border-success/20">Supported</span>;
  if (state === "no")      return <span className="text-[10px] font-bold uppercase text-text-muted px-1.5 py-0.5 rounded bg-surface3 border border-border">Not available</span>;
  return <span className="text-[10px] text-text-muted">pending</span>;
};

const PROVIDER_DEFAULTS: Record<string, { displayName: string; modelName: string; baseUrl: string; visionExpected: boolean }> = {
  openai:     { displayName: "OpenAI GPT-4.1 mini",   modelName: "gpt-4.1-mini",             baseUrl: "", visionExpected: true  },
  anthropic:  { displayName: "Anthropic Claude",       modelName: "claude-3-5-sonnet-latest", baseUrl: "", visionExpected: true  },
  deepseek:   { displayName: "DeepSeek Chat",          modelName: "deepseek-chat",            baseUrl: "", visionExpected: false },
  openrouter: { displayName: "OpenRouter Gemini Flash", modelName: "google/gemini-2.5-flash", baseUrl: "", visionExpected: true  },
  custom:     { displayName: "Custom Model",           modelName: "my-model",                 baseUrl: "http://localhost:1234/v1", visionExpected: false },
};

// Popular OpenAI model suggestions shown as quick-fill chips
const OPENAI_MODEL_SUGGESTIONS = [
  { label: "GPT-4.1",       slug: "gpt-4.1",        vision: true  },
  { label: "GPT-4.1 mini",  slug: "gpt-4.1-mini",   vision: true  },
  { label: "GPT-4.1 nano",  slug: "gpt-4.1-nano",   vision: true  },
  { label: "GPT-4o",        slug: "gpt-4o",          vision: true  },
  { label: "GPT-4o mini",   slug: "gpt-4o-mini",     vision: true  },
  { label: "o3",            slug: "o3",              vision: false },
  { label: "o4-mini",       slug: "o4-mini",         vision: false },
  { label: "o3-mini",       slug: "o3-mini",         vision: false },
];

const ModelForm: React.FC<ModelFormProps> = ({
  editModel, onSave, onCancel, addCustomModel, updateCustomModel, testModelFn
}) => {
  const isEdit = !!editModel;
  const [provider, setProvider]   = useState(editModel?.provider_type || "openai");
  const [displayName, setDisplayName] = useState(editModel?.display_name || "OpenAI GPT-4o mini");
  const [modelName, setModelName] = useState(editModel?.model_name || "gpt-4o-mini");
  const [baseUrl, setBaseUrl]     = useState(editModel?.base_url || "");
  const [apiKey, setApiKey]       = useState("");
  const [isActive, setIsActive]   = useState(editModel?.is_active ?? true);
  const [roleCoding, setRoleCoding]   = useState(editModel?.role_coding ?? false);
  const [roleWriting, setRoleWriting] = useState(editModel?.role_writing ?? false);

  // "Both" mode: when enabled, the system auto-classifies all tasks (reasoning vs basic)
  // using this model as a universal fallback — no need to manually set individual roles.
  // When enabled we set all role flags true; the routing still prefers a reasoning model
  // for analytical tasks automatically.
  const [bothMode, setBothMode] = useState(
    isEdit
      ? (editModel.role_coding && editModel.role_writing)
      : false
  );

  // Reasoning classification hint — fetched from Rust when model name changes.
  const [isReasoningModel, setIsReasoningModel] = useState<boolean | null>(null);

  // Auto-detect reasoning whenever modelName or provider changes.
  React.useEffect(() => {
    if (!modelName.trim()) { setIsReasoningModel(null); return; }
    invoke<boolean>("detect_model_reasoning", {
      providerType: provider,
      modelName: modelName.trim(),
    }).then((r) => setIsReasoningModel(r)).catch(() => setIsReasoningModel(null));
  }, [provider, modelName]);

  // Capability detection state — each: null | "testing" | "yes" | "no" | "skip"
  type CapState = null | "testing" | "yes" | "no" | "skip";
  const [capText, setCapText]     = useState<CapState>(isEdit ? "yes" : null);
  const [capVision, setCapVision] = useState<CapState>(isEdit ? (editModel.role_vision ? "yes" : "no") : null);
  const [capAudio, setCapAudio]   = useState<CapState>(null);
  const [capVideo, setCapVideo]   = useState<CapState>(null);
  const [testing, setTesting]     = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [hasTested, setHasTested] = useState(isEdit);

  // Whether a usable key is stored locally for this model (edit mode)
  const [storedKeyState, setStoredKeyState] = useState<"checking" | "present" | "absent">(isEdit ? "checking" : "absent");

  const [saving, setSaving] = useState(false);

  // On mount (edit mode): check if a real key is stored locally in Credential Manager
  React.useEffect(() => {
    if (!isEdit || !editModel) return;
    (async () => {
      try {
        const stored = await invoke<string | null>("get_api_key", { name: editModel.id });
        setStoredKeyState(stored && stored.trim() ? "present" : "absent");
      } catch {
        setStoredKeyState("absent");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetCaps = () => {
    setCapText(null); setCapVision(null); setCapAudio(null); setCapVideo(null);
    setTestError(null); setHasTested(false);
  };

  const handleProviderChange = (p: string) => {
    setProvider(p);
    resetCaps();
    const d = PROVIDER_DEFAULTS[p];
    if (d && !isEdit) {
      setDisplayName(d.displayName);
      setModelName(d.modelName);
      setBaseUrl(d.baseUrl);
    }
  };

  // Sequential capability test: text → vision → audio → video
  const handleTest = async () => {
    const typedKey = apiKey.trim();

    // For new models, require a key to be typed.
    if (!isEdit && !typedKey) {
      setTestError("Enter your API key first.");
      return;
    }

    setTesting(true);
    setTestError(null);
    setHasTested(true);
    setCapText("testing"); setCapVision(null); setCapAudio(null); setCapVideo(null);

    // Probe args — pass typed key (may be empty in edit mode) plus the model ID
    // so the Rust backend can look up the stored key from Credential Manager when
    // no new key was typed. The real key NEVER comes back to the frontend.
    const probeArgs = {
      providerType: provider,
      modelName,
      baseUrl: baseUrl || null,
      apiKey: typedKey,
      modelId: isEdit ? editModel?.id : undefined,
    };

    // 1️⃣ TEXT — basic connection
    try {
      if (isEdit && editModel) {
        // Use the dedicated command that resolves the stored key server-side.
        await invoke("test_stored_model", {
          modelId: editModel.id,
          providerType: provider,
          modelName,
          baseUrl: baseUrl || null,
          typedKey,
        });
      } else {
        await testModelFn(provider, modelName, baseUrl || null, typedKey);
      }
      setCapText("yes");
      setRoleCoding(true);
      setRoleWriting(true);
    } catch (e: any) {
      setCapText("no");
      const raw = typeof e === "string" ? e : e?.message || String(e);
      const isAuth = /401|unauthorized|missing auth|invalid.*key|authentication/i.test(raw);
      if (isAuth) {
        setTestError(
          typedKey
            ? "Authentication failed — this API key is invalid or expired. Double-check the key and try again."
            : "The saved API key is invalid or expired. Paste a fresh key in the field above and test again."
        );
        setStoredKeyState("absent");
      } else {
        setTestError(raw || "Connection failed. Check the model ID and your API key.");
      }
      setTesting(false);
      return;
    }

    // 2️⃣ VISION
    setCapVision("testing");
    try { const v = await invoke<boolean>("probe_model_vision", probeArgs); setCapVision(v ? "yes" : "no"); }
    catch { setCapVision("no"); }

    // 3️⃣ AUDIO
    setCapAudio("testing");
    try { const a = await invoke<boolean>("probe_model_audio", probeArgs); setCapAudio(a ? "yes" : "no"); }
    catch { setCapAudio("no"); }

    // 4️⃣ VIDEO
    setCapVideo("testing");
    try { const vid = await invoke<boolean>("probe_model_video", probeArgs); setCapVideo(vid ? "yes" : "no"); }
    catch { setCapVideo("no"); }

    setTesting(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasTested && !isEdit) {
      setTestError("Test the model first so we can detect its capabilities.");
      return;
    }
    if (capText === "no") {
      setTestError("This model failed the connection test — fix the key/model ID before saving.");
      return;
    }

    setSaving(true);
    const typedKey = apiKey.trim();
    const keyToSave = typedKey ? typedKey : undefined; // blank = keep stored key
    const finalVision = capVision === "yes" ? true : capVision === "no" ? false : (editModel?.role_vision ?? false);

    const modelData: Omit<CustomModel, "id"> = {
      provider_type: provider,
      model_name: modelName,
      display_name: displayName,
      base_url: baseUrl || null,
      role_vision: finalVision,
      role_coding: roleCoding,
      role_writing: roleWriting,
      is_active: isActive,
    };

    try {
      if (isEdit && editModel) {
        await updateCustomModel(editModel.id, modelData, keyToSave);
      } else {
        await addCustomModel(modelData, apiKey);
      }
      onSave();
    } catch (err: any) {
      setTestError(`Save failed: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const providers = [
    { id: "openai",     label: "OpenAI",     hint: "GPT-4o, gpt-4o-mini…" },
    { id: "anthropic",  label: "Anthropic",  hint: "claude-3-5-sonnet…" },
    { id: "deepseek",   label: "DeepSeek",   hint: "deepseek-chat, deepseek-vl…" },
    { id: "openrouter", label: "OpenRouter", hint: "Any model via one key" },
    { id: "custom",     label: "Custom",     hint: "Self-hosted / proxy" },
  ];

  return (
    <form
      onSubmit={handleSave}
      className="p-6.5 bg-surface2 border border-border-light rounded-2xl space-y-5 shadow-lg premium-card"
    >
      <h4 className="font-black text-text text-base">
        {isEdit ? `Edit: ${editModel?.display_name}` : "Add New Model"}
      </h4>

      {/* Provider selector */}
      <div className="space-y-2">
        <label className="text-[11.5px] font-black text-text-secondary uppercase tracking-wider">Provider</label>
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <button
              key={p.id} type="button"
              onClick={() => handleProviderChange(p.id)}
              title={p.hint}
              className={`px-4 py-2.5 text-xs font-bold rounded-xl border transition-colors ${
                provider === p.id
                  ? "bg-accent border-accent text-accent-contrast"
                  : "bg-surface3 border-border text-text hover:text-text hover:border-border-light"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {provider === "openrouter" && (
          <p className="text-[11.5px] text-text-muted">
            OpenRouter lets you use 300+ models with one API key. Vision support depends on the model you choose.
          </p>
        )}
        {provider === "deepseek" && (
          <p className="text-[11.5px] text-warning">
            deepseek-chat / deepseek-v3 are text-only. Use <strong>deepseek-vl</strong> or <strong>deepseek-v4-pro</strong> for image support.
          </p>
        )}
      </div>

      {/* Display name + model slug */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">
            Display Name
          </label>
          <input
            required value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. My GPT-4o"
            className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">
            Model ID / Slug
          </label>
          <input
            required value={modelName}
            onChange={(e) => { setModelName(e.target.value); resetCaps(); }}
            placeholder="e.g. gpt-4.1-mini"
            className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono"
          />
          {/* Quick-fill chips for OpenAI */}
          {provider === "openai" && !isEdit && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {OPENAI_MODEL_SUGGESTIONS.map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  onClick={() => {
                    setModelName(s.slug);
                    setDisplayName(`OpenAI ${s.label}`);
                    resetCaps();
                  }}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                    modelName === s.slug
                      ? "bg-accent border-accent text-accent-contrast"
                      : "bg-surface3 border-border text-text-secondary hover:border-border-light hover:text-text"
                  }`}
                >
                  {s.label}
                  {s.vision && <span className="ml-1 opacity-60 text-[9px]">👁</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Base URL (custom/openrouter) */}
      {(provider === "custom" || provider === "openrouter") && (
        <div>
          <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">
            Base URL {provider === "openrouter" ? "(leave blank for default)" : "(required)"}
          </label>
          <input
            required={provider === "custom"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://localhost:1234/v1"}
            className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono"
          />
        </div>
      )}

      {/* API Key */}
      <div>
        <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">
          API Key
        </label>

        {/* Stored-key status banner (edit mode) */}
        {isEdit && storedKeyState !== "checking" && (
          <div className={`mb-2.5 flex items-center gap-2.5 px-4.5 py-3.5 rounded-xl text-xs font-bold ${
            storedKeyState === "present"
              ? "bg-success/10 border border-success/20 text-success"
              : "bg-warning/10 border border-warning/25 text-warning"
          }`}>
            {storedKeyState === "present" ? (
              <>
                <Check className="w-4 h-4 shrink-0" />
                <span>A saved key exists on this device. Just click <strong>Test &amp; Detect Capabilities</strong> below — no need to re-enter it. Paste a new key only if you want to replace it.</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>No key is saved on this device for this model (it may have synced from the cloud). Paste your API key below to test &amp; use it.</span>
              </>
            )}
          </div>
        )}

        <input
          type="password"
          required={!isEdit}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEdit
            ? (storedKeyState === "present" ? "Leave blank to use saved key, or paste a new key…" : "Paste your API key…")
            : "sk-… or your provider API key"}
          className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono"
        />
      </div>

      {/* Test button + capability checklist */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-2 px-5.5 py-3 bg-surface border border-border hover:border-border-light text-text text-sm font-extrabold rounded-2xl transition-colors disabled:opacity-50 shadow-sm"
        >
          {testing
            ? <><Loader2 className="w-4 h-4 animate-spin text-accent" /> Testing capabilities…</>
            : <><RefreshCw className="w-4 h-4" /> Test &amp; Detect Capabilities</>
          }
        </button>

        {/* Live capability checklist */}
        {hasTested && (
          <div className="premium-card p-5 space-y-3">
            <p className="text-[11px] font-black text-text-secondary uppercase tracking-wider">
              Detected Capabilities
            </p>
            {[
              { key: "text",   label: "Text & Chat",      sub: "Basic reasoning, coding, writing", state: capText },
              { key: "vision", label: "Screen Vision",    sub: "Can see screenshots / images",     state: capVision },
              { key: "audio",  label: "Audio Input",      sub: "Accepts audio clips",              state: capAudio },
              { key: "video",  label: "Video Input",      sub: "Accepts video clips",              state: capVideo },
            ].map((cap) => (
              <div key={cap.key} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CapIcon state={cap.state} />
                  <div>
                    <p className="text-sm font-bold text-text">{cap.label}</p>
                    <p className="text-[11.5px] text-text-muted">{cap.sub}</p>
                  </div>
                </div>
                <CapBadge state={cap.state} />
              </div>
            ))}
          </div>
        )}

        {testError && (
          <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-xs font-bold bg-error-dim/20 border border-error/25 text-error">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{testError}</span>
          </div>
        )}
      </div>

      {/* ── Reasoning badge — auto-detected from model name ── */}
      {isReasoningModel !== null && modelName.trim() && (
        <div className={`flex items-center gap-2.5 px-4.5 py-3 rounded-xl text-xs font-bold border ${
          isReasoningModel
            ? "bg-purple-500/10 border-purple-500/25 text-purple-300"
            : "bg-surface3 border-border text-text-secondary"
        }`}>
          {isReasoningModel
            ? <Brain className="w-4 h-4 shrink-0 text-purple-400" />
            : <Zap className="w-4 h-4 shrink-0 text-text-muted" />
          }
          <span>
            {isReasoningModel
              ? "Reasoning model detected — will be auto-selected for analytical tasks (analyze, solve, compare…)"
              : "Standard model — used for everyday tasks (browse, write, code, automate)"}
          </span>
        </div>
      )}

      {/* ── Task routing mode + active toggle ── */}
      <div className="pt-2 border-t border-border space-y-4">
        <p className="text-[11.5px] font-black text-text-secondary uppercase tracking-wider">Task Routing & Activation</p>

        {/* BOTH mode toggle */}
        <div
          onClick={() => {
            const next = !bothMode;
            setBothMode(next);
            if (next) { setRoleCoding(true); setRoleWriting(true); }
          }}
          className={`flex items-center justify-between p-4.5 rounded-2xl border cursor-pointer transition-all select-none ${
            bothMode
              ? "bg-accent/10 border-accent/30"
              : "bg-surface3 border-border hover:border-border-light"
          }`}
        >
          <div className="flex items-center gap-3">
            <Zap className={`w-5 h-5 shrink-0 ${bothMode ? "text-accent" : "text-text-muted"}`} />
            <div>
              <p className={`text-sm font-bold ${bothMode ? "text-text" : "text-text-secondary"}`}>
                Use for all task types (Both)
              </p>
              <p className="text-xs text-text-muted leading-snug">
                Omni picks this model for any task. Reasoning vs basic is auto-decided per request.
              </p>
            </div>
          </div>
          {bothMode
            ? <ToggleRight className="w-6 h-6 text-accent shrink-0" />
            : <ToggleLeft className="w-6 h-6 text-text-muted shrink-0" />
          }
        </div>

        {/* Manual role checkboxes — only shown when "Both" is OFF */}
        {!bothMode && (
          <div className="flex gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={roleCoding} onChange={(e) => setRoleCoding(e.target.checked)}
                className="w-4.5 h-4.5 accent-white rounded" />
              <span className="text-sm text-text-secondary font-bold">Coding tasks</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={roleWriting} onChange={(e) => setRoleWriting(e.target.checked)}
                className="w-4.5 h-4.5 accent-white rounded" />
              <span className="text-sm text-text-secondary font-bold">Writing tasks</span>
            </label>
          </div>
        )}

        {/* Active / disabled toggle */}
        <div
          onClick={() => setIsActive((v) => !v)}
          className={`flex items-center justify-between p-4.5 rounded-2xl border cursor-pointer transition-all select-none ${
            isActive
              ? "bg-success/8 border-success/20"
              : "bg-surface3 border-border hover:border-border-light"
          }`}
        >
          <div className="flex items-center gap-3">
            <Power className={`w-5 h-5 shrink-0 ${isActive ? "text-success" : "text-text-muted"}`} />
            <div>
              <p className={`text-sm font-bold ${isActive ? "text-text" : "text-text-secondary"}`}>
                {isActive ? "Active — used by agent" : "Inactive — paused"}
              </p>
              <p className="text-xs text-text-muted">
                {isActive
                  ? "Agent will call this model. Toggle off to pause without deleting."
                  : "Model is saved but the agent won't use it until re-enabled."}
              </p>
            </div>
          </div>
          {isActive
            ? <ToggleRight className="w-6 h-6 text-success shrink-0" />
            : <ToggleLeft className="w-6 h-6 text-text-muted shrink-0" />
          }
        </div>
      </div>

      {/* Form actions */}
      <div className="flex justify-between items-center pt-2">
        <button
          type="button" onClick={onCancel}
          className="px-5 py-3 text-sm font-extrabold text-text-secondary hover:text-text border border-border bg-surface3 rounded-xl transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || (!hasTested && !isEdit) || capText === "no"}
          className="px-6 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-sm font-extrabold rounded-xl transition-colors disabled:opacity-40"
          title={(!hasTested && !isEdit) ? "Test the model first" : ""}
        >
          {saving ? <><Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />Saving…</> : (isEdit ? "Save Changes" : "Add Model")}
        </button>
      </div>
    </form>
  );
};

// ── Model Card ────────────────────────────────────────────────────────────────

interface ModelCardProps {
  model: CustomModel;
  onEdit: (m: CustomModel) => void;
  onDelete: (id: string) => void;
  onToggleActive: (m: CustomModel) => void;
}

const ModelCard: React.FC<ModelCardProps> = ({ model, onEdit, onDelete, onToggleActive }) => {
  const [expanded, setExpanded] = useState(false);
  const cap = capabilityLabel(model);
  const [isReasoning, setIsReasoning] = useState<boolean | null>(null);

  React.useEffect(() => {
    invoke<boolean>("detect_model_reasoning", {
      providerType: model.provider_type,
      modelName: model.model_name,
    }).then(setIsReasoning).catch(() => setIsReasoning(null));
  }, [model.provider_type, model.model_name]);

  return (
    <div className={`border rounded-2xl overflow-hidden transition-all ${
      model.is_active
        ? "bg-surface2 border-border-light shadow-sm"
        : "bg-surface border-border opacity-55"
    }`}>
      {/* Main row */}
      <div className="p-5 flex items-center gap-4">
        {/* Vision indicator pill */}
        <div className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-black uppercase ${
          cap.vision
            ? "bg-success/15 border border-success/25 text-success"
            : "bg-surface3 border border-border text-text-muted"
        }`}>
          {cap.vision ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          {cap.label}
        </div>

        {/* Model info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="font-bold text-text text-base">{model.display_name}</span>
            <span className="text-[11px] text-text-secondary font-mono bg-surface3 px-2 py-0.5 rounded-lg border border-border uppercase tracking-wide">
              {model.provider_type}
            </span>
            {/* Reasoning badge */}
            {isReasoning === true && (
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-purple-500/15 text-purple-300 border border-purple-500/25 flex items-center gap-0.5">
                <Brain className="w-3 h-3" /> Reasoning
              </span>
            )}
            {/* Active / Inactive badge */}
            {model.is_active ? (
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-success/15 text-success border border-success/25">
                Active
              </span>
            ) : (
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg bg-surface3 text-text-muted border border-border">
                Paused
              </span>
            )}
          </div>
          <p className="text-sm text-text-muted font-mono truncate mt-1">{model.model_name}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Active toggle button */}
          <button
            onClick={() => onToggleActive(model)}
            title={model.is_active ? "Pause this model" : "Enable this model"}
            className={`p-2 rounded-xl transition-colors ${
              model.is_active
                ? "text-success hover:text-warning bg-surface3 border border-border"
                : "text-text-muted hover:text-success bg-surface3 border border-border"
            }`}
          >
            <Power className="w-4 h-4" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-2 text-text-muted hover:text-text transition-colors rounded-xl bg-surface3 border border-border"
            title="Show capabilities"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button
            onClick={() => onEdit(model)}
            className="p-2 text-text-muted hover:text-accent transition-colors rounded-xl bg-surface3 border border-border"
            title="Edit model"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(model.id)}
            className="p-2 text-text-muted hover:text-error hover:bg-error-dim/20 transition-colors rounded-xl bg-surface3 border border-border"
            title="Delete model"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-5 pb-5 pt-0 border-t border-border space-y-3">
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">{cap.description}</p>

          <div className="flex flex-wrap gap-2 mt-2">
            <span className="text-[10.5px] font-bold bg-surface3 border border-border text-text-muted px-2.5 py-1 rounded-lg uppercase">✓ Text generation</span>
            <span className="text-[10.5px] font-bold bg-surface3 border border-border text-text-muted px-2.5 py-1 rounded-lg uppercase">✓ Code generation</span>
            <span className="text-[10.5px] font-bold bg-surface3 border border-border text-text-muted px-2.5 py-1 rounded-lg uppercase">✓ Task automation</span>
            {cap.vision && (
              <span className="text-[10.5px] font-bold bg-success/10 border border-success/20 text-success px-2.5 py-1 rounded-lg uppercase">✓ Screen vision</span>
            )}
            {isReasoning === true && (
              <span className="text-[10.5px] font-bold bg-purple-500/10 border border-purple-500/20 text-purple-300 px-2.5 py-1 rounded-lg uppercase flex items-center gap-0.5">
                <Brain className="w-3 h-3" /> Auto-reasoning
              </span>
            )}
            {model.role_coding && !model.role_writing && (
              <span className="text-[10.5px] font-bold bg-accent/10 border border-accent/20 text-accent px-2.5 py-1 rounded-lg uppercase">Coding role</span>
            )}
            {model.role_writing && !model.role_coding && (
              <span className="text-[10.5px] font-bold bg-accent/10 border border-accent/20 text-accent px-2.5 py-1 rounded-lg uppercase">Writing role</span>
            )}
            {model.role_coding && model.role_writing && (
              <span className="text-[10.5px] font-bold bg-accent/10 border border-accent/20 text-accent px-2.5 py-1 rounded-lg uppercase">All tasks</span>
            )}
          </div>

          {/* Non-vision note */}
          {!cap.vision && (
            <div className="flex items-start gap-2 mt-2">
              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-warning leading-relaxed">
                No screen vision. Omni uses OCR + accessibility tree instead. For full visual control, add GPT-4o, Claude 3, or Gemini.
              </p>
            </div>
          )}

          {model.base_url && (
            <p className="text-[11.5px] text-text-muted font-mono mt-1">Endpoint: {model.base_url}</p>
          )}

          {/* Inactive explanation */}
          {!model.is_active && (
            <div className="flex items-center gap-2 mt-1.5 px-3 py-2.5 rounded-xl bg-surface3 border border-border">
              <Power className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <p className="text-[11.5px] text-text-muted">Model is paused — agent won't use it. Click the power icon above to re-enable.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Main Settings Page ────────────────────────────────────────────────────────

export const Settings: React.FC = () => {
  const { models, addCustomModel, updateCustomModel, deleteCustomModel, testModel, theme, setTheme } = useStore();
  const [showForm, setShowForm] = useState(false);
  const [editModel, setEditModel] = useState<CustomModel | undefined>();

  // System keys
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  // Offline voice (Whisper) state
  const [sttStatus, setSttStatus] = useState<{ engine: string; local_whisper_available: boolean; elevenlabs_configured: boolean } | null>(null);
  const [whisperDownloading, setWhisperDownloading] = useState(false);
  const [whisperProgress, setWhisperProgress] = useState<{ stage: string; pct: number } | null>(null);
  const [whisperMsg, setWhisperMsg] = useState<string | null>(null);
  // Natural voice (Piper) state
  const [piperInstalled, setPiperInstalled] = useState(false);
  const [piperDownloading, setPiperDownloading] = useState(false);
  const [piperProgress, setPiperProgress] = useState<{ stage: string; pct: number } | null>(null);
  const [piperMsg, setPiperMsg] = useState<string | null>(null);
  // Mic test
  const [voiceTesting, setVoiceTesting] = useState(false);
  const [voiceTestResult, setVoiceTestResult] = useState<{ ok: boolean; text: string; error?: string } | null>(null);
  const [mem0Key, setMem0Key]   = useState("");
  const [mem0Type, setMem0Type] = useState<"cloud" | "self-hosted">("cloud");
  const [mem0Url, setMem0Url]   = useState("https://api.mem0.ai");

  // Hotkeys
  const [micHotkey, setMicHotkey]   = useState("Ctrl+Shift+A");
  const [textHotkey, setTextHotkey] = useState("Ctrl+Shift+T");
  const [recordingHotkey, setRecordingHotkey] = useState<"mic" | "text" | null>(null);
  const [pressedKeys, setPressedKeys] = useState<string[]>([]);
  const [hotkeyMsg, setHotkeyMsg]   = useState<{ text: string; success: boolean } | null>(null);

  // Active Project Workspace
  const [activeProjectDir, setActiveProjectDir] = useState("");
  const [defaultProjectDir, setDefaultProjectDir] = useState("");
  const [projectDirMsg, setProjectDirMsg] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const elKey = await invoke<string | null>("get_api_key", { name: "elevenlabs" });
        const mKey  = await invoke<string | null>("get_api_key", { name: "mem0" });
        if (elKey) setElevenLabsKey(elKey);
        if (mKey)  setMem0Key(mKey);
        const mType = await invoke<string | null>("get_setting", { key: "mem0_type" });
        const mUrl  = await invoke<string | null>("get_setting", { key: "mem0_url" });
        if (mType) setMem0Type(mType as "cloud" | "self-hosted");
        if (mUrl)  setMem0Url(mUrl);
        const hotkeys = await invoke<{ mic: string; text: string }>("get_hotkeys");
        if (hotkeys.mic)  setMicHotkey(hotkeys.mic);
        if (hotkeys.text) setTextHotkey(hotkeys.text);

        const projDir = await invoke<string | null>("get_setting", { key: "active_project_dir" });
        if (projDir) setActiveProjectDir(projDir);
        const defDir = await invoke<string>("get_current_working_dir");
        if (defDir) setDefaultProjectDir(defDir);
      } catch (e) { console.error(e); }
    })();

    let active = true;
    let unsub: (() => void) | null = null;

    listen<{ type: string; value: string }>("hotkey:updated", (event) => {
      const { type, value } = event.payload;
      if (type === "mic")  setMicHotkey(value);
      if (type === "text") setTextHotkey(value);
    }).then((fn) => {
      if (active) {
        unsub = fn;
      } else {
        fn();
      }
    });

    return () => {
      active = false;
      if (unsub) unsub();
    };
  }, []);

  const handleSaveElevenLabs = async () => {
    const key = elevenLabsKey.trim();
    if (!key || key.includes("•")) { alert("Enter a valid ElevenLabs API key."); return; }
    try {
      // Test the key before saving (GET /v1/user with the key).
      const ok = await invoke<boolean>("test_elevenlabs_key", { apiKey: key }).catch(() => false);
      if (!ok) { alert("That ElevenLabs key didn't work. Double-check it and try again."); return; }
      await invoke("save_api_key", { name: "elevenlabs", value: key });
      await invoke("save_setting", { key: "tts_engine", value: "cloud" });
      alert("ElevenLabs key verified and saved.");
      refreshSttStatus();
    } catch (e: any) { alert("Failed: " + e); }
  };

  // ── Offline voice (Whisper) ────────────────────────────────────────────────
  const refreshSttStatus = async () => {
    try { setSttStatus(await invoke("get_stt_status")); } catch { /* ignore */ }
  };

  useEffect(() => {
    refreshSttStatus();
    let un: (() => void) | null = null;
    listen<{ stage: string; pct: number }>("whisper:download", (e) => {
      setWhisperProgress(e.payload);
      if (e.payload.stage === "done" || e.payload.stage === "error") {
        setWhisperDownloading(false);
        refreshSttStatus();
      }
    }).then((fn) => { un = fn; });
    return () => { if (un) un(); };
  }, []);

  const handleDownloadWhisper = async () => {
    setWhisperDownloading(true);
    setWhisperMsg(null);
    setWhisperProgress({ stage: "starting", pct: 0 });
    try {
      const msg = await invoke<string>("download_whisper");
      setWhisperMsg(msg);
      await refreshSttStatus();
    } catch (e: any) {
      setWhisperMsg(typeof e === "string" ? e : (e?.message || "Download failed."));
    } finally {
      setWhisperDownloading(false);
    }
  };

  // ── Natural voice (Piper) — local neural TTS, human-like, offline ──────────
  const refreshPiperStatus = async () => {
    try { setPiperInstalled(await invoke<boolean>("piper_installed")); } catch { /* ignore */ }
  };

  useEffect(() => {
    refreshPiperStatus();
    let un: (() => void) | null = null;
    listen<{ stage: string; pct: number }>("piper:download", (e) => {
      setPiperProgress(e.payload);
      if (e.payload.stage === "done" || e.payload.stage === "error") {
        setPiperDownloading(false);
        refreshPiperStatus();
      }
    }).then((fn) => { un = fn; });
    return () => { if (un) un(); };
  }, []);

  const handleDownloadPiper = async () => {
    setPiperDownloading(true);
    setPiperMsg(null);
    setPiperProgress({ stage: "starting", pct: 0 });
    try {
      const msg = await invoke<string>("download_piper");
      setPiperMsg(msg);
      await refreshPiperStatus();
    } catch (e: any) {
      setPiperMsg(typeof e === "string" ? e : (e?.message || "Download failed."));
    } finally {
      setPiperDownloading(false);
    }
  };

  // Mic + transcription test — records, transcribes, shows the text.
  useEffect(() => {
    let un: (() => void) | null = null;
    listen<{ ok: boolean; text: string; error?: string }>("voice:test_result", (e) => {
      setVoiceTestResult(e.payload);
      setVoiceTesting(false);
    }).then((fn) => { un = fn; });
    return () => { if (un) un(); };
  }, []);

  const handleTestVoice = async () => {
    setVoiceTestResult(null);
    setVoiceTesting(true);
    try {
      await invoke("start_voice_test");
    } catch (e: any) {
      setVoiceTesting(false);
      setVoiceTestResult({ ok: false, text: "", error: typeof e === "string" ? e : "Could not start microphone." });
    }
    // Safety timeout in case no result comes back.
    setTimeout(() => setVoiceTesting(false), 35000);
  };

  const handleSaveMem0 = async () => {
    try {
      if (!mem0Key.includes("•")) await invoke("save_api_key", { name: "mem0", value: mem0Key });
      await invoke("save_setting", { key: "mem0_type", value: mem0Type });
      await invoke("save_setting", { key: "mem0_url",  value: mem0Url });
      alert("Mem0 config saved.");
    } catch (e: any) { alert("Failed: " + e); }
  };

  const handleSaveProjectDir = async () => {
    const dir = activeProjectDir.trim();
    try {
      await invoke("save_setting", { key: "active_project_dir", value: dir });
      setProjectDirMsg({ text: dir ? `✓ Active project workspace path saved: ${dir}` : "✓ Settings cleared. Omni will now default to current workspace root.", success: true });
    } catch (e: any) {
      setProjectDirMsg({ text: `Failed to save setting: ${e?.toString() || e}`, success: false });
    }
  };

  const handleResetProjectDir = async () => {
    try {
      await invoke("save_setting", { key: "active_project_dir", value: "" });
      setActiveProjectDir("");
      setProjectDirMsg({ text: "✓ Reset to current workspace root.", success: true });
    } catch (e: any) {
      setProjectDirMsg({ text: `Failed to reset setting: ${e?.toString() || e}`, success: false });
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this model and remove its API key?")) {
      try { await deleteCustomModel(id); } catch (e) { console.error(e); }
    }
  };

  // Toggle a model's active state without opening the full edit form.
  const handleToggleActive = async (model: CustomModel) => {
    try {
      await updateCustomModel(model.id, { ...model, is_active: !model.is_active });
    } catch (e) { console.error("Failed to toggle model active state:", e); }
  };

  const openAddForm = () => { setEditModel(undefined); setShowForm(true); };
  const openEditForm = (m: CustomModel) => { setEditModel(m); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setEditModel(undefined); };

  // Hotkey recording
  const startRecording = (type: "mic" | "text") => {
    setRecordingHotkey(type);
    setPressedKeys([]);
    setHotkeyMsg(null);
  };

  // Global event listener to record key combination when active
  useEffect(() => {
    if (!recordingHotkey) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      // Always collect modifiers first (canonical order: Ctrl, Shift, Alt, Win)
      if (e.ctrlKey)  parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey)   parts.push("Alt");
      if (e.metaKey)  parts.push("Win");

      // Only add the non-modifier key — never add modifier key names as the "key"
      const modifierKeys = ["Control", "Shift", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"];
      if (!modifierKeys.includes(e.key)) {
        // Normalize special key names to what the Rust parser expects
        const keyMap: Record<string, string> = {
          " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down",
          "ArrowLeft": "Left", "ArrowRight": "Right",
          "Enter": "Enter", "Backspace": "Backspace", "Delete": "Delete",
          "Escape": "Escape", "Tab": "Tab", "Home": "Home", "End": "End",
          "PageUp": "PageUp", "PageDown": "PageDown", "Insert": "Insert",
        };
        const normalizedKey = keyMap[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        parts.push(normalizedKey);
      }
      if (parts.length > 0) setPressedKeys(parts);
    };

    const handleGlobalKeyUp = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // If user presses Escape alone, cancel recording
      if (pressedKeys.length === 1 && pressedKeys[0] === "Escape") {
        setRecordingHotkey(null);
        setPressedKeys([]);
        setHotkeyMsg({ text: "Recording cancelled", success: false });
        return;
      }

      // Need at least one modifier AND one non-modifier key
      const modifiers = ["Ctrl", "Shift", "Alt", "Win"];
      const nonModifiers = pressedKeys.filter(k => !modifiers.includes(k));
      const hasMod = pressedKeys.some(k => modifiers.includes(k));

      if (!hasMod || nonModifiers.length === 0) {
        setHotkeyMsg({ text: "Need a modifier (Ctrl / Shift / Alt) + a key. Win key alone is not supported.", success: false });
        setRecordingHotkey(null);
        setPressedKeys([]);
        return;
      }

      // Build canonical hotkey string: modifiers first, then the key
      const orderedMods = ["Ctrl", "Shift", "Alt", "Win"].filter(m => pressedKeys.includes(m));
      const hotkeyStr = [...orderedMods, ...nonModifiers].join("+");
      const type = recordingHotkey;
      setRecordingHotkey(null);
      setPressedKeys([]);

      try {
        await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: hotkeyStr });
        if (type === "mic") setMicHotkey(hotkeyStr);
        else setTextHotkey(hotkeyStr);
        setHotkeyMsg({ text: `✓ ${type === "mic" ? "Voice" : "Text"} hotkey set to: ${hotkeyStr}`, success: true });
      } catch (e: any) {
        const msg = e?.toString() || "Failed.";
        setHotkeyMsg({ text: `Failed: ${msg}. Try a different combination (e.g. Ctrl+Shift+A).`, success: false });
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    window.addEventListener("keyup", handleGlobalKeyUp, true);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
      window.removeEventListener("keyup", handleGlobalKeyUp, true);
    };
  }, [recordingHotkey, pressedKeys]);

  const resetHotkey = async (type: "mic" | "text") => {
    const def = type === "mic" ? "Ctrl+Shift+A" : "Ctrl+Shift+T";
    try {
      await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: def });
      if (type === "mic") setMicHotkey(def); else setTextHotkey(def);
      setHotkeyMsg({ text: `Reset to ${def}`, success: true });
    } catch (e: any) { setHotkeyMsg({ text: e?.toString() || "Failed.", success: false }); }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-4xl font-black text-text tracking-tight">Settings</h1>
        <p className="text-text-secondary text-[15.5px]">Configure AI models, API keys, hotkeys, and system options.</p>
      </div>

      {/* ── Model Registry ─────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-2xl p-6.5 space-y-5 shadow-lg premium-card">
        <div className="flex justify-between items-start gap-4">
          <div>
            <h3 className="font-bold text-text text-lg">AI Models</h3>
            <p className="text-[13.5px] text-text-secondary mt-1 leading-relaxed">
              Add models with their API keys. Capabilities are detected by testing the real API.
              Toggle <strong>Both</strong> to handle all tasks, or assign specific roles.
              The agent auto-routes to a reasoning model for analytical tasks.
            </p>
          </div>
          {!showForm && (
            <button
              onClick={openAddForm}
              className="px-4.5 py-2.5 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl flex items-center gap-1.5 transition-colors shrink-0 accent-glow"
            >
              <Plus className="w-4.5 h-4.5" /> Add Model
            </button>
          )}
        </div>

        {showForm && (
          <ModelForm
            editModel={editModel}
            onSave={closeForm}
            onCancel={closeForm}
            addCustomModel={addCustomModel}
            updateCustomModel={updateCustomModel!}
            testModelFn={testModel}
          />
        )}

        <div className="space-y-3">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} onEdit={openEditForm} onDelete={handleDelete} onToggleActive={handleToggleActive} />
          ))}
          {models.length === 0 && !showForm && (
            <div className="text-center py-14 border border-dashed border-border rounded-2xl space-y-3">
              <p className="text-base font-bold text-text-secondary">No models yet</p>
              <p className="text-sm text-text-muted">Add a model to start using Omni automation.</p>
              <button
                onClick={openAddForm}
                className="mt-2 px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl inline-flex items-center gap-1.5 accent-glow"
              >
                <Plus className="w-4 h-4" /> Add Your First Model
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Global Hotkeys ──────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-2xl p-6.5 space-y-5 shadow-lg premium-card">
        <div className="flex items-center gap-3">
          <Keyboard className="w-5 h-5 text-accent" />
          <div>
            <h3 className="font-bold text-text text-lg">Global Hotkeys</h3>
            <p className="text-[13.5px] text-text-secondary mt-0.5">These work system-wide even when Omni's window is hidden.</p>
          </div>
        </div>

        {hotkeyMsg && (
          <div className={`px-4 py-3 rounded-xl text-xs font-bold ${
            hotkeyMsg.success ? "bg-success/10 border border-success/20 text-success" : "bg-error-dim/20 border border-error/30 text-error"
          }`}>
            {hotkeyMsg.text}
          </div>
        )}

        {[
          { type: "mic" as const, label: "Voice Activation", desc: "Hold to speak, release to execute", value: micHotkey },
          { type: "text" as const, label: "Quick Command (text)", desc: "Opens floating text input window", value: textHotkey },
        ].map((hk) => (
          <div key={hk.type} className="p-5 bg-surface2 border border-border rounded-2xl flex items-center justify-between gap-4">
            <div>
              <p className="text-base font-bold text-text">{hk.label}</p>
              <p className="text-sm text-text-secondary mt-0.5">{hk.desc}</p>
            </div>
            <div className="flex items-center gap-3.5 shrink-0">
              <div className={`px-4 py-2.5 rounded-xl border font-mono text-sm font-black min-w-[150px] text-center transition-all ${
                recordingHotkey === hk.type
                  ? "border-accent bg-accent/10 text-accent animate-pulse"
                  : "border-border bg-surface3 text-text"
              }`}>
                {recordingHotkey === hk.type
                  ? (pressedKeys.length ? pressedKeys.join("+") : "Press combo…")
                  : hk.value}
              </div>
              <button
                onClick={() => startRecording(hk.type)}
                className={`px-4.5 py-2.5 text-xs font-black rounded-xl border transition-colors ${
                  recordingHotkey === hk.type
                    ? "bg-error/20 border-error/30 text-error"
                    : "bg-accent hover:bg-accent-hover border-accent text-accent-contrast"
                }`}
              >
                {recordingHotkey === hk.type ? "Cancel" : "Record"}
              </button>
              <button
                onClick={() => resetHotkey(hk.type)}
                title="Reset to default"
                className="p-2.5 text-text-muted hover:text-text border border-border bg-surface3 rounded-xl transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        <div className="p-5 bg-surface2 border border-border rounded-2xl flex items-center justify-between opacity-55">
          <div>
            <p className="text-base font-bold text-text">Emergency Kill Switch</p>
            <p className="text-sm text-text-secondary mt-0.5">Stops everything immediately. Not configurable by design.</p>
          </div>
          <div className="px-4 py-2.5 border border-border bg-surface3 font-mono text-xs font-black text-text-muted rounded-xl">
            Esc × 2
          </div>
        </div>
      </div>

      {/* ── Active Project Workspace ────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-2xl p-6.5 space-y-5 shadow-lg premium-card">
        <div className="flex items-center gap-3">
          <Folder className="w-5 h-5 text-accent" />
          <div>
            <h3 className="font-bold text-text text-lg">Active Project Workspace</h3>
            <p className="text-[13.5px] text-text-secondary mt-0.5">
              The project directory Omni is permanently bound to. All file system modifications and commands run here.
            </p>
          </div>
        </div>

        {projectDirMsg && (
          <div className={`px-4 py-3 rounded-xl text-xs font-bold ${
            projectDirMsg.success ? "bg-success/10 border border-success/20 text-success" : "bg-error-dim/20 border border-error/30 text-error"
          }`}>
            {projectDirMsg.text}
          </div>
        )}

        <div className="p-5 bg-surface2 border border-border rounded-2xl space-y-4">
          <div>
            <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">Project Directory Path</label>
            <div className="flex gap-4">
              <input
                type="text"
                value={activeProjectDir}
                onChange={(e) => setActiveProjectDir(e.target.value)}
                placeholder="e.g. D:\Projects\my-awesome-app"
                className="flex-1 px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono"
              />
              <button
                onClick={handleSaveProjectDir}
                className="px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl transition-colors shrink-0 accent-glow font-sans"
              >
                Save Path
              </button>
            </div>
            <p className="text-xs text-text-muted mt-2.5">
              Enter an absolute directory path. If left blank, Omni will default to the current workspace root: <span className="font-mono text-text">{defaultProjectDir || "loading..."}</span>
            </p>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleResetProjectDir}
              className="px-4 py-2.5 bg-surface3 border border-border hover:border-border-light text-text text-xs font-bold rounded-xl transition-colors flex items-center gap-1.5 font-sans"
            >
              Reset to Workspace Default
            </button>
          </div>
        </div>
      </div>

      {/* ── System Integrations ──────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-2xl p-6.5 space-y-5 shadow-lg premium-card">
        <div className="flex items-center gap-3">
          <Key className="w-5 h-5 text-accent" />
          <div>
            <h3 className="font-bold text-text text-lg">System Integrations</h3>
            <p className="text-[13.5px] text-text-secondary mt-0.5">Voice (STT/TTS) and memory keys.</p>
          </div>
        </div>

        {/* ── Offline Voice (Whisper) — open-source, local, recommended ── */}
        <div className="p-5 bg-surface2 border border-border rounded-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-base font-bold text-text flex items-center gap-2">
                Offline Voice — Whisper
                {sttStatus?.engine === "local_whisper" && (
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-success/15 text-success border border-success/25">Active</span>
                )}
              </h4>
              <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                Open-source speech-to-text that runs 100% on your PC — fast, private, no API key.
                Recommended. One-time download (~150&nbsp;MB).
              </p>
            </div>
          </div>

          {/* Current engine indicator */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-text-muted">Current STT engine:</span>
            <span className="font-bold text-text">
              {sttStatus?.engine === "local_whisper" ? "Local Whisper (offline)"
                : sttStatus?.engine === "elevenlabs" ? "ElevenLabs (cloud)"
                : "Windows SAPI (basic fallback)"}
            </span>
          </div>

          {whisperDownloading || whisperProgress ? (
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-surface3 overflow-hidden">
                <div className="h-full bg-accent transition-all duration-200"
                     style={{ width: `${whisperProgress?.pct ?? 0}%` }} />
              </div>
              <p className="text-[11px] text-text-muted">
                {whisperProgress?.stage === "model" ? "Downloading speech model…"
                  : whisperProgress?.stage === "engine" ? "Downloading engine…"
                  : whisperProgress?.stage === "done" ? "Done!"
                  : whisperProgress?.stage === "error" ? "Failed — check connection."
                  : "Starting…"} {whisperProgress?.pct ? `${whisperProgress.pct}%` : ""}
              </p>
            </div>
          ) : sttStatus?.local_whisper_available ? (
            <p className="text-sm text-success font-bold">✓ Offline Whisper is installed and active.</p>
          ) : (
            <button
              onClick={handleDownloadWhisper}
              className="px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl transition-colors accent-glow"
            >
              Download offline voice (~150 MB)
            </button>
          )}
          {whisperMsg && <p className="text-[11px] text-text-muted">{whisperMsg}</p>}

          {/* Test microphone + transcription (any active engine) */}
          <div className="pt-4 border-t border-border space-y-3">
            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                onClick={handleTestVoice}
                disabled={voiceTesting}
                className="px-4 py-2.5 bg-surface3 border border-border hover:border-border-light text-text text-xs font-bold rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {voiceTesting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-accent" /> Listening… speak now</>
                  : <><RefreshCw className="w-3.5 h-3.5" /> Test microphone</>}
              </button>
              <span className="text-[11px] text-text-muted">Records a few seconds, then shows what was heard.</span>
            </div>
            {voiceTestResult && (
              voiceTestResult.ok ? (
                <div className="px-4 py-3 rounded-xl bg-success/10 border border-success/25 text-xs">
                  <span className="text-success font-black">✓ Heard: </span>
                  <span className="text-text">"{voiceTestResult.text}"</span>
                </div>
              ) : (
                <div className="px-4 py-3 rounded-xl bg-error-dim/20 border border-error/25 text-xs text-error font-bold">
                  {voiceTestResult.error || "Couldn't transcribe. Try the offline Whisper download above."}
                </div>
              )
            )}
          </div>
        </div>

        {/* ── Natural Voice (Piper) — local neural TTS, human-like, offline ── */}
        <div className="p-5 bg-surface2 border border-border rounded-2xl space-y-4">
          <div>
            <h4 className="text-base font-bold text-text flex items-center gap-2">
              Natural Voice — Piper
              {piperInstalled && (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-success/15 text-success border border-success/25">Active</span>
              )}
            </h4>
            <p className="text-sm text-text-secondary mt-1 leading-relaxed">
              Open-source neural text-to-speech that runs 100% on your PC — sounds far more
              human than the basic Windows voice. No API key. One-time download (~65&nbsp;MB).
            </p>
          </div>

          {piperDownloading || (piperProgress && piperProgress.stage !== "done") ? (
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-surface3 overflow-hidden">
                <div className="h-full bg-accent transition-all duration-200"
                     style={{ width: `${piperProgress?.pct ?? 0}%` }} />
              </div>
              <p className="text-[11px] text-text-muted">
                {piperProgress?.stage === "engine" ? "Downloading voice engine…"
                  : piperProgress?.stage === "voice" ? "Downloading natural voice…"
                  : piperProgress?.stage === "error" ? "Failed — check connection."
                  : "Starting…"} {piperProgress?.pct ? `${piperProgress.pct}%` : ""}
              </p>
            </div>
          ) : piperInstalled ? (
            <p className="text-sm text-success font-bold">✓ Natural voice is installed. The agent now speaks with it automatically.</p>
          ) : (
            <button
              onClick={handleDownloadPiper}
              className="px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl transition-colors accent-glow"
            >
              Download natural voice (~65 MB)
            </button>
          )}
          {piperMsg && <p className="text-[11px] text-text-muted">{piperMsg}</p>}
        </div>

        {/* ElevenLabs */}
        <div className="p-5 bg-surface2 border border-border rounded-2xl space-y-4">
          <div>
            <h4 className="text-base font-bold text-text">ElevenLabs Voice (optional, cloud)</h4>
            <p className="text-sm text-text-secondary mt-1 leading-relaxed">Optional cloud speech-to-text + natural voice output. The key is tested before saving. Local Whisper above is recommended (offline, free).</p>
          </div>
          <div className="flex gap-4">
            <input
              type="password" value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
              placeholder="ElevenLabs API key"
              className="flex-1 px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono"
            />
            <button onClick={handleSaveElevenLabs}
              className="px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl transition-colors shrink-0 accent-glow">
              Test &amp; Save
            </button>
          </div>
        </div>

        {/* Mem0 */}
        <div className="p-5 bg-surface2 border border-border rounded-2xl space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-base font-bold text-text">Mem0 Memory</h4>
              <p className="text-sm text-text-secondary mt-1 leading-relaxed">Persistent user facts that improve every task. Optional.</p>
            </div>
            <div className="flex gap-2">
              {["cloud", "self-hosted"].map((t) => (
                <button key={t} type="button"
                  onClick={() => { setMem0Type(t as any); if (t === "cloud") setMem0Url("https://api.mem0.ai"); else if (mem0Url === "https://api.mem0.ai") setMem0Url("http://localhost:8000"); }}
                  className={`px-3.5 py-2 text-xs font-black uppercase rounded-xl border transition-colors ${
                    mem0Type === t ? "bg-accent border-accent text-accent-contrast" : "bg-surface3 border-border text-text hover:text-text"
                  }`}>
                  {t === "cloud" ? "Cloud" : "Self-hosted"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">API Key</label>
              <input type="password" value={mem0Key} onChange={(e) => setMem0Key(e.target.value)}
                placeholder={mem0Type === "cloud" ? "Required for cloud" : "Optional"}
                className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono" />
            </div>
            <div>
              <label className="block text-[11.5px] font-black text-text-secondary uppercase tracking-wider mb-1.5">Base URL</label>
              <input type="text" value={mem0Url} disabled={mem0Type === "cloud"} onChange={(e) => setMem0Url(e.target.value)}
                placeholder="http://localhost:8000"
                className="w-full px-4 py-3 bg-surface3 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-accent font-mono disabled:opacity-50" />
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={handleSaveMem0}
              className="px-5 py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-black rounded-xl transition-colors accent-glow">
              Save Mem0 Config
            </button>
          </div>
        </div>
      </div>

      {/* ── Appearance ─────────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-2xl p-6.5 shadow-lg premium-card">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold text-text text-lg">Appearance</h3>
            <p className="text-[13.5px] text-text-secondary mt-0.5">Dark and light theme support.</p>
          </div>
          
          {/* Animated segmented sliding theme control */}
          <div className="flex bg-surface3 border border-border p-1 rounded-2xl w-48 relative select-none">
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-black rounded-xl relative z-10 transition-colors ${
                theme === "light" ? "text-accent-contrast" : "text-text-secondary hover:text-text"
              }`}
            >
              {theme === "light" && (
                <motion.div
                  layoutId="activeThemeBg"
                  className="absolute inset-0 bg-accent rounded-xl -z-10 shadow-sm"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Sun className="w-4 h-4" />
              <span>Light</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-black rounded-xl relative z-10 transition-colors ${
                theme === "dark" ? "text-accent-contrast" : "text-text-secondary hover:text-text"
              }`}
            >
              {theme === "dark" && (
                <motion.div
                  layoutId="activeThemeBg"
                  className="absolute inset-0 bg-accent rounded-xl -z-10 shadow-sm"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <Moon className="w-4 h-4" />
              <span>Dark</span>
            </button>
          </div>
        </div>
      </div>

      {/* Global recording hotkey overlay modal */}
      <AnimatePresence>
        {recordingHotkey && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-surface border border-border-light max-w-md w-full rounded-[32px] p-8 shadow-2xl text-center space-y-6"
            >
              <div className="flex justify-center">
                <div className="w-16 h-16 rounded-[22px] bg-accent-dim border border-border flex items-center justify-center shrink-0 text-accent relative shadow-md">
                  <Keyboard className="w-7 h-7" />
                  <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-error animate-ping" />
                  <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-error" />
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xl font-black text-text tracking-tight animate-pulse">
                  Recording Shortcut...
                </h3>
                <p className="text-sm text-text-secondary">
                  Press shortcut combination for <span className="font-extrabold text-accent">{recordingHotkey === "mic" ? "Voice Activation" : "Quick Command"}</span>.
                </p>
              </div>

              {/* Recorded Keycaps display */}
              <div className="min-h-[70px] flex items-center justify-center gap-2">
                {pressedKeys.length > 0 ? (
                  pressedKeys.map((k, idx) => (
                    <React.Fragment key={k}>
                      {idx > 0 && <span className="text-text-muted font-bold">+</span>}
                      <kbd className="px-4 py-2.5 rounded-xl border border-border-light bg-surface2 font-mono text-sm font-black text-text shadow-sm min-w-[50px] inline-block">
                        {k}
                      </kbd>
                    </React.Fragment>
                  ))
                ) : (
                  <span className="text-text-muted font-bold text-sm tracking-wide animate-pulse">
                    Press combination (e.g. Ctrl+Shift+A)...
                  </span>
                )}
              </div>

              <p className="text-xs text-text-muted leading-relaxed">
                Press any modifier (Ctrl, Shift, Alt) plus a key.<br />
                Release keys to save. Press <kbd className="px-1.5 py-0.5 rounded bg-surface3 border border-border text-[10px]">Esc</kbd> to cancel.
              </p>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setRecordingHotkey(null);
                    setPressedKeys([]);
                  }}
                  className="px-6 py-3 border border-border bg-surface3 text-text-secondary hover:text-text text-sm font-extrabold rounded-xl transition-colors w-full"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
};
