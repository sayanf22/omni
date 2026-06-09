use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use serde::{Serialize, Deserialize};
use serde_json::Value;
use crate::tools::{get_all_tools, RiskLevel};
use crate::ai::{detect_task_type, call_ai_chat, ChatMessage};
use crate::storage::sqlite::{save_task, Task, save_audit, AuditEntry};
use crate::security::permissions::{get_permission_gate, PendingApproval};

use std::sync::OnceLock;

fn get_cancel_flag() -> &'static AtomicBool {
    static CANCEL_FLAG: OnceLock<AtomicBool> = OnceLock::new();
    CANCEL_FLAG.get_or_init(|| AtomicBool::new(false))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepProgress {
    pub step_num: u32,
    pub thought: String,
    pub tool: Option<String>,
    pub description: String,
    pub success: bool,
}

#[tauri::command]
pub async fn run_task(
    instruction: String,
    user_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // 1. Reset cancellation flag
    get_cancel_flag().store(false, Ordering::SeqCst);

    // 2. Resolve user_id — if empty, fall back to stored keychain user id
    let resolved_user_id = if user_id.is_empty() {
        crate::storage::keychain::get_key("supabase_user_id")
            .ok()
            .flatten()
            .unwrap_or_else(|| "local-user".to_string())
    } else {
        user_id
    };

    // 3. Generate task ID
    let task_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // 3. Save task to local SQLite
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
        return Err(format!("Failed to save task to DB: {}", e));
    }

    // Emit task started event
    let _ = app.emit("task:started", serde_json::json!({
        "task_id": task_id.clone(),
        "instruction": instruction.clone()
    }));

    // 4. Initialize AI chat messages
    let task_type = detect_task_type(&instruction);
    let tools = get_all_tools();
    
    // Build tools system prompt description
    let mut tools_desc = Vec::new();
    for (name, t) in &tools {
        tools_desc.push(serde_json::json!({
            "name": name,
            "description": t.description(),
            "params_schema": t.params_schema()
        }));
    }

    let mut system_prompt = format!(
        "You are Omni, an AI agent controlling a Windows computer.\n\
         You see the current screen in the screenshot provided.\n\n\
         Available tools:\n{}\n\n\
         Rules:\n\
         - Think step by step. Use minimum steps needed.\n\
         - After each tool call you will receive a new screenshot.\n\
         - For DELETE or high-risk actions (like deleting folders or file deletion): you will be prompted for approval.\n\
         - Stop at 20 steps maximum.\n\
         - When done: output {{\"done\":true, \"result\":\"brief summary\"}}\n\
         - Respond ONLY in valid JSON matching one of the schemas below. No markdown formatting. No explanation outside JSON.\n\n\
         Valid JSON response schemas:\n\
         1) {{\"thought\":\"...\", \"tool\":\"tool_name\", \"params\":{{...}}}}\n\
         2) {{\"done\":true, \"result\":\"...\"}}\n\
         3) {{\"question\":\"...\"}}",
        serde_json::to_string_pretty(&tools_desc).unwrap_or_default()
    );

    // Retrieve memories from Mem0 if configured
    if let Some(memories) = crate::ai::memory::fetch_mem0_memories(&instruction, &resolved_user_id).await {
        system_prompt.push_str(&format!("\n\n{}", memories));
    }

    let mut messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("Instruction: {}", instruction),
        }
    ];

    let mut step_num = 1;
    let max_steps = 20;
    let mut steps_log = Vec::new();
    let mut final_outcome = String::from("Task finished successfully.");
    let mut final_status = String::from("completed");

    while step_num <= max_steps {
        // Check cancellation
        if get_cancel_flag().load(Ordering::SeqCst) {
            final_status = "cancelled".to_string();
            final_outcome = "Task was aborted by user.".to_string();
            let _ = app.emit("task:killed", serde_json::json!({}));
            break;
        }

        // Take a screenshot for Vision/Observation
        let screenshot_base64 = match crate::automation::screen::capture_full_screen() {
            Ok(base64) => Some(base64),
            Err(e) => {
                eprintln!("Screenshot failed: {:?}", e);
                None
            }
        };

        // Call the AI Brain
        let ai_response = match call_ai_chat(task_type, messages.clone(), screenshot_base64.clone()).await {
            Ok(res) => res,
            Err(e) => {
                final_status = "failed".to_string();
                final_outcome = format!("AI brain communication error: {}", e);
                let _ = app.emit("task:failed", serde_json::json!({
                    "task_id": task_id.clone(),
                    "error": final_outcome.clone(),
                    "step_num": step_num
                }));
                break;
            }
        };

        // Parse AI JSON response
        let parsed_response: Value = match serde_json::from_str(&ai_response) {
            Ok(json_val) => json_val,
            Err(_) => {
                // Try to extract JSON from markdown if AI failed to match rules
                let clean_res = ai_response.trim()
                    .trim_start_matches("```json")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim()
                    .to_string();
                
                match serde_json::from_str(&clean_res) {
                    Ok(json_val) => json_val,
                    Err(e) => {
                        final_status = "failed".to_string();
                        final_outcome = format!("AI responded with invalid JSON format: {}. Output: {}", e, ai_response);
                        let _ = app.emit("task:failed", serde_json::json!({
                            "task_id": task_id.clone(),
                            "error": final_outcome.clone(),
                            "step_num": step_num
                        }));
                        break;
                    }
                }
            }
        };

        // Case 1: Done
        if parsed_response["done"].as_bool().unwrap_or(false) {
            let result_str = parsed_response["result"].as_str().unwrap_or("Done").to_string();
            final_outcome = result_str.clone();
            
            steps_log.push(StepProgress {
                step_num,
                thought: "Task completed.".to_string(),
                tool: None,
                description: result_str.clone(),
                success: true,
            });

            let _ = app.emit("task:step", serde_json::json!({
                "step_num": step_num,
                "thought": "Task completed.",
                "tool": null,
                "description": result_str,
                "success": true
            }));
            break;
        }

        // Case 2: User Question / Pause
        if let Some(question) = parsed_response["question"].as_str() {
            let _ = app.emit("task:step", serde_json::json!({
                "step_num": step_num,
                "thought": "Asking user a question.",
                "tool": null,
                "description": question,
                "success": true
            }));

            // Pause and ask the question using the PermissionGate
            let approval_id = uuid::Uuid::new_v4().to_string();
            let approval_req = PendingApproval {
                id: approval_id.clone(),
                tool: "question".to_string(),
                action: "ask".to_string(),
                description: question.to_string(),
                preview: None,
            };

            let approved = get_permission_gate().request_approval(approval_req, &app).await;
            if !approved {
                final_status = "cancelled".to_string();
                final_outcome = "Task stopped because user did not approve.".to_string();
                break;
            }

            // Simulate user text response (Mock or from frontend callback. In V1, approval is a simple YES/NO)
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: ai_response,
            });
            messages.push(ChatMessage {
                role: "user".to_string(),
                content: "User response: Yes/Approved.".to_string(),
            });

            step_num += 1;
            continue;
        }

        // Case 3: Tool Execution
        let tool_name = parsed_response["tool"].as_str();
        let tool_params = parsed_response["params"].clone();
        let thought = parsed_response["thought"].as_str().unwrap_or("").to_string();

        if let Some(name) = tool_name {
            if let Some(tool) = tools.get(name) {
                let risk = tool.risk_level(&tool_params);
                let description = format!("Running tool '{}' with params: {}", name, tool_params);

                // Risk evaluation gate
                let mut permission_granted = true;
                if risk == RiskLevel::High || risk == RiskLevel::Critical {
                    let approval_id = uuid::Uuid::new_v4().to_string();
                    let approval_req = PendingApproval {
                        id: approval_id.clone(),
                        tool: name.to_string(),
                        action: tool_params["action"].as_str().unwrap_or("execute").to_string(),
                        description: format!("AI requested high-risk action: {}", description),
                        preview: screenshot_base64.clone(),
                    };
                    permission_granted = get_permission_gate().request_approval(approval_req, &app).await;
                }

                if !permission_granted {
                    // Log audit entry as denied
                    let _ = save_audit(&AuditEntry {
                        id: uuid::Uuid::new_v4().to_string(),
                        action_type: name.to_string(),
                        tool_name: Some(name.to_string()),
                        app_name: None,
                        outcome: "denied".to_string(),
                        created_at: chrono::Utc::now().to_rfc3339(),
                    });

                    final_status = "cancelled".to_string();
                    final_outcome = format!("Denied permission for high-risk action: {}", description);
                    break;
                }

                // Execute the tool
                let execute_result = tool.execute(tool_params).await;
                let (outcome_text, success) = match execute_result {
                    Ok(out) => (out, true),
                    Err(e) => (format!("Tool execution failed: {}", e), false),
                };

                // Save audit entry
                let _ = save_audit(&AuditEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    action_type: name.to_string(),
                    tool_name: Some(name.to_string()),
                    app_name: None,
                    outcome: if success { "success".to_string() } else { "failed".to_string() },
                    created_at: chrono::Utc::now().to_rfc3339(),
                });

                steps_log.push(StepProgress {
                    step_num,
                    thought: thought.clone(),
                    tool: Some(name.to_string()),
                    description: outcome_text.clone(),
                    success,
                });

                let _ = app.emit("task:step", serde_json::json!({
                    "step_num": step_num,
                    "thought": thought,
                    "tool": name,
                    "description": outcome_text.clone(),
                    "success": success
                }));

                // Append history
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: ai_response,
                });
                messages.push(ChatMessage {
                    role: "user".to_string(),
                    content: format!("Tool outcome: {}", outcome_text),
                });
            } else {
                final_status = "failed".to_string();
                final_outcome = format!("AI requested non-existent tool: {}", name);
                break;
            }
        } else {
            final_status = "failed".to_string();
            final_outcome = format!("AI response did not request a tool or complete: {}", ai_response);
            break;
        }

        step_num += 1;
    }

    if step_num > max_steps {
        final_status = "failed".to_string();
        final_outcome = "Maximum steps (20) exceeded without completing task.".to_string();
        let _ = app.emit("task:failed", serde_json::json!({
            "task_id": task_id.clone(),
            "error": final_outcome.clone(),
            "step_num": max_steps
        }));
    }

    // 5. Update SQLite task outcome
    let final_task = Task {
        id: task_id.clone(),
        description: instruction.clone(),
        status: final_status.clone(),
        steps_json: serde_json::to_string(&steps_log).unwrap_or_else(|_| "[]".to_string()),
        outcome: Some(final_outcome.clone()),
        created_at: now,
        synced_at: None,
    };
    let _ = save_task(&final_task);

    // Emit task done & write context to Mem0
    if final_status == "completed" {
        let _ = crate::ai::memory::add_mem0_memory(&instruction, &final_outcome, &resolved_user_id).await;

        let _ = app.emit("task:done", serde_json::json!({
            "task_id": task_id.clone(),
            "result": final_outcome.clone()
        }));
    }

    Ok(final_outcome)
}

#[tauri::command]
pub fn cancel_task() -> Result<(), String> {
    get_cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}
