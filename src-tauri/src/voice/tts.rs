use std::process::Command;
use crate::storage::keychain::get_key;
use std::io::Cursor;
use std::path::PathBuf;
use rodio::{Decoder, OutputStream, Sink};

/// Strip AI/markdown artifacts so text reads and SPEAKS like natural language.
/// Removes reasoning tags, code fences, emphasis markers (**, *, _, ~), headings,
/// blockquotes, inline link syntax, and collapses whitespace. This is what makes
/// the agent's spoken/displayed replies clean instead of "asterisk asterisk".
pub fn clean_ai_text(input: &str) -> String {
    let mut s = input.to_string();

    // 1) Remove <think>…</think> reasoning blocks (reasoning models) + stray tags.
    loop {
        if let (Some(start), Some(end)) = (s.find("<think>"), s.find("</think>")) {
            if end > start { s.replace_range(start..end + "</think>".len(), ""); continue; }
        }
        break;
    }
    s = s.replace("<think>", "").replace("</think>", "");

    // 2) Code fences + inline code backticks.
    s = s.replace("```", "");
    s = s.replace('`', "");

    // 3) Markdown emphasis runs (order matters: longest first).
    s = s.replace("***", "").replace("**", "").replace("__", "").replace("~~", "");

    // 4) Markdown links [text](url) -> text, and images ![alt](url) -> alt.
    s = strip_md_links(&s);

    // 5) Per-line: drop leading heading (#), blockquote (>) and bullet markers.
    let lines: Vec<String> = s.lines().map(|line| {
        let mut t = line.trim_start();
        // Strip a leading bullet ("- ", "* ", "• ") once.
        if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("• ")).or_else(|| t.strip_prefix("* ")) {
            t = rest.trim_start();
        }
        t = t.trim_start_matches('#').trim_start_matches('>').trim_start();
        t.to_string()
    }).collect();
    s = lines.join(" ");

    // 6) Any remaining stray emphasis chars used inline.
    s = s.replace('*', "");

    // 7) Collapse all whitespace to single spaces.
    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

/// Replace markdown link/image syntax with just the visible text. UTF-8 safe.
fn strip_md_links(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < n {
        let img = chars[i] == '!' && i + 1 < n && chars[i + 1] == '[';
        let bracket = if img { i + 1 } else { i };
        if bracket < n && chars[bracket] == '[' {
            if let Some(close_rel) = chars[bracket + 1..].iter().position(|&c| c == ']') {
                let close = bracket + 1 + close_rel;
                if close + 1 < n && chars[close + 1] == '(' {
                    if let Some(paren_rel) = chars[close + 2..].iter().position(|&c| c == ')') {
                        let paren = close + 2 + paren_rel;
                        out.extend(chars[bracket + 1..close].iter());
                        i = paren + 1;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Speaks text aloud. Priority (most natural first):
///   1. Cloud (OpenAI tts-1 / ElevenLabs) — only when engine == "cloud" and a key exists.
///   2. Piper — local neural TTS, natural sounding, fully offline (if installed).
///   3. Windows SAPI — robotic but always available, zero setup.
pub async fn speak_text(text: &str) -> anyhow::Result<()> {
    // Clean markdown / reasoning artifacts so we never read "asterisk asterisk".
    let cleaned = clean_ai_text(text);
    let text = cleaned.trim();
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

    // Piper — natural-sounding local neural TTS (offline, no key). This is the
    // default "normal AI voice" when the user has downloaded the Piper voice.
    if piper_available() {
        match try_piper_tts(text) {
            Ok(audio_bytes) => { play_audio(audio_bytes); return Ok(()); }
            Err(e) => eprintln!("Piper TTS error, falling back to SAPI: {:?}", e),
        }
    }

    // Windows SAPI (offline, no key, no window flash) — robotic last resort.
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

/// Tauri command — verify an ElevenLabs API key works before saving it.
#[tauri::command]
pub async fn test_elevenlabs_key(api_key: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build().map_err(|e| e.to_string())?;
    let resp = client.get("https://api.elevenlabs.io/v1/user")
        .header("xi-api-key", api_key)
        .send().await.map_err(|e| e.to_string())?;
    Ok(resp.status().is_success())
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

// ── Piper — natural-sounding local neural TTS (offline) ───────────────────────

/// Directory where the Piper engine + voice model live: %APPDATA%\Omni\piper\
pub fn piper_dir() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("Omni");
    p.push("piper");
    p
}

/// Locate the piper.exe binary if installed.
fn find_piper_binary() -> Option<PathBuf> {
    let p = piper_dir().join("piper.exe");
    if p.exists() { Some(p) } else { None }
}

/// Locate a Piper voice model (any *.onnx) in the piper dir.
fn find_piper_model() -> Option<PathBuf> {
    let dir = piper_dir();
    // Prefer a known natural English voice if present.
    for preferred in ["en_US-amy-medium.onnx", "en_US-lessac-medium.onnx", "en_US-ryan-medium.onnx"] {
        let p = dir.join(preferred);
        if p.exists() { return Some(p); }
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().map_or(false, |x| x == "onnx") {
                return Some(path);
            }
        }
    }
    None
}

/// True if a usable Piper engine (binary + model + its .onnx.json config) is installed.
pub fn piper_available() -> bool {
    if find_piper_binary().is_none() { return false; }
    match find_piper_model() {
        Some(m) => {
            // Piper requires the matching <model>.onnx.json config alongside it.
            let cfg = PathBuf::from(format!("{}.json", m.to_string_lossy()));
            cfg.exists()
        }
        None => false,
    }
}

/// Synthesize `text` to WAV bytes using the local Piper engine.
/// Pipes text to piper.exe stdin; piper writes a WAV we read back and return.
fn try_piper_tts(text: &str) -> anyhow::Result<Vec<u8>> {
    use std::os::windows::process::CommandExt;
    use std::io::Write;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let bin = find_piper_binary().ok_or_else(|| anyhow::anyhow!("piper.exe not found"))?;
    let model = find_piper_model().ok_or_else(|| anyhow::anyhow!("no piper voice model"))?;

    // Cap very long text so playback isn't a monologue (results are short).
    let capped: String = text.chars().take(800).collect();

    let out_wav = std::env::temp_dir().join("omni_tts_piper.wav");
    let _ = std::fs::remove_file(&out_wav);

    let mut child = Command::new(&bin)
        .args([
            "--model", &model.to_string_lossy(),
            "--output_file", &out_wav.to_string_lossy(),
        ])
        // Run inside the piper dir so its DLLs + espeak-ng-data resolve.
        .current_dir(piper_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(capped.as_bytes())?;
        // Drop stdin to signal EOF so piper starts synthesizing.
    }

    let output = child.wait_with_output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("piper exited with error: {}", stderr));
    }

    let bytes = std::fs::read(&out_wav)
        .map_err(|e| anyhow::anyhow!("piper produced no WAV: {}", e))?;
    let _ = std::fs::remove_file(&out_wav);
    if bytes.is_empty() {
        return Err(anyhow::anyhow!("piper produced an empty WAV"));
    }
    Ok(bytes)
}

/// Stream-download a URL to a file, emitting progress as `piper:download`.
async fn piper_download_file(url: &str, dest: &PathBuf, app: &tauri::AppHandle, stage: &str) -> anyhow::Result<()> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()?;
    let resp = client.get(url)
        .header("User-Agent", "Omni-Agent")
        .send().await?;
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
                let _ = app.emit("piper:download", serde_json::json!({"stage": stage, "pct": pct}));
            }
        }
    }
    file.flush().await?;
    Ok(())
}

/// Extract the Piper Windows zip into `dir`, stripping the leading `piper/`
/// folder so files land directly in `dir` (preserves the espeak-ng-data tree).
fn extract_piper_zip(zip_path: &PathBuf, dir: &PathBuf) -> anyhow::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(enclosed) = entry.enclosed_name() else { continue };
        // Strip the leading top-level component (the "piper/" wrapper folder).
        let mut comps = enclosed.components();
        comps.next(); // drop first component
        let rel: PathBuf = comps.as_path().to_path_buf();
        if rel.as_os_str().is_empty() { continue; }
        let out_path = dir.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

/// Tauri command — download the Piper engine + a natural English voice into
/// %APPDATA%\Omni\piper\ for offline, natural-sounding speech. Emits
/// `piper:download` progress. Safe to call repeatedly (skips existing files).
#[tauri::command]
pub async fn download_piper(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let dir = piper_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 1) Engine (piper.exe + DLLs + espeak-ng-data) — stable pinned release.
    if find_piper_binary().is_none() {
        let _ = app.emit("piper:download", serde_json::json!({"stage":"engine","pct":0}));
        let zip_path = dir.join("piper_windows.zip");
        piper_download_file(
            "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
            &zip_path, &app, "engine",
        ).await.map_err(|e| format!("Engine download failed: {}", e))?;
        extract_piper_zip(&zip_path, &dir).map_err(|e| format!("Engine extract failed: {}", e))?;
        let _ = std::fs::remove_file(&zip_path);
    }

    // 2) Natural English voice model (~63 MB) + its config from HuggingFace.
    let model_path = dir.join("en_US-amy-medium.onnx");
    if !model_path.exists() {
        let _ = app.emit("piper:download", serde_json::json!({"stage":"voice","pct":0}));
        piper_download_file(
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
            &model_path, &app, "voice",
        ).await.map_err(|e| format!("Voice download failed: {}", e))?;
    }
    let cfg_path = dir.join("en_US-amy-medium.onnx.json");
    if !cfg_path.exists() {
        piper_download_file(
            "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json",
            &cfg_path, &app, "voice",
        ).await.map_err(|e| format!("Voice config download failed: {}", e))?;
    }

    let ok = piper_available();
    let _ = app.emit("piper:download", serde_json::json!({
        "stage": if ok { "done" } else { "error" }, "pct": 100
    }));
    if ok {
        Ok("Natural voice (Piper) is ready.".to_string())
    } else {
        Err("Piper files missing after download. Check your connection and try again.".to_string())
    }
}

/// Tauri command — is the natural Piper voice installed?
#[tauri::command]
pub fn piper_installed() -> bool {
    piper_available()
}
