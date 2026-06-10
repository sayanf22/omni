import React, { useState, useEffect } from "react";
import { useStore, CustomModel } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus, Trash2, Loader2, XCircle, Key, Keyboard,
  AlertTriangle, RefreshCw, Eye, EyeOff, Pencil, ChevronDown, ChevronUp
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

const PROVIDER_DEFAULTS: Record<string, { displayName: string; modelName: string; baseUrl: string; visionExpected: boolean }> = {
  openai:     { displayName: "OpenAI GPT-4o mini",    modelName: "gpt-4o-mini",              baseUrl: "", visionExpected: true  },
  anthropic:  { displayName: "Anthropic Claude",       modelName: "claude-3-5-sonnet-latest", baseUrl: "", visionExpected: true  },
  deepseek:   { displayName: "DeepSeek Chat",          modelName: "deepseek-chat",            baseUrl: "", visionExpected: false },
  openrouter: { displayName: "OpenRouter Gemini Flash", modelName: "google/gemini-2.5-flash", baseUrl: "", visionExpected: true  },
  custom:     { displayName: "Custom Model",           modelName: "my-model",                 baseUrl: "http://localhost:1234/v1", visionExpected: false },
};

const ModelForm: React.FC<ModelFormProps> = ({
  editModel, onSave, onCancel, addCustomModel, updateCustomModel, testModelFn
}) => {
  const isEdit = !!editModel;
  const [provider, setProvider]   = useState(editModel?.provider_type || "openai");
  const [displayName, setDisplayName] = useState(editModel?.display_name || "OpenAI GPT-4o mini");
  const [modelName, setModelName] = useState(editModel?.model_name || "gpt-4o-mini");
  const [baseUrl, setBaseUrl]     = useState(editModel?.base_url || "");
  const [apiKey, setApiKey]       = useState(isEdit ? "••••••••••••••••" : "");
  const [isActive, setIsActive]   = useState(editModel?.is_active ?? true);
  const [roleCoding, setRoleCoding]   = useState(editModel?.role_coding ?? false);
  const [roleWriting, setRoleWriting] = useState(editModel?.role_writing ?? false);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testPassed, setTestPassed] = useState<boolean | null>(isEdit ? true : null);
  const [testMsg, setTestMsg] = useState(isEdit ? "Previously tested ✓" : "");
  const [probingVision, setProbingVision] = useState(false);
  const [visionResult, setVisionResult]   = useState<boolean | null>(isEdit ? editModel.role_vision : null);

  const [saving, setSaving] = useState(false);

  const handleProviderChange = (p: string) => {
    setProvider(p);
    setTestPassed(null);
    setTestMsg("");
    setVisionResult(null);
    const d = PROVIDER_DEFAULTS[p];
    if (d && !isEdit) {
      setDisplayName(d.displayName);
      setModelName(d.modelName);
      setBaseUrl(d.baseUrl);
    }
  };

  const handleTest = async () => {
    // Resolve the actual key to test with:
    // - If the user typed a new key (not masked), use it.
    // - If editing and key is still masked, fetch the real key from the keychain.
    let keyToUse = apiKey.includes("•") ? "" : apiKey;

    if (!keyToUse && isEdit && editModel) {
      try {
        const storedKey = await invoke<string | null>("get_api_key", { name: editModel.id });
        if (storedKey) keyToUse = storedKey;
      } catch (e) {
        console.warn("Could not load stored key:", e);
      }
    }

    if (!keyToUse) {
      setTestMsg(isEdit
        ? "Could not load saved key — please re-enter your API key."
        : "Enter your API key first.");
      setTestPassed(false);
      return;
    }

    setTesting(true);
    setTestPassed(null);
    setTestMsg("Connecting to API…");
    setVisionResult(null);

    try {
      const result = await testModelFn(provider, modelName, baseUrl || null, keyToUse);
      setTestPassed(true);
      setTestMsg(`Connected ✓ — "${result}"`);

      // Probe vision with the same resolved key
      setProbingVision(true);
      setTestMsg("Testing image support…");
      try {
        const hasVision = await invoke<boolean>("probe_model_vision", {
          providerType: provider,
          modelName,
          baseUrl: baseUrl || null,
          apiKey: keyToUse,
        });
        setVisionResult(hasVision);
        setTestMsg(hasVision
          ? "✓ Text, Code + Screen Vision confirmed"
          : "✓ Text & Code confirmed — no image/vision support");
      } catch {
        setVisionResult(null);
        setTestMsg("Connected ✓ (vision probe skipped)");
      } finally {
        setProbingVision(false);
      }
    } catch (e: any) {
      setTestPassed(false);
      setTestMsg(typeof e === "string" ? e : e?.message || "Connection failed");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPassed && !isEdit) {
      setTestMsg("Test connection first before saving.");
      return;
    }

    setSaving(true);
    const keyToSave = apiKey.includes("•") ? undefined : apiKey;
    const finalVision = visionResult !== null ? visionResult : (editModel?.role_vision ?? false);

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
      setTestMsg(`Save failed: ${err?.message || err}`);
      setTestPassed(false);
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
      className="p-5 bg-surface2 border border-border rounded-xl space-y-4"
    >
      <h4 className="font-bold text-text text-sm">
        {isEdit ? `Edit: ${editModel?.display_name}` : "Add New Model"}
      </h4>

      {/* Provider selector */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-text-secondary uppercase tracking-wider">Provider</label>
        <div className="flex flex-wrap gap-2">
          {providers.map((p) => (
            <button
              key={p.id} type="button"
              onClick={() => handleProviderChange(p.id)}
              title={p.hint}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                provider === p.id
                  ? "bg-accent border-accent text-accent-contrast"
                  : "bg-surface3 border-border text-text-secondary hover:text-text hover:border-border-light"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {provider === "openrouter" && (
          <p className="text-[10px] text-text-muted">
            OpenRouter lets you use 300+ models with one API key. Vision support depends on the model you choose.
          </p>
        )}
        {provider === "deepseek" && (
          <p className="text-[10px] text-warning">
            deepseek-chat / deepseek-v3 are text-only. Use <strong>deepseek-vl</strong> or <strong>deepseek-v4-pro</strong> for image support.
          </p>
        )}
      </div>

      {/* Display name + model slug */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
            Display Name
          </label>
          <input
            required value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. My GPT-4o"
            className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
            Model ID / Slug
          </label>
          <input
            required value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
            className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono"
          />
        </div>
      </div>

      {/* Base URL (custom/openrouter) */}
      {(provider === "custom" || provider === "openrouter") && (
        <div>
          <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
            Base URL {provider === "openrouter" ? "(leave blank for default)" : "(required)"}
          </label>
          <input
            required={provider === "custom"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://localhost:1234/v1"}
            className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono"
          />
        </div>
      )}

      {/* API Key */}
      <div>
        <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
          API Key {isEdit && <span className="text-text-muted font-normal">(leave masked to keep current key)</span>}
        </label>
        <input
          type="password"
          required={!isEdit}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onFocus={() => { if (apiKey.includes("•")) setApiKey(""); }}
          placeholder={isEdit ? "Enter new key to update, or leave unchanged" : "sk-… or your API key"}
          className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono"
        />
      </div>

      {/* Test button + result */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || probingVision}
          className="flex items-center gap-2 px-4 py-2 bg-surface border border-border hover:border-border-light text-text text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {(testing || probingVision)
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-accent" /> {probingVision ? "Testing vision…" : "Connecting…"}</>
            : <><RefreshCw className="w-3.5 h-3.5" /> Test & Detect Capabilities</>
          }
        </button>

        {testMsg && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold ${
            testPassed === false
              ? "bg-error-dim/20 border border-error/25 text-error"
              : testPassed === true && visionResult === true
              ? "bg-success/10 border border-success/20 text-success"
              : testPassed === true
              ? "bg-accent-dim/20 border border-accent/25 text-text"
              : "bg-surface3 border border-border text-text-secondary"
          }`}>
            {testPassed === true && visionResult === true && <Eye className="w-3.5 h-3.5 shrink-0" />}
            {testPassed === true && visionResult === false && <EyeOff className="w-3.5 h-3.5 shrink-0" />}
            {testPassed === false && <XCircle className="w-3.5 h-3.5 shrink-0" />}
            <span>{testMsg}</span>
          </div>
        )}
      </div>

      {/* Role + active settings (collapsed unless editing) */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={roleCoding} onChange={(e) => setRoleCoding(e.target.checked)}
            className="w-3.5 h-3.5 accent-white rounded" />
          <span className="text-xs text-text-secondary">Coding tasks</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={roleWriting} onChange={(e) => setRoleWriting(e.target.checked)}
            className="w-3.5 h-3.5 accent-white rounded" />
          <span className="text-xs text-text-secondary">Writing tasks</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)}
            className="w-3.5 h-3.5 accent-white rounded" />
          <span className="text-xs text-text-secondary">Active (used by agent)</span>
        </label>
      </div>

      {/* Form actions */}
      <div className="flex justify-between items-center pt-1">
        <button
          type="button" onClick={onCancel}
          className="px-4 py-2 text-xs font-semibold text-text-secondary hover:text-text border border-border bg-surface3 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || (!testPassed && !isEdit)}
          className="px-5 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg transition-colors disabled:opacity-40"
          title={!testPassed && !isEdit ? "Test connection first" : ""}
        >
          {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Saving…</> : (isEdit ? "Save Changes" : "Add Model")}
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
}

const ModelCard: React.FC<ModelCardProps> = ({ model, onEdit, onDelete }) => {
  const [expanded, setExpanded] = useState(false);
  const cap = capabilityLabel(model);

  return (
    <div className="bg-surface2 border border-border rounded-xl overflow-hidden">
      {/* Main row */}
      <div className="p-4 flex items-center gap-3">
        {/* Vision indicator pill */}
        <div className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
          cap.vision
            ? "bg-success/15 border border-success/25 text-success"
            : "bg-surface3 border border-border text-text-muted"
        }`}>
          {cap.vision ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          {cap.label}
        </div>

        {/* Model info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-text text-sm">{model.display_name}</span>
            <span className="text-[10px] text-text-muted font-mono bg-surface3 px-1.5 py-0.5 rounded border border-border uppercase tracking-wide">
              {model.provider_type}
            </span>
            {model.is_active && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/25">
                Active
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted font-mono truncate mt-0.5">{model.model_name}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-text-muted hover:text-text transition-colors rounded"
            title="Show capabilities"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => onEdit(model)}
            className="p-1.5 text-text-muted hover:text-accent transition-colors rounded"
            title="Edit model"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(model.id)}
            className="p-1.5 text-text-muted hover:text-error hover:bg-error-dim/20 transition-colors rounded"
            title="Delete model"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border space-y-2">
          <p className="text-xs text-text-secondary mt-2">{cap.description}</p>

          <div className="flex flex-wrap gap-1.5 mt-2">
            {/* What this model can DO */}
            <span className="text-[9px] font-bold bg-surface3 border border-border text-text-muted px-2 py-0.5 rounded uppercase">
              ✓ Text generation
            </span>
            <span className="text-[9px] font-bold bg-surface3 border border-border text-text-muted px-2 py-0.5 rounded uppercase">
              ✓ Code generation
            </span>
            <span className="text-[9px] font-bold bg-surface3 border border-border text-text-muted px-2 py-0.5 rounded uppercase">
              ✓ Task automation
            </span>
            {cap.vision && (
              <span className="text-[9px] font-bold bg-success/10 border border-success/20 text-success px-2 py-0.5 rounded uppercase">
                ✓ Screen vision
              </span>
            )}
            {/* Assigned roles */}
            {model.role_coding && (
              <span className="text-[9px] font-bold bg-accent/10 border border-accent/20 text-accent px-2 py-0.5 rounded uppercase">
                Coding role
              </span>
            )}
            {model.role_writing && (
              <span className="text-[9px] font-bold bg-accent/10 border border-accent/20 text-accent px-2 py-0.5 rounded uppercase">
                Writing role
              </span>
            )}
          </div>

          {/* Non-vision note */}
          {!cap.vision && (
            <div className="flex items-start gap-1.5 mt-2">
              <AlertTriangle className="w-3 h-3 text-warning shrink-0 mt-0.5" />
              <p className="text-[10px] text-warning leading-relaxed">
                This model cannot see your screen. It will automate via OCR + accessibility tree instead.
                For full screen control, add a vision model (GPT-4o, Claude 3, Gemini).
              </p>
            </div>
          )}

          {model.base_url && (
            <p className="text-[10px] text-text-muted font-mono mt-1">Endpoint: {model.base_url}</p>
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
  const [mem0Key, setMem0Key]   = useState("");
  const [mem0Type, setMem0Type] = useState<"cloud" | "self-hosted">("cloud");
  const [mem0Url, setMem0Url]   = useState("https://api.mem0.ai");

  // Hotkeys
  const [micHotkey, setMicHotkey]   = useState("Ctrl+Shift+A");
  const [textHotkey, setTextHotkey] = useState("Ctrl+Shift+T");
  const [recordingHotkey, setRecordingHotkey] = useState<"mic" | "text" | null>(null);
  const [pressedKeys, setPressedKeys] = useState<string[]>([]);
  const [hotkeyMsg, setHotkeyMsg]   = useState<{ text: string; success: boolean } | null>(null);

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
      } catch (e) { console.error(e); }
    })();

    let unlistenHotkey: (() => void) | null = null;
    listen<{ type: string; value: string }>("hotkey:updated", (event) => {
      const { type, value } = event.payload;
      if (type === "mic")  setMicHotkey(value);
      if (type === "text") setTextHotkey(value);
    }).then((fn) => { unlistenHotkey = fn; });
    return () => { if (unlistenHotkey) unlistenHotkey(); };
  }, []);

  const handleSaveElevenLabs = async () => {
    try {
      await invoke("save_api_key", { name: "elevenlabs", value: elevenLabsKey });
      alert("ElevenLabs key saved.");
    } catch (e: any) { alert("Failed: " + e); }
  };

  const handleSaveMem0 = async () => {
    try {
      if (!mem0Key.includes("•")) await invoke("save_api_key", { name: "mem0", value: mem0Key });
      await invoke("save_setting", { key: "mem0_type", value: mem0Type });
      await invoke("save_setting", { key: "mem0_url",  value: mem0Url });
      alert("Mem0 config saved.");
    } catch (e: any) { alert("Failed: " + e); }
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this model and remove its API key?")) {
      try { await deleteCustomModel(id); } catch (e) { console.error(e); }
    }
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

  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.ctrlKey)  parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey)   parts.push("Alt");
    if (e.metaKey)  parts.push("Win");
    if (!["Control","Shift","Alt","Meta"].includes(e.key)) {
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    }
    setPressedKeys(parts);
  };

  const handleHotkeyKeyUp = async () => {
    if (!recordingHotkey || pressedKeys.length < 2) {
      setHotkeyMsg({ text: "Need modifier (Ctrl/Shift/Alt) + a key.", success: false });
      setRecordingHotkey(null);
      setPressedKeys([]);
      return;
    }
    const hotkeyStr = pressedKeys.join("+");
    const type = recordingHotkey;
    setRecordingHotkey(null);
    setPressedKeys([]);
    try {
      await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: hotkeyStr });
      if (type === "mic")  setMicHotkey(hotkeyStr);
      else                  setTextHotkey(hotkeyStr);
      setHotkeyMsg({ text: `${type === "mic" ? "Mic" : "Text"} hotkey → ${hotkeyStr}`, success: true });
    } catch (e: any) {
      setHotkeyMsg({ text: e?.toString() || "Failed.", success: false });
    }
  };

  const resetHotkey = async (type: "mic" | "text") => {
    const def = type === "mic" ? "Ctrl+Shift+A" : "Ctrl+Shift+T";
    try {
      await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: def });
      if (type === "mic") setMicHotkey(def); else setTextHotkey(def);
      setHotkeyMsg({ text: `Reset to ${def}`, success: true });
    } catch (e: any) { setHotkeyMsg({ text: e?.toString() || "Failed.", success: false }); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Settings</h1>
        <p className="text-text-secondary text-sm">Configure AI models, API keys, hotkeys, and system options.</p>
      </div>

      {/* ── Model Registry ─────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-semibold text-text text-sm">AI Models</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Models you add here are tested against their real API to detect text, coding, and vision capabilities.
              The agent picks the right model automatically per task.
            </p>
          </div>
          {!showForm && (
            <button
              onClick={openAddForm}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg flex items-center gap-1.5 transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" /> Add Model
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
            <ModelCard key={m.id} model={m} onEdit={openEditForm} onDelete={handleDelete} />
          ))}
          {models.length === 0 && !showForm && (
            <div className="text-center py-12 border border-dashed border-border rounded-xl space-y-2">
              <p className="text-sm font-semibold text-text-secondary">No models yet</p>
              <p className="text-xs text-text-muted">Add a model to start using Omni automation.</p>
              <button
                onClick={openAddForm}
                className="mt-2 px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" /> Add Your First Model
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Global Hotkeys ──────────────────────────────────────────── */}
      <div
        className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm"
        onKeyDown={handleHotkeyKeyDown}
        onKeyUp={handleHotkeyKeyUp}
        tabIndex={-1}
      >
        <div className="flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-accent" />
          <div>
            <h3 className="font-semibold text-text text-sm">Global Hotkeys</h3>
            <p className="text-xs text-text-secondary">These work system-wide even when Omni's window is hidden.</p>
          </div>
        </div>

        {hotkeyMsg && (
          <div className={`px-3 py-2 rounded-lg text-xs font-semibold ${
            hotkeyMsg.success ? "bg-success/10 border border-success/20 text-success" : "bg-error-dim/20 border border-error/30 text-error"
          }`}>
            {hotkeyMsg.text}
          </div>
        )}

        {[
          { type: "mic" as const, label: "Voice Activation", desc: "Hold to speak, release to execute", value: micHotkey },
          { type: "text" as const, label: "Quick Command (text)", desc: "Opens floating text input window", value: textHotkey },
        ].map((hk) => (
          <div key={hk.type} className="p-3.5 bg-surface2 border border-border rounded-xl flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-text">{hk.label}</p>
              <p className="text-xs text-text-secondary">{hk.desc}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className={`px-3 py-1.5 rounded-lg border font-mono text-xs font-bold min-w-[130px] text-center transition-all ${
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
                className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
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
                className="p-1.5 text-text-muted hover:text-text border border-border bg-surface3 rounded-lg transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        <div className="p-3.5 bg-surface2 border border-border rounded-xl flex items-center justify-between opacity-55">
          <div>
            <p className="text-sm font-semibold text-text">Emergency Kill Switch</p>
            <p className="text-xs text-text-secondary">Stops everything immediately. Not configurable by design.</p>
          </div>
          <div className="px-3 py-1.5 border border-border bg-surface3 font-mono text-xs font-bold text-text-muted rounded-lg">
            Esc × 2
          </div>
        </div>
      </div>

      {/* ── System Integrations ──────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-accent" />
          <div>
            <h3 className="font-semibold text-text text-sm">System Integrations</h3>
            <p className="text-xs text-text-secondary">Voice (STT/TTS) and memory keys.</p>
          </div>
        </div>

        {/* ElevenLabs */}
        <div className="p-4 bg-surface2 border border-border rounded-xl space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-text">ElevenLabs Voice (STT + TTS)</h4>
            <p className="text-xs text-text-secondary">Used for speech-to-text (Scribe v2) and natural voice output. Falls back to Windows SAPI if not set.</p>
          </div>
          <div className="flex gap-3">
            <input
              type="password" value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
              placeholder="el_… ElevenLabs API key"
              className="flex-1 px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono"
            />
            <button onClick={handleSaveElevenLabs}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg transition-colors shrink-0">
              Save
            </button>
          </div>
        </div>

        {/* Mem0 */}
        <div className="p-4 bg-surface2 border border-border rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-text">Mem0 Memory</h4>
              <p className="text-xs text-text-secondary">Persistent user facts that improve every task. Optional.</p>
            </div>
            <div className="flex gap-1">
              {["cloud", "self-hosted"].map((t) => (
                <button key={t} type="button"
                  onClick={() => { setMem0Type(t as any); if (t === "cloud") setMem0Url("https://api.mem0.ai"); else if (mem0Url === "https://api.mem0.ai") setMem0Url("http://localhost:8000"); }}
                  className={`px-2.5 py-1 text-[10px] font-bold uppercase rounded-md border transition-colors ${
                    mem0Type === t ? "bg-accent border-accent text-accent-contrast" : "bg-surface3 border-border text-text-secondary hover:text-text"
                  }`}>
                  {t === "cloud" ? "Cloud" : "Self-hosted"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">API Key</label>
              <input type="password" value={mem0Key} onChange={(e) => setMem0Key(e.target.value)}
                placeholder={mem0Type === "cloud" ? "Required for cloud" : "Optional"}
                className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Base URL</label>
              <input type="text" value={mem0Url} disabled={mem0Type === "cloud"} onChange={(e) => setMem0Url(e.target.value)}
                placeholder="http://localhost:8000"
                className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent font-mono disabled:opacity-50" />
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={handleSaveMem0}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg transition-colors">
              Save Mem0 Config
            </button>
          </div>
        </div>
      </div>

      {/* ── Appearance ─────────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-text text-sm">Appearance</h3>
            <p className="text-xs text-text-secondary">Dark and light theme support.</p>
          </div>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as "dark" | "light")}
            className="px-3 py-1.5 bg-surface2 border border-border rounded-lg text-text text-xs font-semibold focus:outline-none focus:border-accent"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </div>
    </div>
  );
};
