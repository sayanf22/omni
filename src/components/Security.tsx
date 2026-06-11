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
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-4xl font-black text-text">Security Center</h1>
        <p className="text-text-secondary text-[16px] mt-2">Control runtime permissions, view operational audits, and manage data privacy.</p>
      </div>

      {/* Message feedback */}
      {actionMessage && (
        <div className={`p-5 rounded-2xl border text-sm font-extrabold flex items-center gap-2.5 shadow-sm ${
          actionMessage.success 
            ? "bg-success/10 border-success/20 text-success" 
            : "bg-error-dim/20 border-error/30 text-error"
        }`}>
          <span>{actionMessage.success ? "✓" : "✗"}</span>
          <span>{actionMessage.text}</span>
        </div>
      )}

      {/* Top Section: Kill Switch */}
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-7 premium-card p-7 space-y-5 shadow-md">
          <div className="flex items-center gap-3 text-error">
            <ShieldAlert className="w-6 h-6" />
            <h3 className="font-extrabold text-text text-base">Emergency Kill Switch</h3>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed">
            Immediately terminates the active ReAct planning thread and drops all mouse/keyboard hooks. You can also trigger this by double-pressing the <kbd className="px-2 py-1 bg-surface2 border border-border rounded-lg text-text text-xs font-mono">Escape</kbd> key.
          </p>
          <button
            onClick={handleStopTasks}
            className="w-full py-4 bg-error hover:bg-error-dim text-text font-black rounded-xl transition-colors text-sm shadow-sm tracking-wide"
          >
            STOP ALL RUNNING TASKS
          </button>
        </div>

        {/* Data Wiping */}
        <div className="col-span-5 premium-card p-7 space-y-5 shadow-md flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-text-muted">
              <Trash2 className="w-6 h-6 text-text-secondary" />
              <h3 className="font-extrabold text-text text-base">System Data Purge</h3>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">
              Remove execution records, settings, and purge credential keys from the Windows Credential Manager.
            </p>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              onClick={handleClearDb}
              className="flex-1 py-3 border border-border hover:border-border-light bg-surface2 text-text text-sm font-extrabold rounded-xl transition-colors shadow-sm"
            >
              Clear Task Logs
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="flex-1 py-3 bg-error-dim/30 hover:bg-error-dim/50 text-error border border-error/25 text-sm font-extrabold rounded-xl transition-colors shadow-sm"
            >
              Delete All Data
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog Overlay */}
      {showConfirm && (
        <div className="fixed inset-0 bg-bg/80 backdrop-blur-sm z-50 flex items-center justify-center p-6 animate-fade-in">
          <div className="w-full max-w-lg bg-surface border border-border rounded-[28px] p-8 space-y-5 shadow-2xl">
            <h3 className="text-lg font-black text-text">Confirm Destruction</h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              This action will permanently delete all task histories, local sqlite tables, custom provider connections, and remove all encrypted api keys from your Windows Keychain.
            </p>
            <form onSubmit={handleDeleteAll} className="space-y-4">
              <label className="block text-xs font-bold text-text-secondary uppercase tracking-wider">
                Type "DELETE" below to confirm:
              </label>
              <input
                type="text"
                required
                value={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.value)}
                placeholder="DELETE"
                className="w-full px-4 py-3 bg-surface2 border border-border rounded-xl text-text text-sm focus:outline-none focus:border-error font-extrabold text-center placeholder:text-text-muted"
              />
              <div className="flex gap-3 justify-end pt-3">
                <button
                  type="button"
                  onClick={() => { setShowConfirm(false); setConfirmDelete(""); }}
                  className="px-5 py-2.5 border border-border bg-surface2 text-text text-sm font-extrabold rounded-xl transition-colors shadow-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={confirmDelete !== "DELETE"}
                  className="px-5 py-2.5 bg-error text-text text-sm font-black rounded-xl transition-colors disabled:opacity-40 shadow-sm"
                >
                  Confirm Wiping
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Audit Log Table */}
      <div className="premium-card p-7 space-y-5 shadow-md">
        <div className="flex items-center gap-3 text-accent">
          <Shield className="w-6 h-6" />
          <div>
            <h3 className="font-extrabold text-text text-base">Security Audit Trail</h3>
            <p className="text-sm text-text-secondary mt-1">Last 50 recorded security-sensitive operations.</p>
          </div>
        </div>

        <div className="border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="bg-surface2 border-b border-border text-text-secondary font-black">
                  <th className="p-4.5">Timestamp</th>
                  <th className="p-4.5">Action Type</th>
                  <th className="p-4.5">Tool Call</th>
                  <th className="p-4.5">Target Application</th>
                  <th className="p-4.5">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-text-secondary font-semibold">
                {audits.map((entry) => (
                  <tr key={entry.id} className="hover:bg-surface2/25">
                    <td className="p-4.5 whitespace-nowrap flex items-center gap-2"><Calendar className="w-4 h-4 text-text-muted" /> {new Date(entry.created_at).toLocaleString()}</td>
                    <td className="p-4.5 font-bold uppercase text-text">{entry.action_type}</td>
                    <td className="p-4.5 font-mono text-accent">{entry.tool_name || "N/A"}</td>
                    <td className="p-4.5 font-mono">{entry.app_name || "N/A"}</td>
                    <td className="p-4.5">
                      <span className={`px-2.5 py-1 rounded-xl text-[10.5px] font-black uppercase border ${
                        entry.outcome === "success" ? "bg-success/10 text-success border-success/20" :
                        "bg-error-dim/20 text-error border-error/20"
                      }`}>
                        {entry.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
                {audits.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-text-muted">No security logs recorded.</td>
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
