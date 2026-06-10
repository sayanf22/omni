# Omni — Voice / Speech-to-Text (STT)

## How speech processing works

When you press the mic hotkey (**Ctrl+Shift+A**), Omni:

1. **Starts recording** immediately (the overlay shows a live waveform that reacts to your voice).
2. **Auto-stops** when you stop talking (~1.2 s of silence) — no need to hold the key.
   *(Press Ctrl+Shift+A again to stop early; it also stops after 30 s max.)*
3. **Converts** the audio to **16 kHz mono** and **transcribes** it with the first available engine:
   1. **Local Whisper** (whisper.cpp) — fully offline, fast, private, accurate. *(if installed)*
   2. **ElevenLabs Scribe** — cloud, most accurate, needs an API key + internet.
   3. **Windows SAPI** — built-in offline fallback, zero setup, lower accuracy.
4. Shows you exactly **what it heard** ("You said …") and runs it as a task.

> Press-to-start + auto-stop-on-silence is far more reliable than hold-to-talk.
> You can always type instead with **Ctrl+Shift+T**.

---

## Option A — ElevenLabs (cloud, easiest, very accurate)

1. Get an API key from https://elevenlabs.io
2. In Omni → **Settings → System Integrations**, paste your ElevenLabs key and save.
3. Done. Omni uses the `scribe_v1` model automatically.

Pros: best accuracy, nothing to install. Cons: needs internet, sends audio to ElevenLabs.

---

## Option B — Local Whisper (offline, fast, private) ✅ recommended for privacy

Runs entirely on your PC. No internet, no audio leaves your machine. After a one-time
setup it's fast (a short command transcribes in ~1–2 s with the `base.en` model on CPU).

### Setup (one time)

1. Create the folder:
   ```
   %APPDATA%\Omni\whisper\
   ```
   (paste that into File Explorer's address bar — `%APPDATA%` expands automatically.)

2. **Download the whisper.cpp Windows binary** from the official releases:
   https://github.com/ggml-org/whisper.cpp/releases
   - Grab the latest `whisper-bin-x64.zip`, unzip it, and copy **`whisper-cli.exe`**
     (older builds call it `main.exe`) into `%APPDATA%\Omni\whisper\`.

3. **Download a model** (GGML format) from:
   https://huggingface.co/ggerganov/whisper.cpp/tree/main
   - Recommended: **`ggml-base.en.bin`** (~142 MB) — best speed/accuracy balance for English commands.
   - Faster/smaller: `ggml-tiny.en.bin` (~75 MB). More accurate: `ggml-small.en.bin` (~466 MB).
   - Place the `.bin` file into `%APPDATA%\Omni\whisper\`.

Your folder should look like:
```
%APPDATA%\Omni\whisper\
├── whisper-cli.exe
└── ggml-base.en.bin
```

4. Restart Omni. Local Whisper is now detected and used automatically (highest priority).

Pros: offline, private, fast, accurate, free. Cons: one-time ~150 MB download.

---

## Option C — Windows SAPI (no setup)

If neither of the above is configured, Omni uses the built-in Windows Speech API.
It works with zero setup but is the least accurate — fine for simple commands.

---

## Recommendation

- **Privacy / offline / no recurring cost** → **Local Whisper (`ggml-base.en.bin`)**.
- **Maximum accuracy, don't mind cloud** → **ElevenLabs Scribe**.
- **Just want it to work right now** → SAPI (automatic, nothing to do).

> Tip: You can also always type commands instead of speaking — press **Ctrl+Shift+T**.
