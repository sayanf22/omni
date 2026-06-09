import React, { useState, useEffect } from "react";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { ShieldAlert, Trash2, Shield, Calendar } from "lucide-react";

export const Security: React.FC = () => {
  const { audits, fetchLocalData } = useStore();
  const [confirmDelete, setConfirmDelete] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    fetchLocalData();
  }, [fetchLocalData]);

  const handleStopTasks = async () => {
    try {
      await invoke("cancel_task");
      setActionMessage({ text: "Emergency stop signal sent to ReAct runner.", success: true });
    } catch (e: any) {
      setActionMessage({ text: `Failed to stop tasks: ${e.message || e}`, success: false });
    }
  };

  const handleClearDb = async () => {
    if (confirm("Are you sure you want to clear the local database? This deletes all task logs and local settings, but preserves Supabase credentials.")) {
      try {
        await invoke("clear_all_local_data");
        await fetchLocalData();
        setActionMessage({ text: "Local task and settings data cleared successfully.", success: true });
      } catch (e: any) {
        setActionMessage({ text: `Failed to clear DB: ${e.message || e}`, success: false });
      }
    }
  };

  const handleDeleteAll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmDelete !== "DELETE") {
      setActionMessage({ text: "Wipe confirmation phrase was incorrect.", success: false });
      return;
    }

    try {
      // 1. Wipe SQLite
      await invoke("clear_all_local_data");
      // 2. Fetch and delete custom models & their keys
      const models = useStore.getState().models;
      for (const m of models) {
        await invoke("delete_custom_model", { id: m.id });
        await invoke("delete_api_key", { name: m.id });
      }
      // 3. Delete Supabase user token
      await invoke("delete_api_key", { name: "supabase_user_token" });

      setActionMessage({ text: "Entire system state and DPAPI keychain wiped.", success: true });
      setConfirmDelete("");
      setShowConfirm(false);
      
      // Reload page/state
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (e: any) {
      setActionMessage({ text: `Failed to delete all data: ${e.message || e}`, success: false });
    }
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-text">Security Center</h1>
        <p className="text-text-secondary text-sm">Control runtime permissions, view operational audits, and manage data privacy.</p>
      </div>

      {/* Message feedback */}
      {actionMessage && (
        <div className={`p-4 rounded-lg border text-xs font-semibold flex items-center gap-2 ${
          actionMessage.success 
            ? "bg-success/10 border-success/20 text-success" 
            : "bg-error-dim/20 border-error/30 text-error"
        }`}>
          <span>{actionMessage.success ? "✓" : "✗"}</span>
          <span>{actionMessage.text}</span>
        </div>
      )}

      {/* Top Section: Kill Switch */}
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-7 bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-2.5 text-error">
            <ShieldAlert className="w-5 h-5" />
            <h3 className="font-semibold text-text text-sm">Emergency Kill Switch</h3>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Immediately terminates the active ReAct planning thread and drops all mouse/keyboard hooks. You can also trigger this by double-pressing the <kbd className="px-1.5 py-0.5 bg-surface2 border border-border rounded text-text text-[10px] font-mono">Escape</kbd> key.
          </p>
          <button
            onClick={handleStopTasks}
            className="w-full py-3 bg-error hover:bg-error-dim text-text font-bold rounded-lg transition-colors text-sm"
          >
            STOP ALL RUNNING TASKS
          </button>
        </div>

        {/* Data Wiping */}
        <div className="col-span-5 bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm flex flex-col justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5 text-text-muted">
              <Trash2 className="w-5 h-5 text-text-secondary" />
              <h3 className="font-semibold text-text text-sm">System Data Purge</h3>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed">
              Remove execution records, settings, and purge credential keys from the Windows Credential Manager.
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleClearDb}
              className="flex-1 py-2 border border-border hover:border-border-light bg-surface2 text-text text-xs font-semibold rounded-md transition-colors"
            >
              Clear Task Logs
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="flex-1 py-2 bg-error-dim/30 hover:bg-error-dim/50 text-error border border-error/25 text-xs font-semibold rounded-md transition-colors"
            >
              Delete All Data
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog Overlay */}
      {showConfirm && (
        <div className="fixed inset-0 bg-bg/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="w-full max-w-md bg-surface border border-border rounded-xl p-6 space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-text">Confirm Destruction</h3>
            <p className="text-xs text-text-secondary leading-relaxed">
              This action will permanently delete all task histories, local sqlite tables, custom provider connections, and remove all encrypted api keys from your Windows Keychain.
            </p>
            <form onSubmit={handleDeleteAll} className="space-y-3">
              <label className="block text-[10px] font-bold text-text-secondary uppercase tracking-wider">
                Type "DELETE" below to confirm:
              </label>
              <input
                type="text"
                required
                value={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.value)}
                placeholder="DELETE"
                className="w-full px-3 py-2 bg-surface2 border border-border rounded text-text text-sm focus:outline-none focus:border-error font-semibold text-center"
              />
              <div className="flex gap-3 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => { setShowConfirm(false); setConfirmDelete(""); }}
                  className="px-4 py-2 border border-border bg-surface2 text-text text-xs font-semibold rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={confirmDelete !== "DELETE"}
                  className="px-4 py-2 bg-error text-text text-xs font-bold rounded-md transition-colors disabled:opacity-40"
                >
                  Confirm Wiping
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Audit Log Table */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-2.5 text-accent">
          <Shield className="w-5 h-5" />
          <div>
            <h3 className="font-semibold text-text text-sm">Security Audit Trail</h3>
            <p className="text-xs text-text-secondary">Last 50 recorded security-sensitive operations.</p>
          </div>
        </div>

        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto max-h-60">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-surface2 border-b border-border text-text-muted font-bold">
                  <th className="p-3">Timestamp</th>
                  <th className="p-3">Action Type</th>
                  <th className="p-3">Tool Call</th>
                  <th className="p-3">Target Application</th>
                  <th className="p-3">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-text-secondary">
                {audits.map((entry) => (
                  <tr key={entry.id} className="hover:bg-surface2/25">
                    <td className="p-3 whitespace-nowrap flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-text-muted" /> {new Date(entry.created_at).toLocaleString()}</td>
                    <td className="p-3 font-semibold uppercase text-text">{entry.action_type}</td>
                    <td className="p-3 font-mono text-accent">{entry.tool_name || "N/A"}</td>
                    <td className="p-3 font-mono">{entry.app_name || "N/A"}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        entry.outcome === "success" ? "bg-success/10 text-success border border-success/20" :
                        "bg-error-dim/20 text-error border border-error/20"
                      }`}>
                        {entry.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
                {audits.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-text-muted">No security logs recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
