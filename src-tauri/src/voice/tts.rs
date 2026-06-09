use std::process::Command;
use crate::storage::keychain::get_key;
use std::io::Cursor;
use rodio::{Decoder, OutputStream, Sink};

pub async fn speak_text(text: &str) -> anyhow::Result<()> {
    // 1. Check if ElevenLabs key is configured
    let key_opt = get_key("elevenlabs").ok().flatten().or_else(|| get_key("elevenlabs_api_key").ok().flatten());
    if let Some(key) = key_opt {
        if !key.is_empty() {
            match call_elevenlabs_tts(text, &key).await {
                Ok(audio_bytes) => {
                    // Play audio bytes using rodio in a separate thread
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
                    return Ok(());
                }
                Err(e) => {
                    eprintln!("ElevenLabs TTS error, falling back to SAPI: {:?}", e);
                }
            }
        }
    }

    // 2. Offline fallback: Windows SAPI TTS
    speak_offline(text)
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
    // Escaping single quotes in PowerShell script
    let clean_text = text.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         $synth.Speak('{}')",
        clean_text
    );

    Command::new("powershell")
        .args(&["-NoProfile", "-Command", &script])
        .spawn()?;
    
    Ok(())
}
