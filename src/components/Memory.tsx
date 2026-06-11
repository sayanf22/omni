import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { Brain, Search, Trash2, Plus, Loader2, Sparkles, AlertCircle, RefreshCw } from "lucide-react";

interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
}

export const Memory: React.FC = () => {
  const { session } = useStore();
  const userId = session?.user?.id || "default_user";

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMemories = async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await invoke<MemoryItem[]>("get_all_memories", { userId });
      setMemories(results || []);
    } catch (e: any) {
      console.error("Failed to load memories", e);
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, [userId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      loadMemories();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const results = await invoke<MemoryItem[]>("search_memory_items", {
        query: searchQuery,
        userId
      });
      setMemories(results || []);
    } catch (e: any) {
      console.error("Failed to search memories", e);
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemory.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await invoke("add_custom_memory_item", {
        memory: newMemory,
        userId
      });
      setNewMemory("");
      await loadMemories();
    } catch (e: any) {
      console.error("Failed to add memory", e);
      setError(e.toString());
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    if (!confirm("Are you sure you want to delete this memory?")) return;
    setError(null);
    try {
      await invoke("delete_memory_item", { memoryId: id });
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e: any) {
      console.error("Failed to delete memory", e);
      setError(e.toString());
    }
  };

  return (
    <div className="space-y-8">
      {/* Title */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-4xl font-black text-text">Memory Studio</h1>
          <p className="text-text-secondary text-[16px] mt-2">
            Review, search, and manage learned user contexts, preferred styles, and semantic facts.
          </p>
        </div>
        <button
          onClick={loadMemories}
          disabled={loading}
          className="p-3 bg-surface2 hover:bg-surface3 border border-border rounded-xl text-text-secondary hover:text-text transition-colors disabled:opacity-50 shadow-sm"
          title="Reload Memories"
        >
          <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* V2 Memory Studio Info */}
      <div className="p-6 bg-accent-dim/15 border border-accent/25 rounded-[24px] text-text text-sm flex items-start gap-4 shadow-sm">
        <Sparkles className="w-6 h-6 text-accent shrink-0 mt-0.5 animate-pulse" />
        <div>
          <h4 className="font-extrabold text-text">Adaptive Memory Layer Active</h4>
          <p className="text-text-secondary mt-1 leading-relaxed">
            Omni parses user behavior, folder structures, and settings to customize LLM reasoning on every step. Customize this model by adding or deleting facts.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-error-dim/20 border border-error/35 rounded-2xl text-error text-sm flex items-center gap-3 shadow-sm">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>Error: {error}. Make sure your local Mem0 server is running or your Cloud key is set.</span>
        </div>
      )}

      {/* Input & Search Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Left Side: Add & Search Panel */}
        <div className="space-y-8 md:col-span-1">
          {/* Add custom fact */}
          <form onSubmit={handleAddMemory} className="premium-card p-7 space-y-5 shadow-md">
            <div>
              <h3 className="font-extrabold text-text text-base">Inject New Fact</h3>
              <p className="text-sm text-text-secondary mt-1">Manually teach Omni new facts about you.</p>
            </div>
            <textarea
              required
              rows={3}
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              placeholder="e.g. User prefers executing commands in PowerShell CLI instead of CMD."
              className="w-full px-4 py-3 bg-surface2 border border-border hover:border-border-light focus:border-accent/40 rounded-2xl text-text text-sm focus:outline-none focus:ring-0 resize-none placeholder:text-text-muted"
            />
            <button
              type="submit"
              disabled={adding || !newMemory.trim()}
              className="w-full py-3 bg-accent hover:bg-accent-hover text-accent-contrast text-sm font-extrabold rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 shadow-sm"
            >
              {adding ? (
                <>
                  <Loader2 className="w-4.5 h-4.5 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="w-4.5 h-4.5" />
                  Add Custom Fact
                </>
              )}
            </button>
          </form>

          {/* Semantic Search */}
          <form onSubmit={handleSearch} className="premium-card p-7 space-y-5 shadow-md">
            <div>
              <h3 className="font-extrabold text-text text-base">Semantic Search</h3>
              <p className="text-sm text-text-secondary mt-1">Query cognitive memories with natural language.</p>
            </div>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories..."
                className="w-full pl-11 pr-4 py-3 bg-surface2 border border-border hover:border-border-light focus:border-accent/40 rounded-2xl text-text text-sm focus:outline-none focus:ring-0 placeholder:text-text-muted"
              />
              <Search className="w-4.5 h-4.5 text-text-muted absolute left-4 top-3.5" />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                className="flex-1 py-2.5 bg-surface2 border border-border text-text text-sm font-extrabold rounded-xl hover:bg-surface3 transition-colors shadow-sm"
              >
                Search
              </button>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    loadMemories();
                  }}
                  className="px-4 py-2.5 bg-surface2 border border-border text-text-secondary hover:text-text text-sm font-extrabold rounded-xl transition-colors shadow-sm"
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Right Side: Memories List */}
        <div className="md:col-span-2 space-y-5">
          <div className="premium-card p-7 shadow-md space-y-5">
            <div>
              <h3 className="font-extrabold text-text text-base">Cognitive Memory Records ({memories.length})</h3>
              <p className="text-sm text-text-secondary mt-1">Facts extracted from past tasks and runs.</p>
            </div>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-accent" />
                <span className="text-sm text-text-secondary font-medium">Querying Memory Engine...</span>
              </div>
            ) : memories.length > 0 ? (
              <div className="space-y-3.5 max-h-[550px] overflow-y-auto pr-1">
                {memories.map((m) => (
                  <div
                    key={m.id}
                    className="p-4 bg-surface border border-border/80 hover:border-border rounded-2xl flex justify-between items-start gap-5 transition-all group shadow-sm"
                  >
                    <div className="flex gap-3.5 items-start">
                      <div className="w-8.5 h-8.5 rounded-xl bg-surface2 border border-border flex items-center justify-center text-accent shrink-0 mt-0.5 shadow-sm">
                        <Brain className="w-4.5 h-4.5" />
                      </div>
                      <p className="text-sm text-text leading-relaxed font-semibold mt-1">{m.memory}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteMemory(m.id)}
                      className="p-2 text-text-muted hover:text-error hover:bg-error-dim/20 rounded-xl transition-colors md:opacity-0 group-hover:opacity-100 shrink-0"
                      title="Delete Fact"
                    >
                      <Trash2 className="w-4.5 h-4.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 border border-dashed border-border rounded-[28px] gap-3.5 text-center px-6">
                <Brain className="w-10 h-10 text-text-muted animate-pulse" />
                <h4 className="font-black text-sm text-text mt-3">No Memories Found</h4>
                <p className="text-xs text-text-secondary max-w-xs mt-1 leading-relaxed">
                  Omni hasn't learned any facts yet. They will appear here automatically as you run tasks.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
