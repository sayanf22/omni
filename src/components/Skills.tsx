import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MousePointer, Keyboard, Monitor, Folder, Clipboard, Chrome,
  Slack, PenTool, Plus, Trash2, Loader2, Sparkles, Check
} from "lucide-react";

interface CustomSkill {
  id: string;
  name: string;
  instructions: string;
}

const BUILT_IN_SKILLS = [
  { icon: MousePointer, name: "Mouse & Click",      desc: "Direct cursor positioning, clicking, right-click, double-click, drag, and scroll.", tier: "active" },
  { icon: Keyboard,    name: "Keyboard & Typing",   desc: "Single keys, modifier combos (Ctrl+C, etc.), and clipboard-paste for long text.", tier: "active" },
  { icon: Monitor,     name: "Screen Reading (OCR)", desc: "GPU-accelerated capture, WinRT OCR, find text coordinates, accessibility tree.", tier: "active" },
  { icon: Folder,      name: "File System",          desc: "Read, write, create folders, move, delete (with approval gate), search files.", tier: "active" },
  { icon: Clipboard,   name: "Clipboard",            desc: "Read current clipboard contents, write text or data to clipboard.", tier: "active" },
  { icon: Chrome,      name: "Browser & Web",        desc: "Open Chrome/Edge, navigate URLs, use keyboard shortcuts for web control.", tier: "active" },
  { icon: Slack,       name: "Slack & Teams",        desc: "Send messages, post to channels via desktop app automation.", tier: "v2" },
  { icon: PenTool,     name: "Creative Suite",       desc: "Photoshop, DaVinci Resolve, Illustrator batch automation.", tier: "v2" },
];

export const Skills: React.FC = () => {
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [isAdding, setIsAdding]         = useState(false);
  const [newName, setNewName]           = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  const [saving, setSaving]             = useState(false);
  const [saved, setSaved]               = useState(false);
  const [loading, setLoading]           = useState(true);

  // Load custom skills from SQLite settings on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("get_setting", { key: "custom_skills_json" });
        if (raw) setCustomSkills(JSON.parse(raw));
      } catch (_) {}
      setLoading(false);
    })();
  }, []);

  const persistSkills = async (skills: CustomSkill[]) => {
    await invoke("save_setting", {
      key: "custom_skills_json",
      value: JSON.stringify(skills),
    });
  };

  const handleAddSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newInstructions.trim()) return;
    setSaving(true);
    const newSkill: CustomSkill = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      instructions: newInstructions.trim(),
    };
    const updated = [...customSkills, newSkill];
    try {
      await persistSkills(updated);
      setCustomSkills(updated);
      setNewName("");
      setNewInstructions("");
      setIsAdding(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleDeleteSkill = async (id: string) => {
    if (!confirm("Remove this custom skill?")) return;
    const updated = customSkills.filter((s) => s.id !== id);
    await persistSkills(updated);
    setCustomSkills(updated);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text">Skills</h1>
        <p className="text-text-secondary text-sm">
          Built-in automation capabilities and custom instructions the agent always follows.
        </p>
      </div>

      {/* ── Custom Skills ──────────────────────────────────────────────── */}
      <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Sparkles className="w-4 h-4 text-accent" />
              <h3 className="font-semibold text-text text-sm">Custom Skills</h3>
              {saved && (
                <span className="flex items-center gap-1 text-[10px] text-success font-semibold">
                  <Check className="w-3 h-3" /> Saved
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              Write instructions the agent will always follow — your preferences, style rules, shortcuts, or workflows.
              These are injected into every task's system prompt.
            </p>
          </div>
          {!isAdding && (
            <button onClick={() => setIsAdding(true)}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg flex items-center gap-1.5 transition-colors shrink-0">
              <Plus className="w-3.5 h-3.5" /> Add Skill
            </button>
          )}
        </div>

        {/* Add form */}
        {isAdding && (
          <form onSubmit={handleAddSkill}
            className="p-4 bg-surface2 border border-border rounded-xl space-y-3">
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
                Skill Name
              </label>
              <input
                required value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. LinkedIn Post Style"
                className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">
                Instructions for the Agent
              </label>
              <textarea
                required rows={4} value={newInstructions} onChange={(e) => setNewInstructions(e.target.value)}
                placeholder={`e.g. When writing LinkedIn posts: always keep them under 150 words, use a professional but friendly tone, no hashtags, and end with a call-to-action question.`}
                className="w-full px-3 py-2 bg-surface3 border border-border rounded-lg text-text text-sm focus:outline-none focus:border-accent resize-none placeholder:text-text-muted"
              />
              <p className="text-[10px] text-text-muted mt-1">
                Be as specific as possible. The agent will follow these instructions on every relevant task.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setIsAdding(false); setNewName(""); setNewInstructions(""); }}
                className="px-4 py-2 text-xs font-semibold text-text-secondary border border-border bg-surface3 rounded-lg hover:text-text transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-bold rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving…</> : "Save Skill"}
              </button>
            </div>
          </form>
        )}

        {/* Custom skills list */}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <p className="text-xs">Loading…</p>
          </div>
        ) : customSkills.length > 0 ? (
          <div className="space-y-3">
            {customSkills.map((skill) => (
              <div key={skill.id}
                className="p-4 bg-surface2 border border-accent/20 rounded-xl flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Sparkles className="w-3.5 h-3.5 text-accent shrink-0" />
                    <p className="text-sm font-semibold text-text">{skill.name}</p>
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/20">
                      Custom
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{skill.instructions}</p>
                </div>
                <button onClick={() => handleDeleteSkill(skill.id)}
                  className="p-1.5 text-text-muted hover:text-error hover:bg-error-dim/20 rounded-md transition-colors shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : !isAdding && (
          <div className="border border-dashed border-border rounded-xl p-6 text-center space-y-2">
            <Sparkles className="w-6 h-6 text-text-muted mx-auto" />
            <p className="text-sm font-semibold text-text-secondary">No custom skills yet</p>
            <p className="text-xs text-text-muted max-w-sm mx-auto">
              Add instructions like "Always save files to D:/Work" or "Write emails in a formal tone" — the agent will follow them automatically.
            </p>
          </div>
        )}
      </div>

      {/* ── Built-in Skills ────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div>
          <h3 className="font-semibold text-text text-sm">Built-in Capabilities</h3>
          <p className="text-xs text-text-secondary">These automation tools are always available to the agent.</p>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {BUILT_IN_SKILLS.map((skill, i) => {
            const Icon = skill.icon;
            return (
              <div key={i} className="bg-surface border border-border rounded-xl p-4 space-y-3 flex flex-col justify-between shadow-sm">
                <div className="space-y-2">
                  <div className="w-9 h-9 rounded-lg bg-surface2 border border-border flex items-center justify-center text-accent">
                    <Icon className="w-4.5 h-4.5" />
                  </div>
                  <h4 className="font-semibold text-text text-sm">{skill.name}</h4>
                  <p className="text-xs text-text-secondary leading-relaxed">{skill.desc}</p>
                </div>
                <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider w-fit ${
                  skill.tier === "active"
                    ? "bg-success/15 text-success border border-success/20"
                    : "bg-surface3 text-text-muted border border-border"
                }`}>
                  {skill.tier === "active" ? "✓ Active" : "V2 Coming"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
