use std::sync::Mutex;
use std::process::Command;
use crate::storage::keychain::get_key;

static MCI_RECORDING: Mutex<bool> = Mutex::new(false);

pub fn start_mic_recording() -> anyhow::Result<()> {
    let mut recording = MCI_RECORDING.lock().unwrap();
    if *recording {
        return Ok(());
    }

    // Call powershell to start recording using winmm.dll MCI commands
    let script = "\
        $member = '[DllImport(\"winmm.dll\", EntryPoint=\"mciSendString\", CharSet=CharSet.Ansi)] public static extern int mciSendString(string lpstrCommand, System.Text.StringBuilder lpstrReturnString, int uReturnLength, IntPtr hwndCallback);'; \
        $winaudio = Add-Type -MemberDefinition $member -Name \"WinAudio\" -PassThru; \
        $winaudio::mciSendString(\"close recsound\", $null, 0, [IntPtr]::Zero); \
        $winaudio::mciSendString(\"open new type waveaudio alias recsound\", $null, 0, [IntPtr]::Zero); \
        $winaudio::mciSendString(\"record recsound\", $null, 0, [IntPtr]::Zero); \
    ";

    Command::new("powershell")
        .args(&["-NoProfile", "-Command", script])
        .spawn()?;

    *recording = true;
    Ok(())
}

pub async fn stop_mic_recording() -> anyhow::Result<String> {
    let was_recording = {
        let mut recording = MCI_RECORDING.lock().unwrap();
        if !*recording {
            false
        } else {
            *recording = false;
            true
        }
    };
    
    if !was_recording {
        return Ok(String::new());
    }

    // Get a temporary path to save the wav file
    let mut temp_path = std::env::temp_dir();
    temp_path.push("omni_input.wav");
    let temp_path_str = temp_path.to_string_lossy().replace('\\', "/");

    // Stop recording, save to file, and close MCI
    let script = format!(
        "$member = '[DllImport(\"winmm.dll\", EntryPoint=\"mciSendString\", CharSet=CharSet.Ansi)] public static extern int mciSendString(string lpstrCommand, System.Text.StringBuilder lpstrReturnString, int uReturnLength, IntPtr hwndCallback);'; \
         $winaudio = Add-Type -MemberDefinition $member -Name \"WinAudio\" -PassThru; \
         $winaudio::mciSendString(\"stop recsound\", $null, 0, [IntPtr]::Zero); \
         $winaudio::mciSendString(\"save recsound '{}'\", $null, 0, [IntPtr]::Zero); \
         $winaudio::mciSendString(\"close recsound\", $null, 0, [IntPtr]::Zero);",
        temp_path_str
    );

    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", &script])
        .output()?;

    if !output.status.success() {
        return Err(anyhow::anyhow!("Failed to save recorded audio: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // Await briefly for the file to be written to disk
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    if !temp_path.exists() {
        return Err(anyhow::anyhow!("Recorded file does not exist at {:?}", temp_path));
    }

    // 1. Check if ElevenLabs API Key is present in Keychain
    let key_opt = get_key("elevenlabs").ok().flatten().or_else(|| get_key("elevenlabs_api_key").ok().flatten());
    if let Some(key) = key_opt {
        if !key.is_empty() {
            // Attempt ElevenLabs speech-to-text API call
            match call_elevenlabs_stt(&temp_path, &key).await {
                Ok(text) => {
                    let _ = std::fs::remove_file(temp_path);
                    return Ok(text);
                }
                Err(e) => {
                    eprintln!("ElevenLabs STT error, falling back to SAPI: {:?}", e);
                }
            }
        }
    }

    // 2. Offline fallback: Windows SAPI Speech Recognition
    let result = run_offline_sapi_stt(&temp_path_str).await;
    let _ = std::fs::remove_file(temp_path);
    result
}

async fn call_elevenlabs_stt(file_path: &std::path::Path, api_key: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let file_bytes = std::fs::read(file_path)?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;

    let form = reqwest::multipart::Form::new()
        .text("model_id", "scribe_v2")
        .part("file", part);

    let response = client.post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", api_key)
        .multipart(form)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!("ElevenLabs STT API error ({}): {}", status, text));
    }

    let json: serde_json::Value = serde_json::from_str(&text)?;
    let transcript = json["text"].as_str().ok_or_else(|| anyhow::anyhow!("No text in transcript response"))?;
    Ok(transcript.to_string())
}

async fn run_offline_sapi_stt(wav_path: &str) -> anyhow::Result<String> {
    // SAPI transcription via PowerShell System.Speech
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine; \
         $engine.SetInputToWaveFile('{}'); \
         $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); \
         $result = $engine.Recognize(); \
         if ($result -ne $null) {{ write-output $result.Text }}",
        wav_path
    );

    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", &script])
        .output()?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(text)
}
