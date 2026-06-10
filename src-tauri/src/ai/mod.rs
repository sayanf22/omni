use serde::{Serialize, Deserialize};
use crate::storage::sqlite::{get_active_model_for_role_db, CustomModel};
use crate::storage::keychain::get_key;

pub mod client;
pub mod memory;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    Vision,
    Coding,
    Writing,
    /// Multi-step / analytical tasks that benefit from a dedicated reasoning model.
    Reasoning,
}

impl TaskType {
    /// The primary SQLite role string this task type maps to.
    pub fn role(&self) -> &'static str {
        match self {
            TaskType::Vision => "vision",
            TaskType::Coding => "coding",
            TaskType::Writing => "writing",
            // Reasoning has no dedicated DB column — it is resolved by model
            // capability heuristics (see resolve_active_model). The coding role
            // is the natural fallback bucket for analytical work.
            TaskType::Reasoning => "coding",
        }
    }
}

/// Classifies a user instruction so we can route it to the most appropriate
/// model. Order of precedence matters: reasoning beats coding/writing because a
/// complex analytical request often also mentions code or writing.
pub fn detect_task_type(instruction: &str) -> TaskType {
    let instr_lower = instruction.to_lowercase();

    // Reasoning: explicit multi-step / analytical signals. Checked FIRST so a
    // request like "analyze this code and explain why it fails" routes to a
    // reasoning model rather than a plain coding model.
    let reasoning_keywords = [
        "analyze", "analyse", "reason", "figure out", "work out", "step by step",
        "step-by-step", "compare", "evaluate", "investigate", "diagnose",
        "troubleshoot", "explain why", "why does", "why is", "how should",
        "strategy", "plan how", "calculate", "solve", "deduce", "prove",
        "optimize", "trade-off", "tradeoff", "pros and cons", "decide whether",
        "research and", "summarize and", "think through",
    ];
    for kw in reasoning_keywords {
        if instr_lower.contains(kw) {
            return TaskType::Reasoning;
        }
    }

    let coding_keywords = [
        "code", "function", "bug", "fix", "git", "vscode", "python",
        "javascript", "typescript", "rust", "class", "component", "terminal", "npm", "cargo"
    ];
    let writing_keywords = [
        "write", "email", "post", "linkedin", "tweet", "message",
        "draft", "caption", "blog"
    ];

    for kw in coding_keywords {
        if instr_lower.contains(kw) {
            return TaskType::Coding;
        }
    }
    for kw in writing_keywords {
        if instr_lower.contains(kw) {
            return TaskType::Writing;
        }
    }
    TaskType::Vision
}

/// Resolve the concrete model to use for a task type, honoring the user's
/// configured roles and adding reasoning-model routing on top.
///
/// Routing logic (production rules):
///   - Reasoning  → the best active reasoning-capable model (o1/o3, deepseek-reasoner,
///                  claude thinking models, etc.). Falls back to coding → writing → vision.
///   - Coding     → active coding model, else vision.
///   - Writing    → active writing model, else vision.
///   - Vision     → active vision model.
/// Any role with no configured model finally falls back to *any* active model so
/// a single-model setup always works.
pub fn resolve_active_model(task_type: TaskType) -> anyhow::Result<Option<CustomModel>> {
    // Reasoning gets first crack at a dedicated reasoning model.
    if task_type == TaskType::Reasoning {
        if let Some(m) = best_reasoning_model()? {
            return Ok(Some(m));
        }
    }

    // Try the primary role for this task.
    if let Some(m) = get_active_model_for_role_db(task_type.role())? {
        return Ok(Some(m));
    }

    // Role-specific fallbacks.
    let fallbacks: &[&str] = match task_type {
        TaskType::Vision => &[],
        TaskType::Coding => &["vision", "writing"],
        TaskType::Writing => &["vision", "coding"],
        TaskType::Reasoning => &["writing", "vision"],
    };
    for role in fallbacks {
        if let Some(m) = get_active_model_for_role_db(role)? {
            return Ok(Some(m));
        }
    }

    // Last resort: any active model at all (single-model setups).
    let any_active = crate::storage::sqlite::get_custom_models_db()?
        .into_iter()
        .find(|m| m.is_active);
    Ok(any_active)
}

/// Pick the strongest active reasoning-capable model, if one is configured.
/// Prefers models flagged for coding (analytical bucket) when ties occur.
fn best_reasoning_model() -> anyhow::Result<Option<CustomModel>> {
    let models = crate::storage::sqlite::get_custom_models_db()?;
    let mut best: Option<CustomModel> = None;
    for m in models.into_iter().filter(|m| m.is_active) {
        if crate::ai::client::model_is_reasoning(&m) {
            // Prefer a reasoning model that is also assigned the coding role.
            match &best {
                Some(b) if b.role_coding && !m.role_coding => {}
                _ => best = Some(m),
            }
        }
    }
    Ok(best)
}

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;
use crate::storage::sqlite::get_setting_internal;

pub struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64, // tokens per second
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(max_tokens: f64, refill_rate: f64) -> Self {
        Self {
            tokens: max_tokens,
            max_tokens,
            refill_rate,
            last_refill: Instant::now(),
        }
    }

    pub fn update_limits(&mut self, max_tokens: f64, refill_rate: f64) {
        if self.max_tokens != max_tokens || self.refill_rate != refill_rate {
            self.max_tokens = max_tokens;
            self.refill_rate = refill_rate;
            self.tokens = self.tokens.min(max_tokens);
        }
    }

    pub fn acquire(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.last_refill = now;

        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

static RATE_LIMITER: OnceLock<Mutex<RateLimiter>> = OnceLock::new();

fn get_rate_limiter() -> &'static Mutex<RateLimiter> {
    RATE_LIMITER.get_or_init(|| {
        Mutex::new(RateLimiter::new(15.0, 0.1)) // default: 15 burst, 6 requests per min
    })
}

/// Dynamically route chat request to the active model matching the target role type
pub async fn call_ai_chat(
    task_type: TaskType,
    messages: Vec<ChatMessage>,
    screenshot_base64: Option<String>,
) -> anyhow::Result<String> {
    // 0. Enforce rate limiting configured in SQLite
    let max_tokens = get_setting_internal("rate_limit_max")
        .unwrap_or(None)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(15.0);

    let refill_rate = get_setting_internal("rate_limit_refill")
        .unwrap_or(None)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.1);

    let limiter = get_rate_limiter();
    {
        let mut lim = limiter.lock().unwrap();
        lim.update_limits(max_tokens, refill_rate);
        if !lim.acquire() {
            return Err(anyhow::anyhow!("Rate limit exceeded. Too many AI requests. Please wait and try again."));
        }
    }

    let role = task_type.role();

    // 1. Resolve the active model using capability-aware routing
    //    (reasoning models for analytical tasks, role models otherwise).
    let selected_model = resolve_active_model(task_type)?;

    let model = selected_model.ok_or_else(|| {
        anyhow::anyhow!("No active model configured for role '{}' or fallback. Please configure at least one active model in Settings.", role)
    })?;

    // 2. Fetch API key from Keychain
    let api_key = get_key(&model.id)?
        .ok_or_else(|| anyhow::anyhow!("API key not found in Keychain for model '{}'.", model.display_name))?;

    // 3. Dispatch to client handler
    crate::ai::client::send_chat_request(&model, &api_key, messages, screenshot_base64).await
}

#[tauri::command]
pub async fn test_model_connection(
    provider_type: String,
    model_name: String,
    base_url: Option<String>,
    api_key: String,
) -> Result<String, String> {
    if api_key == "mock" || api_key == "test" || api_key == "demo" || api_key.starts_with("mock-") {
        return Ok("OK (Mocked Connection)".to_string());
    }

    let dummy_model = CustomModel {
        id: "temp_test_id".to_string(),
        provider_type,
        model_name,
        display_name: "Test Model".to_string(),
        base_url,
        role_vision: false,
        role_coding: false,
        role_writing: false,
        is_active: true,
    };

    let test_messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Say only the word 'OK' to confirm connection.".to_string(),
    }];

    crate::ai::client::send_chat_request(&dummy_model, &api_key, test_messages, None)
        .await
        .map_err(|e| {
            eprintln!("test_model_connection failed: {:?}", e);
            e.to_string()
        })
}
