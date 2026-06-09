use serde_json::json;
use crate::storage::sqlite::CustomModel;
use crate::ai::ChatMessage;

pub async fn send_chat_request(
    model: &CustomModel,
    api_key: &str,
    messages: Vec<ChatMessage>,
    screenshot_base64: Option<String>,
) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let provider = model.provider_type.to_lowercase();

    if provider == "anthropic" {
        send_anthropic_request(&client, model, api_key, messages, screenshot_base64).await
    } else {
        send_openai_compatible_request(&client, model, api_key, messages, screenshot_base64).await
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
        "openai" => "https://api.openai.com/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        "deepseek" => "https://api.deepseek.com/v1".to_string(),
        _ => model.base_url.clone().unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
    };

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut body_messages = Vec::new();
    let len = messages.len();

    for (i, msg) in messages.into_iter().enumerate() {
        let is_last = i == len - 1;
        let is_user = msg.role == "user";

        if is_last && is_user && screenshot_base64.is_some() {
            let img_base64 = screenshot_base64.clone().unwrap();
            let content_array = json!([
                {
                    "type": "text",
                    "text": msg.content
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:image/jpeg;base64,{}", img_base64)
                    }
                }
            ]);
            body_messages.push(json!({
                "role": msg.role,
                "content": content_array
            }));
        } else {
            body_messages.push(json!({
                "role": msg.role,
                "content": msg.content
            }));
        }
    }

    let payload = json!({
        "model": model.model_name,
        "messages": body_messages
    });

    let mut request = client.post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key));

    // OpenRouter suggests setting app identification headers
    if model.provider_type.to_lowercase() == "openrouter" {
        request = request
            .header("HTTP-Referer", "https://github.com/omni-agent/omni")
            .header("X-Title", "Omni Desktop Agent");
    }

    let response = request.json(&payload).send().await?;
    let status = response.status();
    let text = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!("API Error ({}): {}", status, text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)?;
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Failed to parse completion response: {}", text))?;

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

    let mut body_messages = Vec::new();
    let len = messages.len();

    // Anthropic messages API does not accept "system" role in the messages list.
    // If a system message exists, it should be extracted and passed in the "system" parameter!
    let mut system_prompt = None;

    for (i, msg) in messages.into_iter().enumerate() {
        if msg.role == "system" {
            system_prompt = Some(msg.content);
            continue;
        }

        let is_last = i == len - 1;
        let is_user = msg.role == "user";

        if is_last && is_user && screenshot_base64.is_some() {
            let img_base64 = screenshot_base64.clone().unwrap();
            let content_array = json!([
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": img_base64
                    }
                },
                {
                    "type": "text",
                    "text": msg.content
                }
            ]);
            body_messages.push(json!({
                "role": msg.role,
                "content": content_array
            }));
        } else {
            body_messages.push(json!({
                "role": msg.role,
                "content": msg.content
            }));
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

    let response = client.post(url)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!("Anthropic API Error ({}): {}", status, text));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)?;
    let content = parsed["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Failed to parse Anthropic response: {}", text))?;

    Ok(content.to_string())
}
