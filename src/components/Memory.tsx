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
    <div className="space-y-6">
      {/* Title */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-text">Memory Studio</h1>
          <p className="text-text-secondary text-sm">
            Review, search, and manage learned user contexts, preferred styles, and semantic facts.
          </p>
        </div>
        <button
          onClick={loadMemories}
          disabled={loading}
          className="p-2 bg-surface2 hover:bg-surface3 border border-border rounded-lg text-text-secondary hover:text-text transition-colors disabled:opacity-50"
          title="Reload Memories"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* V2 Memory Studio Info */}
      <div className="p-4 bg-accent-dim/15 border border-accent/25 rounded-xl text-text text-xs flex items-start gap-3">
        <Sparkles className="w-5 h-5 text-accent shrink-0 mt-0.5 animate-pulse" />
        <div>
          <h4 className="font-semibold text-text">Adaptive Memory Layer Active</h4>
          <p className="text-text-secondary mt-0.5">
            Omni parses user behavior, folder structures, and settings to customize LLM reasoning on every step. Customize this model by adding or deleting facts.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-error-dim/20 border border-error/35 rounded-lg text-error text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>Error: {error}. Make sure your local Mem0 server is running or your Cloud key is set.</span>
        </div>
      )}

      {/* Input & Search Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Side: Add & Search Panel */}
        <div className="space-y-6 md:col-span-1">
          {/* Add custom fact */}
          <form onSubmit={handleAddMemory} className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
            <div>
              <h3 className="font-semibold text-text text-sm">Inject New Fact</h3>
              <p className="text-xs text-text-secondary">Manually teach Omni new facts about you.</p>
            </div>
            <textarea
              required
              rows={3}
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              placeholder="e.g. User prefers executing commands in PowerShell CLI instead of CMD."
              className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-xs focus:outline-none focus:border-accent resize-none"
            />
            <button
              type="submit"
              disabled={adding || !newMemory.trim()}
              className="w-full py-2 bg-accent hover:bg-accent-hover text-accent-contrast text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
            >
              {adding ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  Add Custom Fact
                </>
              )}
            </button>
          </form>

          {/* Semantic Search */}
          <form onSubmit={handleSearch} className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
            <div>
              <h3 className="font-semibold text-text text-sm">Semantic Search</h3>
              <p className="text-xs text-text-secondary">Query cognitive memories with natural language.</p>
            </div>
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories..."
                className="w-full pl-8 pr-3 py-2 bg-surface2 border border-border rounded text-text text-xs focus:outline-none focus:border-accent"
              />
              <Search className="w-3.5 h-3.5 text-text-muted absolute left-2.5 top-3" />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 py-1.5 bg-surface2 border border-border text-text text-xs rounded hover:bg-surface3 transition-colors"
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
                  className="px-3 py-1.5 bg-surface2 border border-border text-text-secondary hover:text-text text-xs rounded transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Right Side: Memories List */}
        <div className="md:col-span-2 space-y-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-4">
            <div>
              <h3 className="font-semibold text-text text-sm">Cognitive Memory Records ({memories.length})</h3>
              <p className="text-xs text-text-secondary">Facts extracted from past tasks and runs.</p>
            </div>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-accent" />
                <span className="text-xs text-text-secondary">Querying Memory Engine...</span>
              </div>
            ) : memories.length > 0 ? (
              <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                {memories.map((m) => (
                  <div
                    key={m.id}
                    className="p-3.5 bg-surface2 border border-border hover:border-border-light rounded-lg flex justify-between items-start gap-4 transition-all group"
                  >
                    <div className="flex gap-2.5 items-start">
                      <Brain className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                      <p className="text-xs text-text leading-relaxed">{m.memory}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteMemory(m.id)}
                      className="p-1.5 text-text-muted hover:text-error hover:bg-error-dim/20 rounded transition-colors md:opacity-0 group-hover:opacity-100 shrink-0"
                      title="Delete Fact"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 border border-dashed border-border rounded-lg gap-2 text-center px-4">
                <Brain className="w-8 h-8 text-text-muted animate-pulse" />
                <h4 className="font-semibold text-xs text-text mt-2">No Memories Found</h4>
                <p className="text-[11px] text-text-secondary max-w-xs mt-1">
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
