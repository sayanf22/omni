use serde_json::json;
use crate::storage::sqlite::CustomModel;
use crate::ai::ChatMessage;

/// Whether a provider/model supports vision (image) inputs.
/// DeepSeek, plain text models, and custom endpoints without explicit vision
/// support should NOT receive screenshots — they return API errors otherwise.
pub fn model_supports_vision(model: &CustomModel) -> bool {
    supports_vision(model)
}

fn supports_vision(model: &CustomModel) -> bool {
    let provider = model.provider_type.to_lowercase();
    let model_name = model.model_name.to_lowercase();

    match provider.as_str() {
        // DeepSeek: NO vision support on any current model
        "deepseek" => false,
        // OpenAI: vision requires gpt-4o, gpt-4-vision, o1, etc.
        "openai" => {
            model_name.contains("gpt-4o")
                || model_name.contains("gpt-4-turbo")
                || model_name.contains("gpt-4-vision")
                || model_name.contains("o1")
                || model_name.contains("o3")
                || model_name.contains("o4")
        }
        // Anthropic: claude-3+ all support vision
        "anthropic" => {
            model_name.contains("claude-3")
                || model_name.contains("claude-opus")
                || model_name.contains("claude-sonnet")
                || model_name.contains("claude-haiku")
        }
        // OpenRouter: assume vision if the model name includes common vision model identifiers
        "openrouter" => {
            model_name.contains("gpt-4o")
                || model_name.contains("claude-3")
                || model_name.contains("gemini")
                || model_name.contains("vision")
                || model_name.contains("llava")
                || model_name.contains("qwen")
        }
        // Custom: only if model name explicitly suggests vision
        "custom" => model_name.contains("vision") || model_name.contains("llava"),
        // Default: assume no vision to be safe
        _ => false,
    }
}

pub async fn send_chat_request(
    model: &CustomModel,
    api_key: &str,
    messages: Vec<ChatMessage>,
    screenshot_base64: Option<String>,
) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    // Only pass screenshot to models that actually support vision
    let effective_screenshot = if supports_vision(model) {
        screenshot_base64
    } else {
        tracing::debug!(
            "Model '{}' ({}) does not support vision — skipping screenshot",
            model.model_name, model.provider_type
        );
        None
    };

    let provider = model.provider_type.to_lowercase();
    if provider == "anthropic" {
        send_anthropic_request(&client, model, api_key, messages, effective_screenshot).await
    } else {
        send_openai_compatible_request(&client, model, api_key, messages, effective_screenshot).await
    }
}

async fn send_openai_compatible_request(
    client: &reqwest::Client,
    model: &CustomModel,
    api_key: &str,
    messages: Vec<ChatMessage>,
    screenshot_base64: Option<String>,
) -> anyhow::Result<String> {
    let base_url = match model.provider_type.to_lowercase().as_str() {
        "openai"     => "https://api.openai.com/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        "deepseek"   => "https://api.deepseek.com/v1".to_string(),
        _            => model.base_url.clone().unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
    };

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let body_messages = build_messages_openai(messages, screenshot_base64);

    let payload = json!({
        "model": model.model_name,
        "messages": body_messages,
        "max_tokens": 2048
    });

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key));

    if model.provider_type.to_lowercase() == "openrouter" {
        request = request
            .header("HTTP-Referer", "https://github.com/sayanf22/omni")
            .header("X-Title", "Omni Desktop Agent");
    }

    let response = request.json(&payload).send().await
        .map_err(|e| anyhow::anyhow!("Network error calling {}: {}", model.provider_type, e))?;

    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!(
            "{} API error ({}): {}",
            model.provider_type, status, body
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("Failed to parse {} response: {} — raw: {}", model.provider_type, e, body))?;

    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Unexpected response format from {}: {}", model.provider_type, body))?;

    Ok(content.to_string())
}

async fn send_anthropic_request(
    client: &reqwest::Client,
    model: &CustomModel,
    api_key: &str,
    messages: Vec<ChatMessage>,
    screenshot_base64: Option<String>,
) -> anyhow::Result<String> {
    let url = "https://api.anthropic.com/v1/messages";

    let mut system_prompt = None;
    let mut body_messages = Vec::new();
    let len = messages.len();

    for (i, msg) in messages.into_iter().enumerate() {
        if msg.role == "system" {
            system_prompt = Some(msg.content);
            continue;
        }
        let is_last_user = i == len - 1 && msg.role == "user";
        if is_last_user && screenshot_base64.is_some() {
            let img = screenshot_base64.clone().unwrap();
            body_messages.push(json!({
                "role": msg.role,
                "content": [
                    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": img } },
                    { "type": "text", "text": msg.content }
                ]
            }));
        } else {
            body_messages.push(json!({ "role": msg.role, "content": msg.content }));
        }
    }

    let mut payload = json!({
        "model": model.model_name,
        "max_tokens": 2048,
        "messages": body_messages
    });
    if let Some(sys) = system_prompt {
        payload.as_object_mut().unwrap().insert("system".to_string(), json!(sys));
    }

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Network error calling Anthropic: {}", e))?;

    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!("Anthropic API error ({}): {}", status, body));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)?;
    let content = parsed["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Unexpected Anthropic response: {}", body))?;

    Ok(content.to_string())
}

/// Probes whether the model actually accepts image inputs by sending a 1×1 JPEG.
/// Returns true if vision is supported, false if not.
pub async fn test_vision_capability(model: &CustomModel, api_key: &str) -> bool {
    // Tiny 1×1 red pixel JPEG, base64-encoded
    const TINY_JPEG: &str = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let provider = model.provider_type.to_lowercase();

    if provider == "anthropic" {
        let payload = json!({
            "model": model.model_name,
            "max_tokens": 10,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": TINY_JPEG}},
                    {"type": "text", "text": "Reply with just the word OK."}
                ]
            }]
        });
        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                if status == 200 { return true; }
                if status == 401 || status == 403 { return false; }
                let b = body.to_lowercase();
                !b.contains("does not support") && !b.contains("vision") && !b.contains("image") && status != 400
            }
            Err(_) => false,
        }
    } else {
        // OpenAI-compatible format
        let base_url = match provider.as_str() {
            "openai"     => "https://api.openai.com/v1".to_string(),
            "openrouter" => "https://openrouter.ai/api/v1".to_string(),
            "deepseek"   => "https://api.deepseek.com/v1".to_string(),
            _            => model.base_url.clone().unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
        };
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let payload = json!({
            "model": model.model_name,
            "max_tokens": 10,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Reply with just the word OK."},
                    {"type": "image_url", "image_url": {"url": format!("data:image/jpeg;base64,{}", TINY_JPEG)}}
                ]
            }]
        });
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await;

        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                if status == 200 { return true; }
                if status == 401 || status == 403 { return false; }
                let b = body.to_lowercase();
                // DeepSeek: "does not support image input"; others: various image/multimodal errors
                !(b.contains("does not support")
                    || b.contains("vision not supported")
                    || b.contains("image input")
                    || b.contains("multimodal")
                    || b.contains("image_url"))
            }
            Err(_) => false,
        }
    }
}

/// Tauri command — probe whether a model accepts image inputs.
#[tauri::command]
pub async fn probe_model_vision(
    provider_type: String,
    model_name: String,
    base_url: Option<String>,
    api_key: String,
) -> Result<bool, String> {
    let model = crate::storage::sqlite::CustomModel {
        id: "probe".to_string(),
        provider_type,
        model_name,
        display_name: "probe".to_string(),
        base_url,
        role_vision: false,
        role_coding: false,
        role_writing: false,
        is_active: false,
    };
    Ok(test_vision_capability(&model, &api_key).await)
}

fn build_messages_openai(messages: Vec<ChatMessage>, screenshot_base64: Option<String>) -> Vec<serde_json::Value> {
    let len = messages.len();
    let mut out = Vec::new();
    for (i, msg) in messages.into_iter().enumerate() {
        let is_last_user = i == len - 1 && msg.role == "user";
        if is_last_user && screenshot_base64.is_some() {
            let img = screenshot_base64.clone().unwrap();
            out.push(json!({
                "role": msg.role,
                "content": [
                    { "type": "text", "text": msg.content },
                    { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", img) } }
                ]
            }));
        } else {
            out.push(json!({ "role": msg.role, "content": msg.content }));
        }
    }
    out
}

