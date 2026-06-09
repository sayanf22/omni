use serde_json::json;
use crate::storage::sqlite::CustomModel;
use crate::ai::ChatMessage;

/// Whether a provider/model supports vision (image) inputs.
/// DeepSeek, plain text models, and custom endpoints without explicit vision
/// support should NOT receive screenshots — they return API errors otherwise.
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
