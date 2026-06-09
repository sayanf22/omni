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
}

pub fn detect_task_type(instruction: &str) -> TaskType {
    let instr_lower = instruction.to_lowercase();
    let coding_keywords = vec![
        "code", "function", "bug", "fix", "git", "vscode", "python",
        "javascript", "typescript", "rust", "class", "component", "terminal", "npm", "cargo"
    ];
    let writing_keywords = vec![
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

    let role = match task_type {
        TaskType::Vision => "vision",
        TaskType::Coding => "coding",
        TaskType::Writing => "writing",
    };

    // 1. Look up the active model for the role
    let mut selected_model = get_active_model_for_role_db(role)?;

    // Fall back to vision/primary if other roles are not configured
    if selected_model.is_none() && task_type != TaskType::Vision {
        selected_model = get_active_model_for_role_db("vision")?;
    }

    let model = selected_model.ok_or_else(|| {
        anyhow::anyhow!("No active model configured for role '{}' or fallback. Please configure at least one active Vision model.", role)
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
