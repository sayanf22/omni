use serde_json::json;
use crate::storage::sqlite::CustomModel;
use crate::ai::ChatMessage;

/// Whether a provider/model supports vision (image) inputs.
/// DeepSeek, plain text models, and custom endpoints without explicit vision
/// support should NOT receive screenshots — they return API errors otherwise.
pub fn model_supports_vision(model: &CustomModel) -> bool {
    supports_vision(model)
}

/// Heuristic: does this model name correspond to a dedicated *reasoning* model?
/// Reasoning models (OpenAI o-series, DeepSeek R1/Reasoner, Claude extended-thinking
/// tiers, QwQ, etc.) think step-by-step internally and are worth routing complex,
/// multi-step analytical tasks to. We detect by well-known name fragments since
/// providers expose no machine-readable capability flag.
pub fn model_is_reasoning(model: &CustomModel) -> bool {
    let provider = model.provider_type.to_lowercase();
    let name = model.model_name.to_lowercase();

    // Generic reasoning-model signals that hold across providers/gateways.
    let generic = name.contains("reason")          // deepseek-reasoner, *-reasoning
        || name.contains("-r1") || name.contains("r1-") || name == "r1"
        || name.contains("deepseek-r1")
        || name.contains("qwq")                     // Qwen QwQ
        || name.contains("thinking")                // gemini-*-thinking, claude thinking
        || name.contains("magistral")               // Mistral reasoning
        || name.contains("phi-4-reasoning");

    match provider.as_str() {
        "openai" => {
            // o1 / o3 / o4 series + GPT-5 reasoning tier.
            name.starts_with("o1") || name.starts_with("o3") || name.starts_with("o4")
                || name.contains("-o1") || name.contains("-o3") || name.contains("-o4")
                || name.contains("gpt-5")
                || generic
        }
        "deepseek" => name.contains("reasoner") || name.contains("r1") || generic,
        "anthropic" => {
            // Claude 3.7 + Claude 4 tiers expose extended thinking.
            name.contains("3-7") || name.contains("3.7")
                || name.contains("claude-opus-4") || name.contains("claude-sonnet-4")
                || name.contains("opus-4") || name.contains("sonnet-4")
                || generic
        }
        // OpenRouter / custom gateways: rely on the generic fragments plus the
        // common provider-prefixed reasoning names.
        _ => {
            generic
                || name.contains("o1-") || name.contains("o3-") || name.contains("o4-")
                || name.contains("gpt-5")
                || name.contains("grok-3") || name.contains("grok-4")
        }
    }
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

/// Lightweight connectivity check — sends a single "reply OK" message with no
/// JSON mode enforced and no screenshot. Used by test_model_connection and
/// test_stored_model so a real key always succeeds.
pub async fn test_connection(model: &CustomModel, api_key: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let provider = model.provider_type.to_lowercase();

    if provider == "anthropic" {
        let payload = json!({
            "model": model.model_name,
            "max_tokens": 10,
            "messages": [{"role": "user", "content": "Reply with the single word OK."}]
        });
        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Network error: {}", e))?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(anyhow::anyhow!("Anthropic API error ({}): {}", status, body));
        }
        let parsed: serde_json::Value = serde_json::from_str(&body)?;
        return Ok(parsed["content"][0]["text"].as_str().unwrap_or("OK").to_string());
    }

    // OpenAI-compatible (openai, openrouter, deepseek, custom)
    let base_url = match provider.as_str() {
        "openai"     => "https://api.openai.com/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        "deepseek"   => "https://api.deepseek.com/v1".to_string(),
        _            => model.base_url.clone().unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
    };
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // NOTE: No response_format: json_object here — just a plain chat call.
    // json_object mode requires the word "json" in the prompt and breaks simple
    // connectivity tests.
    let payload = json!({
        "model": model.model_name,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "Reply with the single word OK."}]
    });

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");
    if provider == "openrouter" {
        req = req
            .header("HTTP-Referer", "https://github.com/sayanf22/omni")
            .header("X-Title", "Omni Desktop Agent");
    }

    let resp = req.json(&payload).send().await
        .map_err(|e| anyhow::anyhow!("Network error calling {}: {}", model.provider_type, e))?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow::anyhow!("{} API error ({}): {}", model.provider_type, status, body));
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("Failed to parse {} response: {} — raw: {}", model.provider_type, e, body))?;
    Ok(parsed["choices"][0]["message"]["content"].as_str().unwrap_or("OK").to_string())
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

    let provider = model.provider_type.to_lowercase();
    let reasoning = model_is_reasoning(model);
    let mut payload = if reasoning {
        json!({
            "model": model.model_name,
            "messages": body_messages,
            "max_tokens": 2048
        })
    } else {
        json!({
            "model": model.model_name,
            "messages": body_messages,
            "max_tokens": 1024,
            "temperature": 0.2
        })
    };

    // Force JSON mode for compatible providers (prevents malformed JSON from
    // free/small models that omit quotes on keys or return invalid syntax).
    if !reasoning {
        match provider.as_str() {
            "openai" | "openrouter" | "deepseek" => {
                payload.as_object_mut().unwrap().insert(
                    "response_format".to_string(),
                    json!({"type": "json_object"}),
                );
            }
            _ => {}
        }
    }

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key));

    if provider == "openrouter" {
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

    let mut payload = if model_is_reasoning(model) {
        json!({
            "model": model.model_name,
            "max_tokens": 2048,
            "messages": body_messages
        })
    } else {
        json!({
            "model": model.model_name,
            "max_tokens": 1024,
            "temperature": 0.2,
            "messages": body_messages
        })
    };
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
    model_id: Option<String>,
) -> Result<bool, String> {
    // Resolve the real key: typed key takes priority; fall back to stored key.
    let real_key = resolve_probe_key(&api_key, model_id.as_deref())?;
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
    Ok(test_vision_capability(&model, &real_key).await)
}

/// Resolve a real API key for probe commands:
///   - If the caller passed a non-empty, non-placeholder key → use it.
///   - Otherwise look up the real key by model_id from Credential Manager.
fn resolve_probe_key(typed: &str, model_id: Option<&str>) -> Result<String, String> {
    if !typed.is_empty() && !typed.contains('•') {
        return Ok(typed.to_string());
    }
    let id = model_id.ok_or_else(|| "No API key provided and no model ID to look up stored key.".to_string())?;
    crate::storage::keychain::get_api_key_raw_internal(id)
        .ok_or_else(|| "No saved key found on this device. Paste your API key in the field above and test again.".to_string())
}

/// Tauri command — heuristic check: does this model name look like a reasoning model?
/// Used by the frontend to auto-classify models when the user adds them.
#[tauri::command]
pub fn detect_model_reasoning(provider_type: String, model_name: String) -> bool {
    let model = crate::storage::sqlite::CustomModel {
        id: "detect".to_string(),
        provider_type,
        model_name,
        display_name: "detect".to_string(),
        base_url: None,
        role_vision: false,
        role_coding: false,
        role_writing: false,
        is_active: false,
    };
    model_is_reasoning(&model)
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


// ── Modality probes (audio / video) ──────────────────────────────────────────

use base64::{Engine as _, engine::general_purpose::STANDARD};

/// Resolve the chat-completions base URL for a provider.
fn resolve_base_url(provider: &str, base_url: &Option<String>) -> String {
    match provider {
        "openai"     => "https://api.openai.com/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        "deepseek"   => "https://api.deepseek.com/v1".to_string(),
        _            => base_url.clone().unwrap_or_else(|| "http://localhost:1234/v1".to_string()),
    }
}

/// Builds a minimal valid silent WAV file (44-byte header, no samples), base64-encoded.
fn minimal_wav_base64() -> String {
    let mut wav: Vec<u8> = Vec::with_capacity(44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&36u32.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());     // PCM
    wav.extend_from_slice(&1u16.to_le_bytes());     // mono
    wav.extend_from_slice(&8000u32.to_le_bytes());  // sample rate
    wav.extend_from_slice(&8000u32.to_le_bytes());  // byte rate
    wav.extend_from_slice(&1u16.to_le_bytes());     // block align
    wav.extend_from_slice(&8u16.to_le_bytes());     // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&0u32.to_le_bytes());     // 0 data bytes
    STANDARD.encode(&wav)
}

/// Interprets a probe HTTP result for a given modality keyword.
/// Returns true if the modality is supported.
///   - 200            => supported
///   - 401/403        => auth error, cannot determine -> false
///   - error mentions the modality / "unsupported" / "not support" => NOT supported
///   - error mentions "invalid"/"format"/"decode"/"corrupt"/"size" => the model TRIED
///       to process the media (so it accepts the modality) => supported
fn interpret_modality_response(status: u16, body: &str, modality: &str) -> bool {
    if status == 200 { return true; }
    if status == 401 || status == 403 { return false; }

    let b = body.to_lowercase();

    // Explicit "not supported" signals → modality unavailable
    let unsupported = b.contains(&format!("does not support {}", modality))
        || b.contains(&format!("not support {}", modality))
        || b.contains(&format!("{} not supported", modality))
        || b.contains(&format!("{}_url", modality))     // e.g. "video_url is not a valid content type"
        || b.contains("unsupported")
        || b.contains("not a valid content")
        || b.contains("invalid content type")
        || b.contains("unknown variant")
        || b.contains("modality");

    // "Tried to decode" signals → modality accepted (model attempted processing)
    let tried_to_process = b.contains("invalid")
        || b.contains("decode")
        || b.contains("corrupt")
        || b.contains("format")
        || b.contains("too small")
        || b.contains("duration");

    if unsupported && !tried_to_process {
        false
    } else {
        tried_to_process
    }
}

/// Probe whether the model accepts audio input (OpenAI input_audio content type).
pub async fn test_audio_capability(
    provider: &str, model_name: &str, base_url: &Option<String>, api_key: &str,
) -> bool {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(c) => c, Err(_) => return false,
    };
    // Anthropic / DeepSeek don't support audio input in chat API
    if provider == "anthropic" { return false; }

    let url = format!("{}/chat/completions", resolve_base_url(provider, base_url).trim_end_matches('/'));
    let payload = json!({
        "model": model_name,
        "max_tokens": 5,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Say OK."},
                {"type": "input_audio", "input_audio": {"data": minimal_wav_base64(), "format": "wav"}}
            ]
        }]
    });
    let mut req = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");
    if provider == "openrouter" {
        req = req.header("HTTP-Referer", "https://github.com/sayanf22/omni").header("X-Title", "Omni");
    }
    match req.json(&payload).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            interpret_modality_response(status, &body, "audio")
        }
        Err(_) => false,
    }
}

/// Probe whether the model accepts video input (OpenRouter video_url content type).
pub async fn test_video_capability(
    provider: &str, model_name: &str, base_url: &Option<String>, api_key: &str,
) -> bool {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(c) => c, Err(_) => return false,
    };
    // Only OpenRouter (and some custom gateways) expose video_url. OpenAI/DeepSeek/Anthropic don't.
    if provider == "openai" || provider == "deepseek" || provider == "anthropic" { return false; }

    let url = format!("{}/chat/completions", resolve_base_url(provider, base_url).trim_end_matches('/'));
    // Tiny dummy mp4 data URL — non-video models reject the content type immediately;
    // video models attempt to decode (and fail on format) which we treat as "supported".
    let dummy_video = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
    let payload = json!({
        "model": model_name,
        "max_tokens": 5,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Say OK."},
                {"type": "video_url", "video_url": {"url": dummy_video}}
            ]
        }]
    });
    let mut req = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");
    if provider == "openrouter" {
        req = req.header("HTTP-Referer", "https://github.com/sayanf22/omni").header("X-Title", "Omni");
    }
    match req.json(&payload).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            interpret_modality_response(status, &body, "video")
        }
        Err(_) => false,
    }
}

/// Tauri command — probe audio input support.
#[tauri::command]
pub async fn probe_model_audio(
    provider_type: String, model_name: String, base_url: Option<String>, api_key: String,
    model_id: Option<String>,
) -> Result<bool, String> {
    let real_key = resolve_probe_key(&api_key, model_id.as_deref())?;
    Ok(test_audio_capability(&provider_type.to_lowercase(), &model_name, &base_url, &real_key).await)
}

/// Tauri command — probe video input support.
#[tauri::command]
pub async fn probe_model_video(
    provider_type: String, model_name: String, base_url: Option<String>, api_key: String,
    model_id: Option<String>,
) -> Result<bool, String> {
    let real_key = resolve_probe_key(&api_key, model_id.as_deref())?;
    Ok(test_video_capability(&provider_type.to_lowercase(), &model_name, &base_url, &real_key).await)
}
