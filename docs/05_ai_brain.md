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
*   **Reasoning (automatic):** Not a stored role — chosen automatically. When a task is detected as multi-step / analytical (keywords like `analyze`, `compare`, `diagnose`, `why`, `solve`, `optimize`, `step by step`), Omni routes it to the strongest **reasoning-capable** model among the active models (detected by name: OpenAI o1/o3/o4 & GPT-5, DeepSeek R1/Reasoner, Claude 3.7 / 4 extended-thinking tiers, Qwen QwQ, Gemini thinking, Magistral, etc.). This means a "basic" key handles basic tasks while reasoning work is sent to a reasoning model — with no extra configuration required.

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
    *   If the task is multi-step / analytical (e.g., `analyze`, `compare`, `diagnose`, `why`, `solve`, `optimize`, `step by step`) → routed to the best **Reasoning-capable** active model. Falls back to Coding → Writing → Vision when no reasoning model is configured.
    *   If task includes coding keywords (e.g., `code`, `function`, `git`, `vscode`, `npm`, `cargo`) → routed to the model marked for **Coding**.
    *   If task is pure text writing (e.g., `write`, `email`, `post`, `blog`) → routed to the model marked for **Writing**.
    *   Otherwise (most tasks) → routed to the model marked for **Vision / Primary**.
2.  **Fallback Chain:**
    *   Each role falls back through related roles and finally to **any active model**, so a single-model setup always works.
    *   If no custom model is configured at all, Omni alerts the user to configure a model in Settings.
3.  **Reasoning-model detection:** implemented in `model_is_reasoning()` (`src-tauri/src/ai/client.rs`) using well-known model-name fragments per provider; routing is wired in `resolve_active_model()` (`src-tauri/src/ai/mod.rs`).

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

The live system prompt (built in `src-tauri/src/agent/planner.rs`) gives the agent a
strict "brain" focused on following the user's exact task. Key directives:

```
You are Omni, an autonomous Windows desktop automation agent. You control a REAL PC.

[VISION or NO-VISION perception instructions, chosen at runtime]
[reasoning-model note, if running on a reasoning model]

MISSION RULES (read every time):
1. STAY ON THE EXACT TASK — do only what was asked; never substitute a different app/site/goal.
2. NEVER send messages/posts/emails to anyone unless explicitly asked (reading is the default).
3. PLAN FIRST — sequence the concrete steps before acting.
4. OBSERVE BEFORE ACTING — confirm the right window/element (screenshot or ocr/ui_tree); focus the correct app first.
5. VERIFY AFTER ACTING — check the tool result; adapt instead of blindly repeating.
6. ALWAYS use tools to perform actions; never just describe.
7. ASK before irreversible/destructive actions via {"question":"..."}.
8. To ANSWER a question, gather info with tools then finish with the answer in "result".
9. Use the minimum steps; stop at 20.
10. Finish with {"done":true,"result":"the answer / what you accomplished"}.
11. Respond with ONE valid JSON object only.

+ Worked examples for opening a website (Ctrl+L → type URL → Enter → read) and typing into apps.

Valid response formats:
{"thought":"...","tool":"name","params":{...}}
{"done":true,"result":"..."}
{"question":"..."}
```

Memories (from Mem0) and user-defined **custom skills** (from the Skills page,
stored in SQLite `custom_skills_json`) are appended to the prompt so the agent
keeps the user's preferences and past context in mind on every task.

---

## Human-like Input

Mouse movement uses the **WindMouse** algorithm (`human_move()` in
`src-tauri/src/automation/input.rs`) — gravity + wind forces produce a natural,
curved path with subtle jitter and variable speed instead of a dead-straight,
instantaneous jump. All clicks (`click`, `right_click`, `double_click`) and the
`move` action glide to the target first, then act, so automation looks organic
while staying fast (sub-second). The final landing snaps exactly onto the target
for precision.
