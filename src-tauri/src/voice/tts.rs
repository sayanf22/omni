use std::process::Command;
use crate::storage::keychain::get_key;
use std::io::Cursor;
use rodio::{Decoder, OutputStream, Sink};

/// Speaks text aloud. Order: local Windows TTS by default (offline, zero-setup),
/// or ElevenLabs if a key is configured AND the user opted into cloud voice.
pub async fn speak_text(text: &str) -> anyhow::Result<()> {
    let text = text.trim();
    if text.is_empty() { return Ok(()); }

    // Engine preference: "local" (default) | "cloud". Local is offline + instant.
    let engine = crate::storage::sqlite::get_setting_internal("tts_engine")
        .ok().flatten().unwrap_or_else(|| "local".to_string());

    // Cloud TTS: prefer OpenAI (one key does everything), then ElevenLabs.
    if engine == "cloud" {
        // OpenAI tts-1 using the user's existing OpenAI model key.
        if let Some(key) = openai_key() {
            match call_openai_tts(text, &key).await {
                Ok(audio_bytes) => { play_audio(audio_bytes); return Ok(()); }
                Err(e) => eprintln!("OpenAI TTS error, trying next: {:?}", e),
            }
        }
        let key_opt = get_key("elevenlabs").ok().flatten()
            .or_else(|| get_key("elevenlabs_api_key").ok().flatten());
        if let Some(key) = key_opt.filter(|k| !k.is_empty() && !k.contains('•')) {
            match call_elevenlabs_tts(text, &key).await {
                Ok(audio_bytes) => { play_audio(audio_bytes); return Ok(()); }
                Err(e) => eprintln!("ElevenLabs TTS error, using local voice: {:?}", e),
            }
        }
    }

    // Local Windows TTS (offline, no key, no window flash).
    speak_offline(text)
}

/// Play raw audio bytes (mp3/wav) via rodio on a background thread.
fn play_audio(audio_bytes: Vec<u8>) {
    std::thread::spawn(move || {
        if let Ok((_stream, handle)) = OutputStream::try_default() {
            if let Ok(sink) = Sink::try_new(&handle) {
                let cursor = Cursor::new(audio_bytes);
                if let Ok(source) = Decoder::new(cursor) {
                    sink.append(source);
                    sink.sleep_until_end();
                }
            }
        }
    });
}

/// Find an active OpenAI model's API key (shared with STT/chat).
fn openai_key() -> Option<String> {
    let models = crate::storage::sqlite::get_custom_models_db().ok()?;
    for m in models {
        if m.is_active && m.provider_type.to_lowercase() == "openai" {
            if let Ok(Some(k)) = crate::storage::keychain::get_key(&m.id) {
                if !k.is_empty() && !k.contains('•') { return Some(k); }
            }
        }
    }
    None
}

/// OpenAI text-to-speech (tts-1). Returns mp3 bytes.
async fn call_openai_tts(text: &str, api_key: &str) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30)).build()?;
    let payload = serde_json::json!({
        "model": "tts-1",
        "voice": "alloy",
        "input": text,
    });
    let resp = client.post("https://api.openai.com/v1/audio/speech")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&payload).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("OpenAI TTS error ({}): {}", resp.status(), resp.text().await.unwrap_or_default()));
    }
    Ok(resp.bytes().await?.to_vec())
}

async fn call_elevenlabs_tts(text: &str, api_key: &str) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::new();
    let voice_id = "21m00Tcm4TlvDq8ikWAM"; // default voice (Rachel)
    let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{}/stream", voice_id);

    let payload = serde_json::json!({
        "text": text,
        "model_id": "eleven_turbo_v2_5",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.8
        }
    });

    let response = client.post(&url)
        .header("xi-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let err_text = response.text().await?;
        return Err(anyhow::anyhow!("ElevenLabs TTS API error ({}): {}", status, err_text));
    }

    let bytes = response.bytes().await?;
    Ok(bytes.to_vec())
}

fn speak_offline(text: &str) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Escape single quotes for PowerShell, cap very long text so it doesn't
    // monologue (speak the first ~400 chars — results are usually short).
    let capped: String = text.chars().take(400).collect();
    let clean_text = capped.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $s.Rate = 1; \
         $s.Speak('{}')",
        clean_text
    );

    Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW) // no console window flash
        .spawn()?;

    Ok(())
}
