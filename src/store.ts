import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Task {
  id: string;
  description: string;
  status: string;
  steps_json: string;
  outcome: string | null;
  created_at: string;
  synced_at: string | null;
}

export interface AuditEntry {
  id: string;
  action_type: string;
  tool_name: string | null;
  app_name: string | null;
  outcome: string;
  created_at: string;
}

export interface CustomModel {
  id: string;
  provider_type: string;
  model_name: string;
  display_name: string;
  base_url: string | null;
  role_vision: boolean;
  role_coding: boolean;
  role_writing: boolean;
  is_active: boolean;
}

interface AppState {
  session: any | null;
  tasks: Task[];
  audits: AuditEntry[];
  models: CustomModel[];
  isLoading: boolean;
  theme: "dark" | "light";
  
  setSession: (session: any) => void;
  fetchLocalData: () => Promise<void>;
  addCustomModel: (model: Omit<CustomModel, "id">, apiKey: string) => Promise<void>;
  deleteCustomModel: (id: string) => Promise<void>;
  testModel: (provider: string, model: string, baseUrl: string | null, apiKey: string) => Promise<string>;
  syncLocalToCloud: () => Promise<void>;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
}

const getInitialTheme = (): "dark" | "light" => {
  const saved = localStorage.getItem("omni_theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
    return saved;
  }
  document.documentElement.setAttribute("data-theme", "dark");
  return "dark";
};

export const useStore = create<AppState>((set, get) => ({
  session: null,
  tasks: [],
  audits: [],
  models: [],
  isLoading: false,
  theme: getInitialTheme(),

  setTheme: (theme) => {
    set({ theme });
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("omni_theme", theme);
  },

  toggleTheme: () => {
    const nextTheme = get().theme === "dark" ? "light" : "dark";
    get().setTheme(nextTheme);
  },

  setSession: (session) => {
    set({ session });
    if (session) {
      // Store user token in keychain
      invoke("save_api_key", { name: "supabase_user_token", value: session.access_token }).catch(console.error);
    } else {
      invoke("delete_api_key", { name: "supabase_user_token" }).catch(console.error);
    }
  },

  fetchLocalData: async () => {
    set({ isLoading: true });
    try {
      const tasks = await invoke<Task[]>("get_recent_tasks", { limit: 50 });
      const audits = await invoke<AuditEntry[]>("get_audit_log", { limit: 50 });
      const models = await invoke<CustomModel[]>("get_custom_models");
      set({ tasks, audits, models, isLoading: false });
    } catch (e) {
      console.error("Failed to fetch local database data", e);
      set({ isLoading: false });
    }
  },

  addCustomModel: async (modelData, apiKey) => {
    const id = crypto.randomUUID();
    const newModel: CustomModel = {
      ...modelData,
      id,
    };
    
    // Save model details to SQLite (backend will automatically handle cloud sync)
    await invoke("save_custom_model", { model: newModel });
    
    // Save API key to Keychain
    await invoke("save_api_key", { name: id, value: apiKey });
    
    await get().fetchLocalData();
  },

  deleteCustomModel: async (id) => {
    // Delete from SQLite (backend will automatically handle cloud delete)
    await invoke("delete_custom_model", { id });
    await invoke("delete_api_key", { name: id });

    await get().fetchLocalData();
  },

  testModel: async (provider_type, model_name, base_url, api_key) => {
    return await invoke<string>("test_model_connection", {
      providerType: provider_type,
      modelName: model_name,
      baseUrl: base_url,
      apiKey: api_key
    });
  },

  syncLocalToCloud: async () => {
    const session = get().session;
    if (!session) return;

    try {
      // Run the secure backend database sync engine
      await invoke("sync_local_to_cloud");
      await get().fetchLocalData();
    } catch (e) {
      console.error("Sync process failed", e);
    }
  }
}));
