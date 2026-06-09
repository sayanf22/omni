use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use serde::{Serialize, Deserialize};
use serde_json::Value;
use crate::tools::{get_all_tools, RiskLevel};
use crate::ai::{detect_task_type, call_ai_chat, ChatMessage, TaskType};
use crate::storage::sqlite::{save_task, Task, save_audit, AuditEntry};
use crate::security::permissions::{get_permission_gate, PendingApproval};

use std::sync::OnceLock;
use std::sync::Arc;
use tokio::sync::Notify;

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

    let vision_available = {
        let role = match task_type {
            TaskType::Vision  => "vision",
            TaskType::Coding  => "coding",
            TaskType::Writing => "writing",
        };
        let model = crate::storage::sqlite::get_active_model_for_role_db(role)
            .ok().flatten()
            .or_else(|| crate::storage::sqlite::get_active_model_for_role_db("vision").ok().flatten());
        model.map_or(false, |m| crate::ai::client::model_supports_vision(&m))
    };

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
        "You see the current screen in the screenshot provided with each message. Use what you see to locate UI elements and decide what to click/type."
    } else {
        "IMPORTANT: Your model does NOT support screen vision — you cannot see screenshots.\n\
         Reason from the task description and tool outcomes only.\n\
         Use 'screen' tool with action='ocr' to read text, or action='ui_tree' for accessibility element positions.\n\
         Use 'app' tool to launch/focus applications. Use 'mouse' after getting coordinates from ocr/ui_tree."
    };

    let mut system_prompt = format!(
        "You are Omni, a Windows desktop automation agent.\n\
         {}\n\n\
         Available tools:\n{}\n\n\
         RULES:\n\
         - Think step by step. Use minimum steps.\n\
         - You control a real Windows PC — mouse, keyboard, apps, files.\n\
         - ALWAYS use tools to accomplish tasks. Never just describe what to do.\n\
         - For file deletion or sending emails/posts: output {{\"question\":\"...\"}} to ask user first.\n\
         - Stop at 20 steps maximum.\n\
         - When done: output {{\"done\":true, \"result\":\"brief summary\"}}\n\
         - Respond ONLY in valid JSON. No markdown. No explanation outside JSON.\n\n\
         Valid JSON response formats:\n\
         1) {{\"thought\":\"why you're doing this\", \"tool\":\"tool_name\", \"params\":{{...}}}}\n\
         2) {{\"done\":true, \"result\":\"what was accomplished\"}}\n\
         3) {{\"question\":\"specific question for user\"}}",
        screen_context,
        serde_json::to_string_pretty(&tools_desc).unwrap_or_default()
    );

    // Fetch relevant memories
    if let Some(memories) = crate::ai::memory::fetch_mem0_memories(&instruction, &user_id).await {
        system_prompt.push_str(&format!("\n\nRelevant context from past tasks:\n{}", memories));
    }

    let mut messages = vec![
        ChatMessage { role: "system".to_string(), content: system_prompt },
        ChatMessage { role: "user".to_string(), content: format!("Task: {}", instruction) },
    ];

    let mut step_num = 1u32;
    let max_steps = 20;
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
