use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use serde::{Serialize, Deserialize};
use serde_json::Value;
use crate::tools::{get_all_tools, RiskLevel};
use crate::ai::{detect_task_type, call_ai_chat, ChatMessage};
use crate::storage::sqlite::{save_task, Task, save_audit, AuditEntry};
use crate::security::permissions::{get_permission_gate, PendingApproval};

use std::sync::OnceLock;
use std::sync::Arc;
use tokio::sync::Notify;

/// Maximum ReAct steps before the agent gives up.
const MAX_STEPS: u32 = 20;

fn max_steps_const() -> u32 { MAX_STEPS }

// ── Cancel infrastructure ────────────────────────────────────────────────────

fn get_cancel_flag() -> &'static AtomicBool {
    static CANCEL_FLAG: OnceLock<AtomicBool> = OnceLock::new();
    CANCEL_FLAG.get_or_init(|| AtomicBool::new(false))
}

fn get_cancel_notify() -> &'static Arc<Notify> {
    static NOTIFY: OnceLock<Arc<Notify>> = OnceLock::new();
    NOTIFY.get_or_init(|| Arc::new(Notify::new()))
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepProgress {
    pub step_num: u32,
    pub thought: String,
    pub tool: Option<String>,
    pub description: String,
    pub success: bool,
}

/// Spawn the task in a background Tokio task and return the task_id immediately.
/// This prevents IPC timeout and allows the app to work when the window is hidden.
#[tauri::command]
pub async fn run_task(
    instruction: String,
    user_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Reset cancel flag + notify any waiting selector
    get_cancel_flag().store(false, Ordering::SeqCst);

    // Resolve user_id
    let resolved_user_id = if user_id.is_empty() {
        crate::storage::keychain::get_key("supabase_user_id")
            .ok().flatten()
            .unwrap_or_else(|| "local-user".to_string())
    } else {
        user_id
    };

    let task_id = uuid::Uuid::new_v4().to_string();

    // ▶ Spawn task in background — return task_id immediately to frontend
    let app_clone = app.clone();
    let task_id_clone = task_id.clone();
    let instruction_clone = instruction.clone();
    let user_id_clone = resolved_user_id;

    tauri::async_runtime::spawn(async move {
        execute_task(instruction_clone, user_id_clone, task_id_clone, app_clone).await;
    });

    Ok(task_id)
}

#[tauri::command]
pub fn cancel_task() -> Result<(), String> {
    get_cancel_flag().store(true, Ordering::SeqCst);
    // Wake up any tokio::select! waiting on the cancel notifier
    get_cancel_notify().notify_waiters();
    Ok(())
}

// ── Core execution loop ───────────────────────────────────────────────────────

/// Runs inside a background Tokio task — never blocks IPC.
async fn execute_task(instruction: String, user_id: String, task_id: String, app: tauri::AppHandle) {
    let now = chrono::Utc::now().to_rfc3339();

    // Save initial task record
    let initial_task = Task {
        id: task_id.clone(),
        description: instruction.clone(),
        status: "running".to_string(),
        steps_json: "[]".to_string(),
        outcome: None,
        created_at: now.clone(),
        synced_at: None,
    };
    if let Err(e) = save_task(&initial_task) {
        let _ = app.emit("task:failed", serde_json::json!({
            "task_id": task_id,
            "error": format!("DB error: {}", e)
        }));
        return;
    }

    let _ = app.emit("task:started", serde_json::json!({
        "task_id": task_id.clone(),
        "instruction": instruction.clone()
    }));

    // Determine task type + check vision availability
    let task_type = detect_task_type(&instruction);
    let tools = get_all_tools();

    // Resolve the model that will actually run this task (capability-aware
    // routing — reasoning models for analytical work, role models otherwise).
    let resolved_model = crate::ai::resolve_active_model(task_type).ok().flatten();
    let vision_available = resolved_model
        .as_ref()
        .map_or(false, |m| crate::ai::client::model_supports_vision(m));
    let reasoning_model = resolved_model
        .as_ref()
        .map_or(false, |m| crate::ai::client::model_is_reasoning(m));

    // Build tools description for system prompt
    let mut tools_desc = Vec::new();
    for (name, t) in &tools {
        tools_desc.push(serde_json::json!({
            "name": name,
            "description": t.description(),
            "params_schema": t.params_schema()
        }));
    }

    let screen_context = if vision_available {
        "VISION ON: A screenshot is attached to every AI message. READ IT before every action.\n\
         Find the EXACT UI element (by position/label/icon) before clicking. After each action, \
         check the new screenshot to confirm the result. If the expected change didn't happen, adapt."
    } else {
        "VISION OFF: Use tools to perceive the screen:\n\
         - screen ocr       : read ALL visible text.\n\
         - screen find_text : get exact {x,y} of a text string (ALWAYS do this before clicking).\n\
         - screen ui_tree   : accessibility tree with element names + coordinates.\n\
         RULE: Never guess coordinates. Always call ocr or find_text first."
    };

    let reasoning_note = if reasoning_model {
        "\nReasoning model active. Think carefully but keep the JSON 'thought' to ONE brief sentence.\n"
    } else {
        ""
    };

    // Build the production-grade system prompt.
    // Use raw string to avoid escaping hell with special characters.
    // Named arguments: screen_context, reasoning_note, tools, max_steps.
    let prompt_tools = serde_json::to_string_pretty(&tools_desc).unwrap_or_default();
    let max_s = max_steps_const();

    let mut system_prompt = format!(
        "You are Omni, an autonomous Windows desktop agent. You control a REAL PC.\n\
         {sc}\n{rn}\n\
         \n== AVAILABLE TOOLS ==\n{tools}\n\n\
         == CORE RULES (re-read every step) ==\n\
         1. DO EXACTLY WHAT THE USER ASKED. Nothing more, nothing less.\n\
            Never substitute a different app, website, or goal. If the user says\n\
            'open YouTube' - go to youtube.com. 'read my LinkedIn bio' - open browser, navigate to\n\
            linkedin.com, OCR the bio, report it. Do NOT open Kiro, a chat, an IDE, or anything unrelated.\n\
         2. NEVER send, post, type messages to anyone unless the task explicitly says to.\n\
            Reading/looking is the default. Writing/sending needs an explicit instruction.\n\
         3. GROUND YOURSELF BEFORE EVERY CLICK.\n\
            Confirm the target element is visible and the correct window is focused.\n\
            Never guess coordinates. Use find_text, ui_tree, or screenshot first.\n\
         4. WAIT FOR PAGES/APPS TO LOAD.\n\
            After opening a URL or clicking a link: use app wait ms=2500 (or more for slow pages).\n\
            Then OCR or screenshot to confirm the page loaded before continuing.\n\
         5. VERIFY THEN ADAPT.\n\
            After each tool call check the result. If the expected state was not reached:\n\
            a) Try an alternative approach (different click, keyboard shortcut).\n\
            b) If loading - wait and retry once.\n\
            c) Never repeat the exact same failed action more than twice - find a new path.\n\
         6. ASK BEFORE DESTRUCTIVE ACTIONS.\n\
            Any action that sends, posts, deletes, purchases, or is irreversible:\n\
            output {{\"question\":\"Confirm: <exact action>?\"}} and wait for user approval.\n\
         7. ANSWER WITH REAL DATA.\n\
            If the user asks 'read X and tell me' - gather info with tools, put the ACTUAL content\n\
            in the result field. Do not say 'task complete' without the answer.\n\
         8. Maximum {max_s} steps. Be efficient.\n\
         9. ONE valid JSON object per response. No markdown, no prose outside the JSON.\n\
         \n\
         == UNIVERSAL NAVIGATION ==\n\
         OPEN ANY WEBSITE (fastest):\n\
           {{\"tool\":\"app\",\"params\":{{\"action\":\"open_url\",\"url\":\"https://example.com\"}}}}\n\
           {{\"tool\":\"app\",\"params\":{{\"action\":\"wait\",\"ms\":2500}}}}\n\
           {{\"tool\":\"screen\",\"params\":{{\"action\":\"ocr\"}}}}  <- read it\n\
         \n\
         OPEN WEBSITE via browser address bar:\n\
           open chrome/msedge -> hotkey ctrl+l -> type URL -> key enter -> wait 2500 -> ocr\n\
         \n\
         CLICK ELEMENT (no vision):\n\
           find_text query='Sign in' -> get {{x,y}} -> mouse click x,y\n\
         \n\
         SEARCH ON A WEBSITE (Google/YouTube/Amazon/etc):\n\
           open_url -> wait -> find_text on search box -> click it -> type query -> key enter -> wait -> ocr\n\
         \n\
         SCROLL AND READ MORE:\n\
           mouse scroll direction=down amount=5 -> ocr again\n\
         \n\
         TYPE INTO FORM FIELD:\n\
           click the field first -> keyboard type\n\
         \n\
         OPEN DESKTOP APP:\n\
           app open name=notepad  (or word, excel, vlc, explorer, cmd, etc.)\n\
         \n\
         == WORKED EXAMPLES ==\n\
         TASK: 'open notepad and write Hello World'\n\
           1 {{\"thought\":\"Open Notepad\",\"tool\":\"app\",\"params\":{{\"action\":\"open\",\"name\":\"notepad\"}}}}\n\
           2 {{\"thought\":\"Type\",\"tool\":\"keyboard\",\"params\":{{\"action\":\"type\",\"text\":\"Hello World\"}}}}\n\
           3 {{\"done\":true,\"result\":\"Wrote 'Hello World' in Notepad\"}}\n\
         \n\
         TASK: 'go to youtube trending and tell me the top video'\n\
           1 {{\"thought\":\"Open YouTube trending\",\"tool\":\"app\",\"params\":{{\"action\":\"open_url\",\"url\":\"https://www.youtube.com/feed/trending\"}}}}\n\
           2 {{\"thought\":\"Wait for load\",\"tool\":\"app\",\"params\":{{\"action\":\"wait\",\"ms\":3000}}}}\n\
           3 {{\"thought\":\"Read page\",\"tool\":\"screen\",\"params\":{{\"action\":\"ocr\"}}}}\n\
           4 {{\"done\":true,\"result\":\"Top trending video: <title from OCR>\"}}\n\
         \n\
         TASK: 'search google for best pizza and tell me the first result'\n\
           1 {{\"thought\":\"Open Google\",\"tool\":\"app\",\"params\":{{\"action\":\"open_url\",\"url\":\"https://www.google.com\"}}}}\n\
           2 {{\"thought\":\"Wait\",\"tool\":\"app\",\"params\":{{\"action\":\"wait\",\"ms\":2000}}}}\n\
           3 {{\"thought\":\"Find search box\",\"tool\":\"screen\",\"params\":{{\"action\":\"find_text\",\"query\":\"Search\"}}}}\n\
           4 {{\"thought\":\"Click search\",\"tool\":\"mouse\",\"params\":{{\"action\":\"click\",\"x\":960,\"y\":450}}}}\n\
           5 {{\"thought\":\"Type query\",\"tool\":\"keyboard\",\"params\":{{\"action\":\"type\",\"text\":\"best pizza\"}}}}\n\
           6 {{\"thought\":\"Submit\",\"tool\":\"keyboard\",\"params\":{{\"action\":\"key\",\"key\":\"enter\"}}}}\n\
           7 {{\"thought\":\"Wait for results\",\"tool\":\"app\",\"params\":{{\"action\":\"wait\",\"ms\":2000}}}}\n\
           8 {{\"thought\":\"Read results\",\"tool\":\"screen\",\"params\":{{\"action\":\"ocr\"}}}}\n\
           9 {{\"done\":true,\"result\":\"First result: <from OCR>\"}}\n\
         \n\
         TASK: 'open LinkedIn and read my bio'\n\
           1 {{\"thought\":\"Open LinkedIn\",\"tool\":\"app\",\"params\":{{\"action\":\"open_url\",\"url\":\"https://www.linkedin.com\"}}}}\n\
           2 {{\"thought\":\"Wait\",\"tool\":\"app\",\"params\":{{\"action\":\"wait\",\"ms\":3000}}}}\n\
           3 {{\"thought\":\"Read page\",\"tool\":\"screen\",\"params\":{{\"action\":\"ocr\"}}}}\n\
           4 {{\"done\":true,\"result\":\"Your bio reads: <bio text from OCR>\"}}\n\
         \n\
         == VALID RESPONSE FORMATS ==\n\
         Tool call : {{\"thought\":\"one line why\",\"tool\":\"name\",\"params\":{{...}}}}\n\
         Done      : {{\"done\":true,\"result\":\"actual answer or summary\"}}\n\
         Question  : {{\"question\":\"Confirm: are you sure you want to <action>?\"}}",
        sc = screen_context,
        rn = reasoning_note,
        tools = prompt_tools,
        max_s = max_s,
    );

    // Fetch relevant memories
    if let Some(memories) = crate::ai::memory::fetch_mem0_memories(&instruction, &user_id).await {
        system_prompt.push_str(&format!("\n\nRelevant context from past tasks:\n{}", memories));
    }

    // Inject user-defined custom skills (written in the Skills page)
    if let Ok(Some(skills_json)) = crate::storage::sqlite::get_setting_internal("custom_skills_json") {
        if let Ok(skills) = serde_json::from_str::<Vec<serde_json::Value>>(&skills_json) {
            if !skills.is_empty() {
                let mut skill_text = String::from("\n\nUser-defined skills and preferences (ALWAYS follow these):\n");
                for skill in &skills {
                    if let (Some(name), Some(instructions)) = (skill["name"].as_str(), skill["instructions"].as_str()) {
                        skill_text.push_str(&format!("• {}: {}\n", name, instructions));
                    }
                }
                system_prompt.push_str(&skill_text);
            }
        }
    }

    let mut messages = vec![
        ChatMessage { role: "system".to_string(), content: system_prompt },
        ChatMessage { role: "user".to_string(), content: format!("Task: {}", instruction) },
    ];

    let mut step_num = 1u32;
    let max_steps = MAX_STEPS;
    let mut steps_log: Vec<StepProgress> = Vec::new();
    let mut final_outcome = String::from("Task completed.");
    let mut final_status = String::from("completed");

    'main: while step_num <= max_steps {
        // ── Check cancel flag ───────────────────────────────────────────────
        if get_cancel_flag().load(Ordering::SeqCst) {
            final_status = "cancelled".to_string();
            final_outcome = "Task cancelled by user.".to_string();
            let _ = app.emit("agent:killed", serde_json::json!({}));
            break;
        }

        // ── Take screenshot (only if model supports vision) ─────────────────
        let screenshot_base64 = if vision_available {
            match crate::automation::screen::capture_full_screen() {
                Ok(b64) => Some(b64),
                Err(e) => { tracing::warn!("Screenshot failed: {}", e); None }
            }
        } else {
            None
        };

        // ── Call AI — with cancel support ────────────────────────────────────
        let cancel_notify = get_cancel_notify().clone();
        let ai_fut = call_ai_chat(task_type, messages.clone(), screenshot_base64.clone());

        let ai_response = tokio::select! {
            result = ai_fut => {
                match result {
                    Ok(r) => r,
                    Err(e) => {
                        final_status = "failed".to_string();
                        final_outcome = format!("AI error: {}", e);
                        let _ = app.emit("task:failed", serde_json::json!({
                            "task_id": task_id.clone(),
                            "error": final_outcome.clone(),
                            "step_num": step_num
                        }));
                        break 'main;
                    }
                }
            },
            _ = cancel_notify.notified() => {
                final_status = "cancelled".to_string();
                final_outcome = "Task cancelled during AI call.".to_string();
                let _ = app.emit("agent:killed", serde_json::json!({}));
                break 'main;
            }
        };

        // ── Parse AI response ────────────────────────────────────────────────
        let parsed: Value = {
            // Try direct parse first
            let r1 = serde_json::from_str::<Value>(&ai_response);
            match r1 {
                Ok(v) => v,
                Err(_) => {
                    // Try stripping markdown code fences
                    let clean = ai_response.trim()
                        .trim_start_matches("```json").trim_start_matches("```")
                        .trim_end_matches("```").trim();
                    match serde_json::from_str::<Value>(clean) {
                        Ok(v) => v,
                        Err(e) => {
                            // One final attempt: find JSON object in the response
                            if let Some(start) = ai_response.find('{') {
                                if let Some(end) = ai_response.rfind('}') {
                                    if let Ok(v) = serde_json::from_str::<Value>(&ai_response[start..=end]) {
                                        v
                                    } else {
                                        final_status = "failed".to_string();
                                        final_outcome = format!("AI returned invalid JSON: {}", e);
                                        let _ = app.emit("task:failed", serde_json::json!({
                                            "task_id": task_id.clone(),
                                            "error": final_outcome.clone()
                                        }));
                                        break 'main;
                                    }
                                } else {
                                    final_status = "failed".to_string();
                                    final_outcome = format!("AI returned invalid JSON: {}", e);
                                    let _ = app.emit("task:failed", serde_json::json!({
                                        "task_id": task_id.clone(),
                                        "error": final_outcome.clone()
                                    }));
                                    break 'main;
                                }
                            } else {
                                final_status = "failed".to_string();
                                final_outcome = format!("AI returned non-JSON: {}", ai_response);
                                let _ = app.emit("task:failed", serde_json::json!({
                                    "task_id": task_id.clone(),
                                    "error": final_outcome.clone()
                                }));
                                break 'main;
                            }
                        }
                    }
                }
            }
        };

        // ── Case 1: Done ────────────────────────────────────────────────────
        if parsed["done"].as_bool().unwrap_or(false) {
            let result_str = parsed["result"].as_str().unwrap_or("Done").to_string();
            final_outcome = result_str.clone();
            steps_log.push(StepProgress {
                step_num, thought: "Task completed.".to_string(),
                tool: None, description: result_str.clone(), success: true,
            });
            let _ = app.emit("task:step", serde_json::json!({
                "step_num": step_num, "thought": "Task completed.",
                "tool": null, "description": result_str, "success": true
            }));
            break 'main;
        }

        // ── Case 2: Question ────────────────────────────────────────────────
        if let Some(question) = parsed["question"].as_str() {
            let _ = app.emit("task:step", serde_json::json!({
                "step_num": step_num, "thought": "Waiting for user input.",
                "tool": null, "description": question, "success": true
            }));
            let approval_req = PendingApproval {
                id: uuid::Uuid::new_v4().to_string(),
                tool: "question".to_string(), action: "ask".to_string(),
                description: question.to_string(), preview: None,
            };
            let approved = get_permission_gate().request_approval(approval_req, &app).await;
            if !approved {
                final_status = "cancelled".to_string();
                final_outcome = "User declined to proceed.".to_string();
                break 'main;
            }
            messages.push(ChatMessage { role: "assistant".to_string(), content: ai_response });
            messages.push(ChatMessage { role: "user".to_string(), content: "Proceed.".to_string() });
            step_num += 1;
            continue 'main;
        }

        // ── Case 3: Tool Call ────────────────────────────────────────────────
        let tool_name = parsed["tool"].as_str();
        let tool_params = parsed["params"].clone();
        let thought = parsed["thought"].as_str().unwrap_or("Executing step.").to_string();

        if let Some(name) = tool_name {
            if let Some(tool) = tools.get(name) {
                let risk = tool.risk_level(&tool_params);

                // Permission gate for high-risk actions
                let mut granted = true;
                if risk == RiskLevel::High || risk == RiskLevel::Critical {
                    let desc = format!("AI wants to: {} with params: {}", name, tool_params);
                    let req = PendingApproval {
                        id: uuid::Uuid::new_v4().to_string(),
                        tool: name.to_string(),
                        action: tool_params["action"].as_str().unwrap_or("execute").to_string(),
                        description: desc.clone(),
                        preview: screenshot_base64.clone(),
                    };
                    granted = get_permission_gate().request_approval(req, &app).await;
                }

                if !granted {
                    let _ = save_audit(&AuditEntry {
                        id: uuid::Uuid::new_v4().to_string(),
                        action_type: name.to_string(), tool_name: Some(name.to_string()),
                        app_name: None, outcome: "denied".to_string(),
                        created_at: chrono::Utc::now().to_rfc3339(),
                    });
                    final_status = "cancelled".to_string();
                    final_outcome = format!("Permission denied for: {}", name);
                    break 'main;
                }

                // Execute tool
                let (outcome_text, success) = match tool.execute(tool_params).await {
                    Ok(out) => (out, true),
                    Err(e) => (format!("Tool '{}' failed: {}", name, e), false),
                };

                // Audit log
                let _ = save_audit(&AuditEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    action_type: name.to_string(), tool_name: Some(name.to_string()),
                    app_name: None,
                    outcome: if success { "success".to_string() } else { "failed".to_string() },
                    created_at: chrono::Utc::now().to_rfc3339(),
                });

                steps_log.push(StepProgress {
                    step_num, thought: thought.clone(),
                    tool: Some(name.to_string()), description: outcome_text.clone(), success,
                });

                let _ = app.emit("task:step", serde_json::json!({
                    "step_num": step_num, "thought": thought,
                    "tool": name, "description": outcome_text, "success": success
                }));

                messages.push(ChatMessage { role: "assistant".to_string(), content: ai_response });
                messages.push(ChatMessage {
                    role: "user".to_string(),
                    content: format!("Tool '{}' result: {}", name, outcome_text),
                });

                // Small yield to allow cancel check
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            } else {
                final_status = "failed".to_string();
                final_outcome = format!("Unknown tool requested: '{}'. Available: mouse, keyboard, screen, app, file, clipboard", name);
                let _ = app.emit("task:failed", serde_json::json!({
                    "task_id": task_id.clone(),
                    "error": final_outcome.clone()
                }));
                break 'main;
            }
        } else {
            final_status = "failed".to_string();
            final_outcome = format!("AI response missing 'tool' field. Got: {}", ai_response);
            let _ = app.emit("task:failed", serde_json::json!({
                "task_id": task_id.clone(),
                "error": final_outcome.clone()
            }));
            break 'main;
        }

        step_num += 1;
    }

    // Max steps exceeded
    if step_num > max_steps && final_status == "completed" {
        final_status = "failed".to_string();
        final_outcome = format!("Exceeded {} step limit without completing.", max_steps);
        let _ = app.emit("task:failed", serde_json::json!({
            "task_id": task_id.clone(),
            "error": final_outcome.clone()
        }));
    }

    // Save final task
    let final_task = Task {
        id: task_id.clone(),
        description: instruction.clone(),
        status: final_status.clone(),
        steps_json: serde_json::to_string(&steps_log).unwrap_or_default(),
        outcome: Some(final_outcome.clone()),
        created_at: now,
        synced_at: None,
    };
    let _ = save_task(&final_task);

    // Emit completion / save memory
    if final_status == "completed" {
        let _ = crate::ai::memory::add_mem0_memory(&instruction, &final_outcome, &user_id).await;
        let _ = app.emit("task:done", serde_json::json!({
            "task_id": task_id,
            "result": final_outcome
        }));
    } else if final_status == "cancelled" {
        // agent:killed already emitted above
    }
    // failed events emitted inline
}
