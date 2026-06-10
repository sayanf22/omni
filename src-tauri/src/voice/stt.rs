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
// Whether a capture session is currently active (for hotkey toggle).
static IS_RECORDING: Mutex<bool> = Mutex::new(false);

/// Is a voice capture session currently active?
pub fn is_recording() -> bool {
    *IS_RECORDING.lock().unwrap()
}

/// Request the current capture to stop early (manual stop / second hotkey press).
pub fn request_stop() {
    if let Ok(mut f) = STOP_FLAG.lock() { *f = true; }
}

/// Start capturing audio from the default input device.
/// Uses CPAL directly — no PowerShell, no MCI, fully cross-process-safe.
/// Emits `voice:level` events (0.0–1.0 RMS amplitude) so the UI can animate a
/// live waveform that reacts to your voice.
pub fn start_mic_recording(app: tauri::AppHandle) -> anyhow::Result<()> {
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
        *IS_RECORDING.lock().unwrap() = true;
    }

    // Spawn recording thread
    let app_for_levels = app.clone();
    let handle = std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use tauri::Emitter;

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

        // Poll loop with LIVE LEVEL emission + AUTO-STOP ON SILENCE (WisperFlow-style).
        // - Emits voice:level every ~60ms for the waveform.
        // - Waits for speech to begin, then stops automatically after a short
        //   trailing silence. Also stops on manual request or hard time caps.
        let start = std::time::Instant::now();
        let mut last_len = 0usize;
        let mut speech_started = false;
        let mut last_voice = std::time::Instant::now();
        const SPEECH_ON: f32 = 0.06;     // level above this = speaking
        const SPEECH_OFF: f32 = 0.04;    // below this = silence
        const TRAILING_SILENCE_MS: u128 = 1200; // stop this long after speech ends
        const NO_SPEECH_TIMEOUT_S: u64 = 6;      // give up if user never speaks
        const MAX_RECORD_S: u64 = 30;            // hard cap

        loop {
            std::thread::sleep(std::time::Duration::from_millis(60));

            let mut level = 0.0_f32;
            if let Ok(buf) = samples_clone.lock() {
                let len = buf.len();
                if len > last_len {
                    let slice = &buf[last_len..len];
                    let sum_sq: f32 = slice.iter().map(|s| s * s).sum();
                    let rms = (sum_sq / slice.len().max(1) as f32).sqrt();
                    level = (rms * 8.0).clamp(0.0, 1.0);
                    last_len = len;
                }
            }
            let _ = app_for_levels.emit("voice:level", level);

            let now = std::time::Instant::now();
            if level >= SPEECH_ON {
                speech_started = true;
                last_voice = now;
            } else if level >= SPEECH_OFF && speech_started {
                last_voice = now; // borderline — still talking
            }

            let manual_stop = STOP_FLAG.lock().map(|f| *f).unwrap_or(true);
            let trailing_silence = speech_started
                && now.duration_since(last_voice).as_millis() >= TRAILING_SILENCE_MS;
            let no_speech = !speech_started && start.elapsed().as_secs() >= NO_SPEECH_TIMEOUT_S;
            let too_long = start.elapsed().as_secs() >= MAX_RECORD_S;

            if manual_stop || trailing_silence || no_speech || too_long {
                tracing::info!(
                    "Recording stop: manual={} trailing_silence={} no_speech={} too_long={}",
                    manual_stop, trailing_silence, no_speech, too_long
                );
                break;
            }
        }
        let _ = app_for_levels.emit("voice:level", 0.0_f32);

        // Stream drops here, stopping capture
        drop(stream);
        tracing::info!("Audio stream stopped, {} samples collected", 
            samples_clone.lock().map(|s| s.len()).unwrap_or(0));

        // Copy samples to global state
        let (captured_samples, cap_rate, cap_channels) = {
            let captured = samples_clone.lock().map(|s| s.clone()).unwrap_or_default();
            if let Ok(mut state) = RECORDING.lock() {
                if let Some(ref mut s) = *state {
                    s.samples = captured.clone();
                    s.is_recording = false;
                }
            }
            (captured, sample_rate, channels)
        };

        // ── Self-complete: transcribe and emit the result ───────────────────
        // Tell the UI we're transcribing, then run STT off-thread.
        let _ = app_for_levels.emit("hotkey:mic_stop", serde_json::json!({}));
        let app_tx = app_for_levels.clone();
        tauri::async_runtime::spawn(async move {
            // Reset recording flags now that capture is done.
            *IS_RECORDING.lock().unwrap() = false;
            *STOP_FLAG.lock().unwrap() = false;

            if captured_samples.is_empty() {
                let _ = app_tx.emit("task:failed", serde_json::json!({
                    "error": "No audio captured. Check your microphone is connected and allowed."
                }));
                return;
            }

            match process_and_transcribe(captured_samples, cap_rate, cap_channels).await {
                Ok(text) if !text.trim().is_empty() => {
                    tracing::info!("Voice transcript: '{}'", text.trim());
                    let _ = app_tx.emit("voice:transcript", serde_json::json!({ "text": text.trim() }));
                }
                Ok(_) => {
                    let _ = app_tx.emit("task:failed", serde_json::json!({
                        "error": "Could not understand speech — nothing was recognized. Speak clearly and try again, or set up local Whisper / ElevenLabs (see docs/14_voice_setup.md)."
                    }));
                }
                Err(e) => {
                    let _ = app_tx.emit("task:failed", serde_json::json!({
                        "error": format!("Transcription failed: {}", e)
                    }));
                }
            }
        });
    });

    let mut thread_handle = RECORDING_THREAD.lock().unwrap();
    *thread_handle = Some(handle);

    Ok(())
}

/// Resample + write WAV + transcribe through the engine priority chain.
/// Shared by the auto-stop recording path and the manual stop command.
pub async fn process_and_transcribe(samples: Vec<f32>, sample_rate: u32, channels: u16) -> anyhow::Result<String> {
    use tokio::time::{timeout, Duration};

    // Convert to 16 kHz mono (required by Whisper; accepted by all engines).
    let mono16k = downmix_and_resample_16k(&samples, sample_rate, channels);
    let temp_path = std::env::temp_dir().join("omni_input.wav");
    write_wav_file(&temp_path, &mono16k, 16_000, 1)?;

    let result = if let Some(text) = try_local_whisper(&temp_path).await {
        tracing::info!("Local Whisper STT: '{}'", text);
        text
    } else {
        let key_opt = get_key("elevenlabs").ok().flatten()
            .or_else(|| get_key("elevenlabs_api_key").ok().flatten());
        if let Some(key) = key_opt.filter(|k| !k.is_empty() && !k.contains('•')) {
            match timeout(Duration::from_secs(25), call_elevenlabs_stt(&temp_path, &key)).await {
                Ok(Ok(text)) => text,
                Ok(Err(e)) => { tracing::warn!("ElevenLabs failed ({}), SAPI fallback", e); sapi_with_timeout(&temp_path).await? }
                Err(_) => { tracing::warn!("ElevenLabs timed out, SAPI fallback"); sapi_with_timeout(&temp_path).await? }
            }
        } else {
            sapi_with_timeout(&temp_path).await?
        }
    };

    let _ = std::fs::remove_file(&temp_path);
    Ok(result)
}

/// Stop recording, write WAV, transcribe via ElevenLabs or SAPI fallback.
pub async fn stop_mic_recording() -> anyhow::Result<String> {
    // Signal the recording thread to stop. It transcribes + emits voice:transcript itself.
    request_stop();
    Ok(String::new())
}

#[allow(dead_code)]
async fn _legacy_stop_unused() -> anyhow::Result<String> {
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

    // Convert to 16 kHz mono — required by Whisper, accepted by ElevenLabs & SAPI,
    // smaller file = faster upload/transcription.
    let mono16k = downmix_and_resample_16k(&samples, sample_rate, channels);

    // Write WAV file (16 kHz mono)
    let temp_path = std::env::temp_dir().join("omni_input.wav");
    write_wav_file(&temp_path, &mono16k, 16_000, 1)?;

    // ── Transcription priority (each guarded by a timeout so it never hangs) ─
    //   1. Local Whisper (whisper.cpp) — fully offline, fast, private, accurate.
    //   2. ElevenLabs Scribe — cloud, most accurate, needs API key + internet.
    //   3. Windows SAPI — zero-setup offline fallback (lower accuracy).
    use tokio::time::{timeout, Duration};

    let result = if let Some(text) = try_local_whisper(&temp_path).await {
        tracing::info!("Local Whisper STT: '{}'", text);
        text
    } else {
        let key_opt = get_key("elevenlabs").ok().flatten()
            .or_else(|| get_key("elevenlabs_api_key").ok().flatten());

        if let Some(key) = key_opt.filter(|k| !k.is_empty() && !k.contains('•')) {
            match timeout(Duration::from_secs(25), call_elevenlabs_stt(&temp_path, &key)).await {
                Ok(Ok(text)) => {
                    tracing::info!("ElevenLabs STT: '{}'", text);
                    text
                }
                Ok(Err(e)) => {
                    tracing::warn!("ElevenLabs STT failed ({}), falling back to SAPI", e);
                    sapi_with_timeout(&temp_path).await?
                }
                Err(_) => {
                    tracing::warn!("ElevenLabs STT timed out, falling back to SAPI");
                    sapi_with_timeout(&temp_path).await?
                }
            }
        } else {
            tracing::info!("No local Whisper or ElevenLabs key — using Windows SAPI");
            sapi_with_timeout(&temp_path).await?
        }
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
        .text("model_id", "scribe_v1")
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

// ── Audio: downmix to mono + resample to 16 kHz ───────────────────────────────

/// Converts interleaved multi-channel f32 samples at `rate` Hz into mono 16 kHz.
/// Whisper requires 16 kHz mono; ElevenLabs/SAPI also accept it.
fn downmix_and_resample_16k(samples: &[f32], rate: u32, channels: u16) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let ch = channels.max(1) as usize;

    // 1) Downmix to mono by averaging channels.
    let mono: Vec<f32> = if ch == 1 {
        samples.to_vec()
    } else {
        samples
            .chunks(ch)
            .map(|frame| frame.iter().copied().sum::<f32>() / ch as f32)
            .collect()
    };

    // 2) Resample to 16 kHz with simple linear interpolation.
    let target_rate = 16_000u32;
    if rate == target_rate {
        return mono;
    }
    let ratio = target_rate as f64 / rate as f64;
    let out_len = ((mono.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

// ── Local Whisper (whisper.cpp) — fully offline STT ───────────────────────────

/// Directory where the local Whisper engine + model live: %APPDATA%\Omni\whisper\
fn whisper_dir() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("Omni");
    p.push("whisper");
    p
}

/// Locate the whisper.cpp CLI binary if the user installed one.
/// Accepts common names: whisper-cli.exe (current), main.exe (older builds).
fn find_whisper_binary() -> Option<PathBuf> {
    let dir = whisper_dir();
    for name in ["whisper-cli.exe", "main.exe", "whisper.exe"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Locate the GGML model file (any ggml-*.bin in the whisper dir).
fn find_whisper_model() -> Option<PathBuf> {
    let dir = whisper_dir();
    // Prefer an explicit, fast English model if present.
    for preferred in ["ggml-base.en.bin", "ggml-small.en.bin", "ggml-tiny.en.bin", "ggml-base.bin"] {
        let p = dir.join(preferred);
        if p.exists() {
            return Some(p);
        }
    }
    // Otherwise take the first ggml-*.bin we find.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().map_or(false, |x| x == "bin") {
                let n = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                if n.starts_with("ggml-") {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Returns true if a usable local Whisper engine (binary + model) is installed.
pub fn local_whisper_available() -> bool {
    find_whisper_binary().is_some() && find_whisper_model().is_some()
}

/// Transcribe a 16 kHz mono WAV with the local whisper.cpp CLI.
/// Returns None if Whisper isn't installed or transcription failed (so callers
/// can fall back to cloud/SAPI).
async fn try_local_whisper(wav_path: &PathBuf) -> Option<String> {
    let bin = find_whisper_binary()?;
    let model = find_whisper_model()?;

    tracing::info!("Using local Whisper: {:?} with model {:?}", bin, model);

    // -nt = no timestamps, -np = no progress prints, output transcription to stdout.
    let output = tokio::process::Command::new(&bin)
        .args([
            "-m", &model.to_string_lossy(),
            "-f", &wav_path.to_string_lossy(),
            "-nt", "-np",
            "-l", "en",
            "-t", "4", // threads
        ])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        tracing::warn!("Local Whisper exited with error: {}", String::from_utf8_lossy(&output.stderr));
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('[') && !l.starts_with("whisper_"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if text.is_empty() { None } else { Some(text) }
}

/// Tauri command — report which STT engine is active so the UI can inform the user.
#[tauri::command]
pub fn get_stt_status() -> serde_json::Value {
    let local = local_whisper_available();
    let has_elevenlabs = crate::storage::keychain::get_key("elevenlabs")
        .ok().flatten()
        .map(|k| !k.is_empty() && !k.contains('•'))
        .unwrap_or(false);

    let engine = if local {
        "local_whisper"
    } else if has_elevenlabs {
        "elevenlabs"
    } else {
        "windows_sapi"
    };

    serde_json::json!({
        "engine": engine,
        "local_whisper_available": local,
        "elevenlabs_configured": has_elevenlabs,
        "whisper_dir": whisper_dir().to_string_lossy(),
    })
}


// ── Windows SAPI offline fallback ─────────────────────────────────────────────

/// SAPI with a hard timeout so it can never hang the UI for minutes.
async fn sapi_with_timeout(wav_path: &PathBuf) -> anyhow::Result<String> {
    match tokio::time::timeout(std::time::Duration::from_secs(20), run_offline_sapi_stt(wav_path)).await {
        Ok(Ok(t)) => Ok(t),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow::anyhow!(
            "Speech transcription timed out. For fast, reliable voice, set up local Whisper \
             or add an ElevenLabs key (see docs/14_voice_setup.md)."
        )),
    }
}

async fn run_offline_sapi_stt(wav_path: &PathBuf) -> anyhow::Result<String> {
    let path_str = wav_path.to_string_lossy().to_string();
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
