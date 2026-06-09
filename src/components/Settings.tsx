import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Plus, Trash2, Loader2, ToggleLeft, ToggleRight, Check, XCircle, Key, Keyboard, AlertTriangle, RefreshCw } from "lucide-react";

export const Settings: React.FC = () => {
  const { models, addCustomModel, deleteCustomModel, testModel, theme, setTheme } = useStore();
  const [isAdding, setIsAdding] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState("openai");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [roleVision, setRoleVision] = useState(true);
  const [roleCoding, setRoleCoding] = useState(false);
  const [roleWriting, setRoleWriting] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // System integrations keys
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [mem0Key, setMem0Key] = useState("");
  const [mem0Type, setMem0Type] = useState<"cloud" | "self-hosted">("cloud");
  const [mem0Url, setMem0Url] = useState("https://api.mem0.ai");

  // Hotkey settings
  const [micHotkey, setMicHotkey] = useState("Ctrl+Shift+A");
  const [textHotkey, setTextHotkey] = useState("Ctrl+Shift+T");
  const [recordingHotkey, setRecordingHotkey] = useState<"mic" | "text" | null>(null);
  const [pressedKeys, setPressedKeys] = useState<string[]>([]);
  const [hotkeyMsg, setHotkeyMsg] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    async function loadSystemKeys() {
      try {
        const elKey = await invoke<string | null>("get_api_key", { name: "elevenlabs" });
        const mKey = await invoke<string | null>("get_api_key", { name: "mem0" });
        if (elKey) setElevenLabsKey(elKey);
        if (mKey) setMem0Key(mKey);

        const mType = await invoke<string | null>("get_setting", { key: "mem0_type" });
        const mUrl = await invoke<string | null>("get_setting", { key: "mem0_url" });
        if (mType) setMem0Type(mType as "cloud" | "self-hosted");
        if (mUrl) setMem0Url(mUrl);

        // Load hotkeys
        const hotkeys = await invoke<{ mic: string; text: string }>("get_hotkeys");
        if (hotkeys.mic) setMicHotkey(hotkeys.mic);
        if (hotkeys.text) setTextHotkey(hotkeys.text);
      } catch (e) {
        console.error("Failed to load system keys or settings from DB", e);
      }
    }
    loadSystemKeys();

    // Listen for hotkey update confirmations from Rust
    let unlistenHotkey: (() => void) | null = null;
    listen<{ type: string; value: string }>("hotkey:updated", (event) => {
      const { type, value } = event.payload;
      if (type === "mic") setMicHotkey(value);
      if (type === "text") setTextHotkey(value);
    }).then((fn) => { unlistenHotkey = fn; });

    return () => {
      if (unlistenHotkey) unlistenHotkey();
    };
  }, []);

  const handleSaveElevenLabs = async () => {
    try {
      if (elevenLabsKey === "••••••••••••••••") {
        alert("ElevenLabs API Key configuration verified and unchanged.");
        return;
      }
      await invoke("save_api_key", { name: "elevenlabs", value: elevenLabsKey });
      alert("ElevenLabs API Key saved securely.");
    } catch (e: any) {
      alert("Failed to save ElevenLabs key: " + e.toString());
    }
  };

  const handleSaveMem0 = async () => {
    try {
      if (mem0Key !== "••••••••••••••••") {
        await invoke("save_api_key", { name: "mem0", value: mem0Key });
      }
      await invoke("save_setting", { key: "mem0_type", value: mem0Type });
      await invoke("save_setting", { key: "mem0_url", value: mem0Url });
      alert("Mem0 Configuration saved successfully.");
    } catch (e: any) {
      alert("Failed to save Mem0 config: " + e.toString());
    }
  };

  const handleProviderChange = (p: string) => {
    setProvider(p);
    setTestResult(null);
    if (p === "openai") {
      setDisplayName("OpenAI primary");
      setModelName("gpt-4o-mini");
      setBaseUrl("");
      setRoleVision(true);
    } else if (p === "anthropic") {
      setDisplayName("Anthropic Claude");
      setModelName("claude-3-5-sonnet-latest");
      setBaseUrl("");
      setRoleVision(true);
    } else if (p === "deepseek") {
      setDisplayName("DeepSeek Flash");
      setModelName("deepseek-chat");
      setBaseUrl("");
      setRoleVision(false);
      setRoleWriting(true);
    } else if (p === "openrouter") {
      setDisplayName("OpenRouter Auto");
      setModelName("google/gemini-2.5-flash");
      setBaseUrl("");
      setRoleVision(true);
    } else {
      setDisplayName("Local Endpoint");
      setModelName("my-custom-model");
      setBaseUrl("http://localhost:1234/v1");
      setRoleVision(true);
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

  const handleSaveModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName || !modelName || !apiKey) return;
    setSaving(true);
    try {
      await addCustomModel({
        provider_type: provider,
        model_name: modelName,
        display_name: displayName,
        base_url: baseUrl || null,
        role_vision: roleVision,
        role_coding: roleCoding,
        role_writing: roleWriting,
        is_active: isActive,
      }, apiKey);
      setIsAdding(false);
      // Reset form
      setDisplayName("");
      setApiKey("");
      setTestResult(null);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this model and purge its API key?")) {
      try {
        await deleteCustomModel(id);
      } catch (e) {
        console.error(e);
      }
    }
  };

  // ── Hotkey recording helpers ───────────────────────────────────────────────
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

    const key = e.key;
    // Skip lone modifier presses
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) {
      setPressedKeys(parts.length ? parts : []);
      return;
    }

    // Map key to display form
    const keyDisplay = key.length === 1 ? key.toUpperCase() : key;
    parts.push(keyDisplay);
    setPressedKeys(parts);
  };

  const handleHotkeyKeyUp = async () => {
    if (!recordingHotkey || pressedKeys.length < 2) {
      // Need at least one modifier + one key
      if (pressedKeys.length < 2) {
        setHotkeyMsg({ text: "Need at least one modifier (Ctrl/Shift/Alt) + a key.", success: false });
        setRecordingHotkey(null);
        setPressedKeys([]);
      }
      return;
    }

    const hotkeyStr = pressedKeys.join("+");
    const type = recordingHotkey;
    setRecordingHotkey(null);
    setPressedKeys([]);

    try {
      await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: hotkeyStr });
      if (type === "mic") setMicHotkey(hotkeyStr);
      else setTextHotkey(hotkeyStr);
      setHotkeyMsg({ text: `${type === "mic" ? "Mic activation" : "Text mode"} hotkey set to: ${hotkeyStr}`, success: true });
    } catch (e: any) {
      setHotkeyMsg({ text: e?.toString() || "Failed to set hotkey.", success: false });
    }
  };

  const resetHotkey = async (type: "mic" | "text") => {
    const defaultValue = type === "mic" ? "Ctrl+Shift+A" : "Ctrl+Shift+T";
    try {
      await invoke("set_hotkey", { hotkeyType: type, hotkeyValue: defaultValue });
      if (type === "mic") setMicHotkey(defaultValue);
      else setTextHotkey(defaultValue);
      setHotkeyMsg({ text: `${type === "mic" ? "Mic" : "Text"} hotkey reset to default: ${defaultValue}`, success: true });
    } catch (e: any) {
      setHotkeyMsg({ text: e?.toString() || "Failed to reset hotkey.", success: false });
    }
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-text">Settings</h1>
        <p className="text-text-secondary text-sm">Configure dynamic AI providers, model endpoints, and system parameters.</p>
      </div>

      {/* Model Configurations Section */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="font-semibold text-text text-sm">Model Registry</h3>
            <p className="text-xs text-text-secondary">Register API endpoints and allocate role priorities securely.</p>
          </div>
          {!isAdding && (
            <button
              onClick={() => { setIsAdding(true); handleProviderChange("openai"); }}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-semibold rounded-md flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add Model
            </button>
          )}
        </div>

        {/* Add Model Form */}
        {isAdding && (
          <form onSubmit={handleSaveModel} className="p-4 bg-surface2 border border-border rounded-lg space-y-4">
            <h4 className="text-xs font-bold text-text uppercase tracking-wider">Configure Provider Payload</h4>

            {/* Provider Tabs */}
            <div className="grid grid-cols-5 gap-2">
              {["openai", "anthropic", "deepseek", "openrouter", "custom"].map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => handleProviderChange(p)}
                  className={`py-1.5 text-xs font-semibold rounded-md border text-center capitalize transition-colors ${
                    provider === p
                      ? "bg-accent border-accent text-accent-contrast"
                      : "bg-surface3 border-border text-text-secondary hover:text-text"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Display Name</label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. GPT-4o Mini Premium"
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Model Slug / Identifier</label>
                <input
                  type="text"
                  required
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            {provider === "custom" && (
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Endpoint Base URL</label>
                <input
                  type="text"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="e.g. http://localhost:1234/v1"
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
                />
              </div>
            )}

            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">API Key</label>
              <input
                type="password"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Securely saved in Windows Credentials Manager"
                className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent font-mono"
              />
            </div>

            {/* Role Allocation & Status */}
            <div className="grid grid-cols-4 gap-4 items-center">
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Vision Role</label>
                <button
                  type="button"
                  onClick={() => setRoleVision(!roleVision)}
                  className="text-accent flex items-center"
                >
                  {roleVision ? <ToggleRight className="w-8 h-8" /> : <ToggleLeft className="w-8 h-8 text-text-muted" />}
                </button>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Coding Role</label>
                <button
                  type="button"
                  onClick={() => setRoleCoding(!roleCoding)}
                  className="text-accent flex items-center"
                >
                  {roleCoding ? <ToggleRight className="w-8 h-8" /> : <ToggleLeft className="w-8 h-8 text-text-muted" />}
                </button>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Writing Role</label>
                <button
                  type="button"
                  onClick={() => setRoleWriting(!roleWriting)}
                  className="text-accent flex items-center"
                >
                  {roleWriting ? <ToggleRight className="w-8 h-8" /> : <ToggleLeft className="w-8 h-8 text-text-muted" />}
                </button>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">Set Active</label>
                <button
                  type="button"
                  onClick={() => setIsActive(!isActive)}
                  className="text-accent flex items-center"
                >
                  {isActive ? <ToggleRight className="w-8 h-8" /> : <ToggleLeft className="w-8 h-8 text-text-muted" />}
                </button>
              </div>
            </div>

            {/* Form actions */}
            <div className="flex justify-between items-center pt-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testing || !apiKey}
                  className="px-3 py-1.5 border border-border hover:border-border-light bg-surface3 text-text text-xs rounded font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
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
                  <span className={`text-xs font-semibold flex items-center gap-1 ${testResult.success ? "text-success" : "text-error"}`}>
                    {testResult.success ? <Check className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    {testResult.success ? "Connection Verified" : "Failed Verification"}
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-4 py-1.5 bg-surface3 border border-border text-text-secondary hover:text-text text-xs font-semibold rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !apiKey}
                  className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-semibold rounded-md transition-colors disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Config"}
                </button>
              </div>
            </div>

            {testResult && !testResult.success && (
              <div className="p-2.5 bg-error-dim/20 border border-error/30 rounded text-xs text-error max-h-20 overflow-y-auto font-mono">
                {testResult.message}
              </div>
            )}
          </form>
        )}

        {/* Saved Models List */}
        <div className="space-y-3">
          {models.map((model) => (
            <div key={model.id} className="p-4 bg-surface2 border border-border rounded-lg flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold text-text text-sm">{model.display_name}</h4>
                  <span className="text-xs text-text-muted font-mono bg-surface3 px-1.5 py-0.5 rounded border border-border uppercase">
                    {model.provider_type}
                  </span>
                  {model.is_active && (
                    <span className="px-2 py-0.5 bg-accent-dim/35 text-accent border border-accent/30 rounded text-[9px] font-bold uppercase tracking-wider">
                      Active Setup
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary">
                  Identifier: <code className="text-accent">{model.model_name}</code>
                  {model.base_url && ` | Endpoint: ${model.base_url}`}
                </p>
                {/* Roles badges */}
                <div className="flex gap-1.5 pt-1">
                  {model.role_vision && (
                    <span className="text-[9px] font-bold uppercase bg-surface3 border border-border text-success px-1.5 py-0.25 rounded">
                      Vision
                    </span>
                  )}
                  {model.role_coding && (
                    <span className="text-[9px] font-bold uppercase bg-surface3 border border-border text-accent-hover px-1.5 py-0.25 rounded">
                      Coding
                    </span>
                  )}
                  {model.role_writing && (
                    <span className="text-[9px] font-bold uppercase bg-surface3 border border-border text-warning px-1.5 py-0.25 rounded">
                      Writing
                    </span>
                  )}
                </div>
              </div>

              <button
                onClick={() => handleDelete(model.id)}
                className="p-2 text-text-muted hover:text-error hover:bg-error-dim/20 rounded-md transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}

          {models.length === 0 && !isAdding && (
            <p className="text-xs text-text-muted text-center py-8">No models configured. Register a model to enable agent capabilities.</p>
          )}
        </div>
      </div>

      {/* System Integrations Panel */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div>
          <h3 className="font-semibold text-text text-sm">System Integrations</h3>
          <p className="text-xs text-text-secondary">Configure global api keys for audio processing and cognitive memories.</p>
        </div>

        <div className="space-y-4">
          {/* ElevenLabs */}
          <div className="p-4 bg-surface2 border border-border rounded-lg space-y-3">
            <div className="flex items-center gap-2 text-accent">
              <Key className="w-4.5 h-4.5" />
              <h4 className="font-semibold text-text text-sm">ElevenLabs API Settings (Audio STT/TTS)</h4>
            </div>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">ElevenLabs Key</label>
                <input
                  type="password"
                  value={elevenLabsKey}
                  onChange={(e) => setElevenLabsKey(e.target.value)}
                  placeholder="Securely encrypted using Windows DPAPI"
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent font-mono"
                />
              </div>
              <button
                type="button"
                onClick={handleSaveElevenLabs}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-semibold rounded transition-colors h-9 shrink-0"
              >
                Save Key
              </button>
            </div>
          </div>

          {/* Mem0 */}
          <div className="p-4 bg-surface2 border border-border rounded-lg space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <div className="flex items-center gap-2 text-success">
                <Key className="w-4.5 h-4.5" />
                <h4 className="font-semibold text-text text-sm">Mem0 Memory Settings (Cognitive Memory)</h4>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setMem0Type("cloud");
                    setMem0Url("https://api.mem0.ai");
                  }}
                  className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded border transition-colors ${
                    mem0Type === "cloud"
                      ? "bg-success border-success text-black"
                      : "bg-surface3 border-border text-text-secondary hover:text-text"
                  }`}
                >
                  Cloud
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMem0Type("self-hosted");
                    if (mem0Url === "https://api.mem0.ai") {
                      setMem0Url("http://localhost:8000");
                    }
                  }}
                  className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded border transition-colors ${
                    mem0Type === "self-hosted"
                      ? "bg-accent border-accent text-accent-contrast"
                      : "bg-surface3 border-border text-text-secondary hover:text-text"
                  }`}
                >
                  Self-Hosted OSS
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
                  API Key / Token {mem0Type === "self-hosted" && "(Optional)"}
                </label>
                <input
                  type="password"
                  value={mem0Key}
                  onChange={(e) => setMem0Key(e.target.value)}
                  placeholder={mem0Type === "cloud" ? "Required for Cloud Mode" : "Optional local auth key"}
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent font-mono"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
                  Base Endpoint URL
                </label>
                <input
                  type="text"
                  value={mem0Url}
                  disabled={mem0Type === "cloud"}
                  onChange={(e) => setMem0Url(e.target.value)}
                  placeholder="e.g. http://localhost:8000"
                  className="w-full px-3 py-2 bg-surface3 border border-border rounded text-text text-sm focus:outline-none focus:border-accent font-mono disabled:opacity-60"
                />
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={handleSaveMem0}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-semibold rounded transition-colors h-9"
              >
                Save Mem0 Config
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Hotkey Configuration Panel */}
      <div
        className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm"
        onKeyDown={handleHotkeyKeyDown}
        onKeyUp={handleHotkeyKeyUp}
        tabIndex={-1}
      >
        <div>
          <h3 className="font-semibold text-text text-sm flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-accent" />
            Global Hotkeys
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Click "Record" then press your desired key combination. The kill switch (Esc × 2) is fixed.
          </p>
        </div>

        {hotkeyMsg && (
          <div className={`p-3 rounded-lg border text-xs font-semibold flex items-center gap-2 ${
            hotkeyMsg.success
              ? "bg-success/10 border-success/20 text-success"
              : "bg-error-dim/20 border-error/30 text-error"
          }`}>
            {hotkeyMsg.success ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            {hotkeyMsg.text}
          </div>
        )}

        <div className="space-y-3">
          {/* Mic activation hotkey */}
          <div className="p-4 bg-surface2 border border-border rounded-lg flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <h4 className="text-sm font-semibold text-text">Voice Activation (Mic)</h4>
              <p className="text-xs text-text-secondary">Hold to speak, release to send command to agent.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className={`px-3 py-1.5 rounded-md border font-mono text-xs font-bold min-w-[140px] text-center transition-all ${
                recordingHotkey === "mic"
                  ? "border-accent bg-accent/10 text-accent animate-pulse"
                  : "border-border bg-surface3 text-text"
              }`}>
                {recordingHotkey === "mic"
                  ? (pressedKeys.length ? pressedKeys.join("+") : "Press keys...")
                  : micHotkey}
              </div>
              <button
                onClick={() => startRecording("mic")}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  recordingHotkey === "mic"
                    ? "bg-error/20 border-error/30 text-error"
                    : "bg-accent hover:bg-accent-hover border-accent text-accent-contrast"
                }`}
              >
                {recordingHotkey === "mic" ? "Cancel" : "Record"}
              </button>
              <button
                onClick={() => resetHotkey("mic")}
                title="Reset to default"
                className="p-1.5 text-text-muted hover:text-text border border-border hover:border-border-light bg-surface3 rounded-md transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Text command hotkey */}
          <div className="p-4 bg-surface2 border border-border rounded-lg flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <h4 className="text-sm font-semibold text-text">Text Command Mode</h4>
              <p className="text-xs text-text-secondary">Opens the dashboard to type a command directly.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className={`px-3 py-1.5 rounded-md border font-mono text-xs font-bold min-w-[140px] text-center transition-all ${
                recordingHotkey === "text"
                  ? "border-accent bg-accent/10 text-accent animate-pulse"
                  : "border-border bg-surface3 text-text"
              }`}>
                {recordingHotkey === "text"
                  ? (pressedKeys.length ? pressedKeys.join("+") : "Press keys...")
                  : textHotkey}
              </div>
              <button
                onClick={() => startRecording("text")}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  recordingHotkey === "text"
                    ? "bg-error/20 border-error/30 text-error"
                    : "bg-accent hover:bg-accent-hover border-accent text-accent-contrast"
                }`}
              >
                {recordingHotkey === "text" ? "Cancel" : "Record"}
              </button>
              <button
                onClick={() => resetHotkey("text")}
                title="Reset to default"
                className="p-1.5 text-text-muted hover:text-text border border-border hover:border-border-light bg-surface3 rounded-md transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Kill switch — hardcoded */}
          <div className="p-4 bg-surface2 border border-border rounded-lg flex items-center justify-between gap-4 opacity-60">
            <div className="space-y-0.5">
              <h4 className="text-sm font-semibold text-text">Emergency Kill Switch</h4>
              <p className="text-xs text-text-secondary">Immediately stops all running tasks. Not configurable by design.</p>
            </div>
            <div className="px-3 py-1.5 rounded-md border border-border bg-surface3 font-mono text-xs font-bold text-text-muted min-w-[140px] text-center">
              Esc × 2
            </div>
          </div>
        </div>
      </div>

      {/* Interface Settings Panel */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div>
          <h3 className="font-semibold text-text text-sm">Interface Settings</h3>
          <p className="text-xs text-text-secondary">Personalize the application's appearance and display mode.</p>
        </div>

        <div className="p-4 bg-surface2 border border-border rounded-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-text text-sm">Color Theme</h4>
              <p className="text-xs text-text-secondary">Toggle between Bright (Light) and Dark display modes.</p>
            </div>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as "dark" | "light")}
              className="px-3 py-1.5 bg-surface3 border border-border rounded text-text text-xs font-semibold focus:outline-none focus:border-accent"
            >
              <option value="dark">Dark Theme</option>
              <option value="light">Light Theme (Bright)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
