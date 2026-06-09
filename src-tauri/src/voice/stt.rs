/// STT module — records audio via CPAL (direct Windows audio API, no PowerShell),
/// transcribes with ElevenLabs Scribe v2 if key is configured, falls back to Windows SAPI.

use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use crate::storage::keychain::get_key;

// ── Global recording state ────────────────────────────────────────────────────

struct RecordingState {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
    is_recording: bool,
}

static RECORDING: Mutex<Option<RecordingState>> = Mutex::new(None);
// Thread handle for the recording thread
static RECORDING_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
// Shared flag to signal the recording thread to stop
static STOP_FLAG: Mutex<bool> = Mutex::new(false);

/// Start capturing audio from the default input device.
/// Uses CPAL directly — no PowerShell, no MCI, fully cross-process-safe.
pub fn start_mic_recording() -> anyhow::Result<()> {
    use cpal::traits::{DeviceTrait, HostTrait};

    // Stop any existing recording first
    {
        let mut flag = STOP_FLAG.lock().unwrap();
        *flag = true;
    }
    // Small wait for old thread to notice
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Reset state
    {
        let mut flag = STOP_FLAG.lock().unwrap();
        *flag = false;
        let mut state = RECORDING.lock().unwrap();
        *state = None;
    }

    // Get default input device
    let host = cpal::default_host();
    let device = host.default_input_device()
        .ok_or_else(|| anyhow::anyhow!("No default input device found. Check microphone permissions."))?;

    let config = device.default_input_config()
        .map_err(|e| anyhow::anyhow!("Failed to get input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    tracing::info!("Recording: device={}, rate={}Hz, channels={}", 
        device.name().unwrap_or_default(), sample_rate, channels);

    // Shared sample buffer
    let samples_arc: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let samples_clone = samples_arc.clone();

    // Initialize global state
    {
        let mut state = RECORDING.lock().unwrap();
        *state = Some(RecordingState {
            samples: Vec::new(),
            sample_rate,
            channels,
            is_recording: true,
        });
    }

    // Spawn recording thread
    let handle = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                tracing::error!("Recording thread: no input device");
                return;
            }
        };

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Recording thread: config error: {}", e);
                return;
            }
        };

        let samples_for_callback = samples_clone.clone();
        let _stop_flag_clone = Arc::new(());

        // Build stream — capture f32 samples
        let stream_result = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let samples_cb = samples_for_callback.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut s) = samples_cb.lock() {
                            s.extend_from_slice(data);
                        }
                    },
                    |err| tracing::error!("Audio stream error: {}", err),
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let samples_cb = samples_for_callback.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut s) = samples_cb.lock() {
                            s.extend(data.iter().map(|&x| x as f32 / 32768.0));
                        }
                    },
                    |err| tracing::error!("Audio stream error: {}", err),
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let samples_cb = samples_for_callback.clone();
                device.build_input_stream(
                    &config.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        if let Ok(mut s) = samples_cb.lock() {
                            s.extend(data.iter().map(|&x| (x as f32 / 32768.0) - 1.0));
                        }
                    },
                    |err| tracing::error!("Audio stream error: {}", err),
                    None,
                )
            }
            _ => {
                tracing::error!("Unsupported sample format");
                return;
            }
        };

        let stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("Failed to build input stream: {}", e);
                return;
            }
        };

        if let Err(e) = stream.play() {
            tracing::error!("Failed to start stream: {}", e);
            return;
        }

        tracing::info!("Audio stream recording started");

        // Poll until stop flag is set (max 60 seconds to prevent runaway)
        let start = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            
            let should_stop = STOP_FLAG.lock().map(|f| *f).unwrap_or(true);
            if should_stop || start.elapsed().as_secs() > 60 {
                break;
            }
        }

        // Stream drops here, stopping capture
        drop(stream);
        tracing::info!("Audio stream stopped, {} samples collected", 
            samples_clone.lock().map(|s| s.len()).unwrap_or(0));

        // Copy samples to global state
        if let (Ok(captured), Ok(mut state)) = (samples_clone.lock(), RECORDING.lock()) {
            if let Some(ref mut s) = *state {
                s.samples = captured.clone();
                s.is_recording = false;
            }
        }
    });

    let mut thread_handle = RECORDING_THREAD.lock().unwrap();
    *thread_handle = Some(handle);

    Ok(())
}

/// Stop recording, write WAV, transcribe via ElevenLabs or SAPI fallback.
pub async fn stop_mic_recording() -> anyhow::Result<String> {
    // Signal recording thread to stop
    {
        let mut flag = STOP_FLAG.lock().unwrap();
        *flag = true;
    }

    // Wait for thread to finish (with timeout)
    let thread = {
        let mut handle = RECORDING_THREAD.lock().unwrap();
        handle.take()
    };
    if let Some(t) = thread {
        // Give it 2 seconds to drain
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !t.is_finished() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    // Retrieve collected samples
    let (samples, sample_rate, channels) = {
        let state = RECORDING.lock().unwrap();
        match state.as_ref() {
            Some(s) => (s.samples.clone(), s.sample_rate, s.channels),
            None => return Err(anyhow::anyhow!("No recording was in progress")),
        }
    };

    if samples.is_empty() {
        return Err(anyhow::anyhow!(
            "No audio was captured. Check that your microphone is connected and permitted."
        ));
    }

    tracing::info!("Captured {} samples at {}Hz, {} channels", samples.len(), sample_rate, channels);

    // Write WAV file
    let temp_path = std::env::temp_dir().join("omni_input.wav");
    write_wav_file(&temp_path, &samples, sample_rate, channels)?;

    // Transcribe
    let key_opt = get_key("elevenlabs").ok().flatten()
        .or_else(|| get_key("elevenlabs_api_key").ok().flatten());

    let result = if let Some(key) = key_opt.filter(|k| !k.is_empty()) {
        match call_elevenlabs_stt(&temp_path, &key).await {
            Ok(text) => {
                tracing::info!("ElevenLabs STT: '{}'", text);
                text
            }
            Err(e) => {
                tracing::warn!("ElevenLabs STT failed ({}), falling back to SAPI", e);
                run_offline_sapi_stt(&temp_path).await?
            }
        }
    } else {
        tracing::info!("No ElevenLabs key, using Windows SAPI");
        run_offline_sapi_stt(&temp_path).await?
    };

    // Cleanup
    let _ = std::fs::remove_file(&temp_path);
    
    // Reset recording state
    {
        let mut state = RECORDING.lock().unwrap();
        *state = None;
        let mut flag = STOP_FLAG.lock().unwrap();
        *flag = false;
    }

    Ok(result)
}

// ── WAV writer ────────────────────────────────────────────────────────────────

fn write_wav_file(path: &PathBuf, samples: &[f32], sample_rate: u32, channels: u16) -> anyhow::Result<()> {
    use hound::{WavWriter, WavSpec, SampleFormat};

    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(path, spec)
        .map_err(|e| anyhow::anyhow!("Failed to create WAV writer: {}", e))?;

    for &sample in samples {
        let s16 = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer.write_sample(s16)
            .map_err(|e| anyhow::anyhow!("Failed to write WAV sample: {}", e))?;
    }

    writer.finalize()
        .map_err(|e| anyhow::anyhow!("Failed to finalize WAV: {}", e))?;

    tracing::info!("WAV written to {:?} ({} bytes)", path, std::fs::metadata(path).map(|m| m.len()).unwrap_or(0));
    Ok(())
}

// ── ElevenLabs Scribe v2 STT ─────────────────────────────────────────────────

async fn call_elevenlabs_stt(file_path: &PathBuf, api_key: &str) -> anyhow::Result<String> {
    let file_bytes = std::fs::read(file_path)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;

    let form = reqwest::multipart::Form::new()
        .text("model_id", "scribe_v2")
        .part("file", part);

    let response = client
        .post("https://api.elevenlabs.io/v1/speech-to-text")
        .header("xi-api-key", api_key)
        .multipart(form)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;

    if !status.is_success() {
        return Err(anyhow::anyhow!("ElevenLabs STT error ({}): {}", status, text));
    }

    let json: serde_json::Value = serde_json::from_str(&text)?;
    let transcript = json["text"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No 'text' field in ElevenLabs response: {}", text))?;

    Ok(transcript.to_string())
}

// ── Windows SAPI offline fallback ─────────────────────────────────────────────

async fn run_offline_sapi_stt(wav_path: &PathBuf) -> anyhow::Result<String> {
    let path_str = wav_path.to_string_lossy().to_string();
    // Escape backslashes for PowerShell
    let ps_path = path_str.replace('\'', "''");

    let script = format!(
        r#"Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$engine.SetInputToWaveFile('{ps_path}')
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$result = $engine.Recognize()
if ($result -ne $null) {{ Write-Output $result.Text }}"#,
        ps_path = ps_path
    );

    let output = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("SAPI PowerShell failed to spawn: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!("SAPI stderr: {}", stderr);
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    tracing::info!("SAPI result: '{}'", text);
    Ok(text)
}
