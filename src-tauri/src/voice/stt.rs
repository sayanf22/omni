/// STT module — records audio via CPAL (direct Windows audio API, no PowerShell),
/// transcribes with ElevenLabs Scribe v2 if key is configured, falls back to Windows SAPI.

use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use crate::storage::keychain::get_key;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

/// Resolve the main (non-modifier) virtual-key code of the configured mic hotkey
/// so we can detect when the user releases it (walkie-talkie). Defaults to 'A'.
fn mic_main_vk() -> Option<i32> {
    let hk = crate::storage::sqlite::get_setting_internal("hotkey_mic")
        .ok().flatten().unwrap_or_else(|| "Ctrl+Shift+A".to_string());
    let last = hk.split('+').map(|s| s.trim()).filter(|s| {
        let l = s.to_lowercase();
        l != "ctrl" && l != "control" && l != "shift" && l != "alt" && l != "win" && l != "meta" && l != "super"
    }).last()?;
    let up = last.to_uppercase();
    let bytes = up.as_bytes();
    if bytes.len() == 1 && bytes[0].is_ascii_alphanumeric() {
        return Some(bytes[0] as i32); // 'A'-'Z' and '0'-'9' map directly to VK codes
    }
    Some(0x41) // fallback: 'A'
}

/// Is the given virtual-key currently physically pressed?
fn key_is_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// Find an active OpenAI model's API key — one OpenAI key powers chat + STT + TTS.
fn openai_key() -> Option<String> {
    let models = crate::storage::sqlite::get_custom_models_db().ok()?;
    for m in models {
        if m.is_active && m.provider_type.to_lowercase() == "openai" {
            if let Ok(Some(k)) = crate::storage::keychain::get_key(&m.id) {
                if !k.is_empty() && !k.contains('•') {
                    return Some(k);
                }
            }
        }
    }
    None
}

/// Transcribe a WAV with OpenAI Whisper (whisper-1). Uses the same OpenAI key
/// the user already configured for chat — no separate voice key needed.
async fn try_openai_whisper(wav_path: &PathBuf, api_key: &str) -> Option<String> {
    let bytes = std::fs::read(wav_path).ok()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25)).build().ok()?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio.wav").mime_str("audio/wav").ok()?;
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("language", "en")
        .part("file", part);
    let resp = client.post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form).send().await.ok()?;
    if !resp.status().is_success() {
        tracing::warn!("OpenAI Whisper STT error: {}", resp.status());
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    json["text"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

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
// When true, the next capture is a MIC TEST: its transcript is returned via
// `voice:test_result` instead of being run as an agent task.
static TEST_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

        // Walkie-talkie detection: if the hotkey is still held shortly after
        // start, we're in HOLD mode -> stop the instant it's released. If it was
        // a quick tap, fall back to auto-stop-on-silence (tap-to-talk).
        let main_vk = mic_main_vk();
        let mut mode_decided = false;
        let mut walkie = false;

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

            // Walkie-talkie: decide mode after a short grace, then watch for release.
            let mut key_released_stop = false;
            if let Some(vk) = main_vk {
                let down = key_is_down(vk);
                if !mode_decided && start.elapsed().as_millis() >= 350 {
                    walkie = down; // still holding after 350ms = walkie-talkie
                    mode_decided = true;
                }
                if walkie && mode_decided && !down {
                    key_released_stop = true; // released the hotkey -> send
                }
            }

            let manual_stop = STOP_FLAG.lock().map(|f| *f).unwrap_or(true);
            // Silence auto-stop only in TAP mode (not while holding in walkie mode).
            let trailing_silence = !walkie && speech_started
                && now.duration_since(last_voice).as_millis() >= TRAILING_SILENCE_MS;
            let no_speech = !speech_started && start.elapsed().as_secs() >= NO_SPEECH_TIMEOUT_S;
            let too_long = start.elapsed().as_secs() >= MAX_RECORD_S;

            if manual_stop || key_released_stop || trailing_silence || no_speech || too_long {
                tracing::info!(
                    "Recording stop: manual={} key_released={} silence={} no_speech={} too_long={} walkie={}",
                    manual_stop, key_released_stop, trailing_silence, no_speech, too_long, walkie
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

            let is_test = TEST_MODE.swap(false, std::sync::atomic::Ordering::SeqCst);
            match process_and_transcribe(captured_samples, cap_rate, cap_channels).await {
                Ok(text) if !text.trim().is_empty() => {
                    tracing::info!("Voice transcript: '{}'", text.trim());
                    if is_test {
                        let _ = app_tx.emit("voice:test_result", serde_json::json!({ "text": text.trim(), "ok": true }));
                    } else {
                        let _ = app_tx.emit("voice:transcript", serde_json::json!({ "text": text.trim() }));
                    }
                }
                Ok(_) => {
                    if is_test {
                        let _ = app_tx.emit("voice:test_result", serde_json::json!({ "text": "", "ok": false, "error": "Nothing was recognized. Speak a bit louder/clearer." }));
                    } else {
                        let _ = app_tx.emit("task:failed", serde_json::json!({
                            "error": "Could not understand speech — nothing was recognized. Speak clearly and try again, or set up local Whisper / ElevenLabs (see docs/14_voice_setup.md)."
                        }));
                    }
                }
                Err(e) => {
                    if is_test {
                        let _ = app_tx.emit("voice:test_result", serde_json::json!({ "text": "", "ok": false, "error": format!("{}", e) }));
                    } else {
                        let _ = app_tx.emit("task:failed", serde_json::json!({
                            "error": format!("Transcription failed: {}", e)
                        }));
                    }
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
    } else if let Some(text) = {
        // OpenAI Whisper using the user's existing OpenAI key (one key does it all)
        if let Some(k) = openai_key() { try_openai_whisper(&temp_path, &k).await } else { None }
    } {
        tracing::info!("OpenAI Whisper STT: '{}'", text);
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

    // Write a .txt next to the wav (-otxt) AND read stdout — most reliable.
    let out_base = wav_path.with_extension(""); // whisper appends .txt
    let txt_path = wav_path.with_extension("txt");
    let _ = std::fs::remove_file(&txt_path);

    let output = tokio::process::Command::new(&bin)
        .args([
            "-m", &model.to_string_lossy(),
            "-f", &wav_path.to_string_lossy(),
            "-l", "en",
            "-nt",                 // no timestamps
            "-otxt",               // write <wav>.txt
            "-of", &out_base.to_string_lossy(),
            "-t", "4",
        ])
        // Run with the whisper dir as CWD so its DLLs resolve.
        .current_dir(whisper_dir())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        tracing::warn!("Local Whisper exited with error: {}", stderr);
        // Still try reading any partial txt below.
    }

    // 1) Prefer the .txt file output.
    if let Ok(text) = std::fs::read_to_string(&txt_path) {
        let _ = std::fs::remove_file(&txt_path);
        let clean = text.trim().to_string();
        if !clean.is_empty() {
            return Some(clean);
        }
    }

    // 2) Fall back to parsing stdout.
    let text = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('[') && !l.starts_with("whisper_") && !l.starts_with("main:"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    if text.is_empty() { None } else { Some(text) }
}

/// Tauri command — start a MIC TEST: records (auto-stops on silence), transcribes,
/// and emits `voice:test_result` with the text. Does NOT run an agent task.
#[tauri::command]
pub fn start_voice_test(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    TEST_MODE.store(true, std::sync::atomic::Ordering::SeqCst);
    // Show the top-right overlay with the live waveform during the test.
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.set_focus();
    }
    let _ = app.emit("hotkey:mic_start", serde_json::json!({}));
    start_mic_recording(app).map_err(|e| {
        TEST_MODE.store(false, std::sync::atomic::Ordering::SeqCst);
        e.to_string()
    })
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

// ── One-click offline Whisper setup (download model + engine) ─────────────────

/// Stream-download a URL to a file, emitting progress as `whisper:download`.
async fn download_file(
    url: &str,
    dest: &PathBuf,
    app: &tauri::AppHandle,
    stage: &str,
) -> anyhow::Result<()> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("Download failed ({}): {}", resp.status(), url));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = resp.bytes_stream();
    let mut last_pct = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = downloaded * 100 / total;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("whisper:download", serde_json::json!({
                    "stage": stage, "pct": pct
                }));
            }
        }
    }
    file.flush().await?;
    Ok(())
}

/// Extract a zip archive into `dir`, flattening files to the top level.
fn extract_zip_flat(zip_path: &PathBuf, dir: &PathBuf) -> anyhow::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() { continue; }
        let name = match entry.enclosed_name() {
            Some(p) => p.file_name().map(|f| f.to_string_lossy().to_string()),
            None => None,
        };
        let Some(name) = name else { continue };
        // Only keep what we need: the exe and its DLLs.
        let nl = name.to_lowercase();
        if nl.ends_with(".exe") || nl.ends_with(".dll") {
            let out_path = dir.join(&name);
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

/// Query the GitHub API for the latest whisper.cpp release and return the
/// download URL of the `whisper-bin-x64.zip` asset (CPU build). None on failure.
async fn resolve_whisper_bin_url() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build().ok()?;
    let resp = client
        .get("https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest")
        .header("User-Agent", "Omni-Agent")
        .header("Accept", "application/vnd.github+json")
        .send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let json: serde_json::Value = resp.json().await.ok()?;
    let assets = json["assets"].as_array()?;
    for a in assets {
        if a["name"].as_str() == Some("whisper-bin-x64.zip") {
            return a["browser_download_url"].as_str().map(|s| s.to_string());
        }
    }
    None
}

/// Tauri command — download a working offline Whisper engine + English model
/// into %APPDATA%\Omni\whisper\ so voice works locally with zero manual steps.
/// Emits `whisper:download` progress events. Safe to call repeatedly (skips
/// files that already exist).
#[tauri::command]
pub async fn download_whisper(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let dir = whisper_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 1) Model (~148 MB) from HuggingFace (stable URL).
    let model_path = dir.join("ggml-base.en.bin");
    if !model_path.exists() {
        let _ = app.emit("whisper:download", serde_json::json!({"stage":"model","pct":0}));
        download_file(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
            &model_path, &app, "model",
        ).await.map_err(|e| format!("Model download failed: {}", e))?;
    }

    // 2) Engine binary (whisper.cpp prebuilt Windows x64).
    if find_whisper_binary().is_none() {
        let _ = app.emit("whisper:download", serde_json::json!({"stage":"engine","pct":0}));
        // Resolve the CURRENT release asset URL from the GitHub API so we never
        // 404 on a version that has been superseded. Fall back to a pinned URL.
        let bin_url = resolve_whisper_bin_url().await
            .unwrap_or_else(|| "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip".to_string());
        let zip_path = dir.join("whisper-bin.zip");
        download_file(&bin_url, &zip_path, &app, "engine")
            .await.map_err(|e| format!("Engine download failed: {}", e))?;
        extract_zip_flat(&zip_path, &dir).map_err(|e| format!("Engine extract failed: {}", e))?;
        let _ = std::fs::remove_file(&zip_path);
    }

    let ok = find_whisper_binary().is_some() && find_whisper_model().is_some();
    let _ = app.emit("whisper:download", serde_json::json!({
        "stage": if ok { "done" } else { "error" }, "pct": 100
    }));
    if ok {
        Ok("Offline voice (Whisper) is ready.".to_string())
    } else {
        Err("Whisper files missing after download. Check your connection and try again.".to_string())
    }
}
