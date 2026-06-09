# Omni — AI Brain (Complete Specification)

## How It Thinks

Omni uses a **ReAct loop** (Reason → Act → Observe → Repeat) to orchestrate tasks.

---

## Dynamic AI Model Strategy

Instead of hardcoded endpoints, Omni allows users to configure their own models, endpoints, and API keys directly from their dashboard. Configure as many models/providers as desired, selecting which ones to use for specific agent roles:

### 1. Model Roles
*   **Vision / Primary:** Used for reading screenshots, navigating coordinates, and general decision making. (Must support vision/image input).
*   **Coding:** Used when tasks involve coding keywords (e.g. `VS Code`, `git`, `rust`, `python`, `terminal`).
*   **Writing:** Used for pure text generation tasks (e.g. `write`, `email`, `post`, `linkedin`, `blog`).

### 2. Supported Provider Types
*   **OpenAI:** Standard OpenAI API endpoints (`https://api.openai.com/v1`).
*   **Anthropic:** Anthropic Messages API (`https://api.anthropic.com/v1`).
*   **OpenRouter:** Compatible completions API (`https://openrouter.ai/api/v1`).
*   **DeepSeek:** Official DeepSeek API (`https://api.deepseek.com/v1`).
*   **Custom:** Any OpenAI-compatible proxy or local server (e.g., LM Studio, Ollama).

---

## Routing & Fallback Logic

When a task begins, Omni determines the task context:
1.  **Context Detection:**
    *   If task includes coding keywords (e.g., `code`, `function`, `git`, `vscode`, `npm`, `cargo`) → routed to the model marked for **Coding**.
    *   If task is pure text writing (e.g., `write`, `email`, `post`, `blog`) → routed to the model marked for **Writing**.
    *   Otherwise (most tasks) → routed to the model marked for **Vision / Primary**.
2.  **Fallback Chain:**
    *   If the preferred model/key is missing or fails, Omni falls back to the **Vision / Primary** model.
    *   If no custom model is configured, Omni falls back to checking the default keys (`supabase_user_token` or default environment variables) or alerts the user to configure a model.

---

## Storage & Security Schema

### SQLite Table (`custom_models`)
Stores metadata about the user's custom models:
```sql
CREATE TABLE IF NOT EXISTS custom_models (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,      -- 'openai' | 'anthropic' | 'openrouter' | 'deepseek' | 'custom'
    model_name TEXT NOT NULL,         -- e.g., 'gpt-4o', 'claude-3-5-sonnet', 'deepseek-chat'
    display_name TEXT NOT NULL,
    base_url TEXT,                    -- e.g., 'https://openrouter.ai/api/v1'
    role_vision INTEGER DEFAULT 0,    -- 1 = preferred Vision model
    role_coding INTEGER DEFAULT 0,    -- 1 = preferred Coding model
    role_writing INTEGER DEFAULT 0,   -- 1 = preferred Writing model
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
```

### Credentials Manager (DPAPI)
Custom API keys are **never** stored in the database tables or logged. When a model with ID `{model_id}` is saved, its API key is written to the Windows Credential Manager under the target name:
`Omni/keys/{model_id}`

---

## ReAct Loop System Prompt

```
You are Omni, an AI agent controlling a Windows computer.
You see the current screen in the screenshot provided.

What you know about this user:
{memories}

Available tools:
{tools_json_schema}

Rules:
- Think step by step. Use minimum steps needed.
- After each tool call you will receive a new screenshot.
- For DELETE or SEND/EXECUTE actions: output {"question":"..."} to ask user first.
- For everything else: just do it without asking.
- Stop at 20 steps maximum.
- When done: output {"done":true, "result":"brief summary"}
- Respond ONLY in valid JSON. No markdown. No explanation outside JSON.

Valid response formats:
{"thought":"...","tool":"name","params":{...}}
{"done":true,"result":"..."}
{"question":"..."}
```