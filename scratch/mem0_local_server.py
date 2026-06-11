import os
import sys
import zipfile
import shutil
import uuid
import secrets
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

# Point Python to use the cloned mem0 repo instead of standard package
current_dir = os.path.dirname(os.path.abspath(__file__))
git_mem0_path = os.path.join(current_dir, "mem0_git")
if os.path.exists(git_mem0_path):
    sys.path.insert(0, git_mem0_path)

# Try to import required dependencies
try:
    from fastapi import FastAPI, HTTPException, Request
    import uvicorn
except ImportError:
    print("Error: fastapi and uvicorn are required.")
    sys.exit(1)

try:
    from mem0 import Memory
except ImportError as e:
    import traceback
    print(f"Error: mem0ai is required. Details: {e}")
    traceback.print_exc()
    sys.exit(1)

import requests

# Initialize FastAPI app
app = FastAPI(
    title="Omni Local Mem0 REST Server",
    description="A lightweight, local memory layer for low-RAM PCs using Mem0 and Chroma DB with Supabase cloud backup.",
    version="1.0.0"
)

# ── Security: Generate a one-time auth token for this session ──
# The Rust core must pass this token in X-Sidecar-Token header.
# Token is printed to stdout so the parent process can capture it.
SIDECAR_TOKEN = os.getenv("SIDECAR_TOKEN", secrets.token_urlsafe(32))
print(f"SIDECAR_TOKEN={SIDECAR_TOKEN}", flush=True)

# ── Configuration for Supabase ──
# SECURITY: Keys MUST come from environment variables — never hardcoded.
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("WARNING: SUPABASE_URL and/or SUPABASE_KEY not set. Cloud sync disabled.")

BUCKET_NAME = "omni-memories"
CHROMA_PATH = os.getenv("MEM0_CHROMA_PATH", "./chroma_db")
ZIP_FILE = "chroma_db.zip"

# Configuration for Memory
llm_provider = os.getenv("MEM0_LLM_PROVIDER", "openai")
llm_model = os.getenv("MEM0_LLM_MODEL", "gpt-4o-mini")
llm_base_url = os.getenv("MEM0_LLM_BASE_URL", None)

embedder_provider = os.getenv("MEM0_EMBEDDER_PROVIDER", "openai")
embedder_model = os.getenv("MEM0_EMBEDDER_MODEL", "text-embedding-3-small")
embedder_base_url = os.getenv("MEM0_EMBEDDER_BASE_URL", None)

# Print current startup configuration details
print("-" * 50)
print("Omni Local Mem0 Server starting up...")
print(f"LLM Provider:      {llm_provider}")
print(f"LLM Model:         {llm_model}")
print(f"Embedder Provider: {embedder_provider}")
print(f"Embedder Model:    {embedder_model}")
print(f"Supabase Project:  {SUPABASE_URL}")
print("-" * 50)

# Memory engines cache
memory_engines = {}

def get_memory_engine(api_key: Optional[str]) -> Memory:
    """Lazy initialize and cache the Mem0 engine using the key from request headers."""
    cache_key = api_key or "default"
    if cache_key not in memory_engines:
        print(f"Initializing Memory engine for key: {cache_key[:8]}...")
        mem_config = {
            "vector_store": {
                "provider": "chroma",
                "config": {
                    "collection_name": "omni_memories",
                    "path": CHROMA_PATH
                }
            },
            "llm": {
                "provider": llm_provider,
                "config": {
                    "model": llm_model
                }
            },
            "embedder": {
                "provider": embedder_provider,
                "config": {
                    "model": embedder_model
                }
            }
        }

        if llm_base_url:
            mem_config["llm"]["config"]["openai_base_url"] = llm_base_url
        if embedder_base_url:
            mem_config["embedder"]["config"]["openai_base_url"] = embedder_base_url

        # Apply authorization token if present
        if api_key:
            mem_config["llm"]["config"]["api_key"] = api_key
            mem_config["embedder"]["config"]["api_key"] = api_key

        memory_engines[cache_key] = Memory.from_config(mem_config)
    return memory_engines[cache_key]

def get_api_key_from_header(request: Request) -> Optional[str]:
    """Extract token from Authorization: Token <key> or Bearer <key> headers."""
    auth = request.headers.get("Authorization")
    if auth:
        parts = auth.split(" ")
        if len(parts) == 2 and parts[0] in ["Token", "Bearer"]:
            return parts[1]
    return None

def verify_sidecar_token(request: Request):
    """Verify the X-Sidecar-Token header matches the session token."""
    token = request.headers.get("X-Sidecar-Token", "")
    if not token or token != SIDECAR_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid or missing sidecar token")

# Helper functions for Zip
def zip_directory(folder_path: str, zip_path: str):
    if not os.path.exists(folder_path):
        return
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(folder_path):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, folder_path)
                zipf.write(file_path, arcname)

def unzip_file(zip_path: str, extract_to: str):
    if os.path.exists(extract_to):
        shutil.rmtree(extract_to)
    os.makedirs(extract_to, exist_ok=True)
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(extract_to)

# Helper functions for Supabase Storage
def is_supabase_configured() -> bool:
    """Check if Supabase credentials are available."""
    return bool(SUPABASE_URL) and bool(SUPABASE_KEY)

def init_supabase_bucket():
    """Create bucket if not exists."""
    if not is_supabase_configured():
        print("Supabase not configured — skipping bucket init.")
        return
    url = f"{SUPABASE_URL}/storage/v1/bucket"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "id": BUCKET_NAME,
        "name": BUCKET_NAME,
        "public": False
    }
    try:
        res = requests.post(url, headers=headers, json=payload)
        if res.status_code in [200, 201]:
            print(f"Supabase storage bucket '{BUCKET_NAME}' initialized.")
        elif res.status_code == 409:
            pass
        else:
            print(f"Bucket init warning: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"Failed to connect to Supabase Storage: {e}")

def restore_chroma_db(user_id: str):
    """Download chroma zip from Supabase storage and extract it locally."""
    if not is_supabase_configured():
        print("Supabase not configured — skipping restore.")
        return False
    print(f"Attempting to restore database from Supabase Storage for user {user_id}...")
    url = f"{SUPABASE_URL}/storage/v1/object/authenticated/{BUCKET_NAME}/{user_id}/{ZIP_FILE}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}"
    }
    try:
        res = requests.get(url, headers=headers)
        if res.status_code == 200:
            with open(ZIP_FILE, "wb") as f:
                f.write(res.content)
            unzip_file(ZIP_FILE, CHROMA_PATH)
            print(f"Database successfully restored from cloud storage.")
            # Clear engine cache to force re-instantiation
            memory_engines.clear()
            return True
        else:
            print(f"No cloud backup found or restore failed (status: {res.status_code}). Running with clean local DB.")
    except Exception as e:
        print(f"Error restoring database: {e}")
    return False

def backup_chroma_db(user_id: str):
    """Zip chroma_db folder and upload it to Supabase storage."""
    if not is_supabase_configured():
        return
    print(f"Backing up database to Supabase Storage for user {user_id}...")
    if not os.path.exists(CHROMA_PATH):
        print("No local database folder to backup.")
        return
    
    try:
        zip_directory(CHROMA_PATH, ZIP_FILE)
        url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{user_id}/{ZIP_FILE}"
        headers = {
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/octet-stream",
            "x-upsert": "true"
        }
        with open(ZIP_FILE, "rb") as f:
            res = requests.post(url, headers=headers, data=f)
        if res.status_code in [200, 201]:
            print("Database successfully backed up to cloud storage.")
        else:
            print(f"Cloud backup failed: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"Error backing up database: {e}")

# Helper functions for Supabase Database
def save_fact_to_supabase_db(user_id: str, fact: str, memory_id: str):
    """Insert the extracted fact into the Supabase database memories table."""
    if not is_supabase_configured():
        return
    print(f"Saving important fact to database: {fact}")
    url = f"{SUPABASE_URL}/rest/v1/memories"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }
    payload = {
        "id": memory_id,
        "user_id": user_id,
        "memory_type": "semantic",
        "content": fact,
        "metadata": {"source": "local_mem0_server"}
    }
    try:
        res = requests.post(url, headers=headers, json=payload)
        if res.status_code not in [200, 201, 409]:
            print(f"Database save warning: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"Failed to save fact to database: {e}")

def delete_fact_from_supabase_db(memory_id: str):
    """Delete the fact from the Supabase database memories table."""
    if not is_supabase_configured():
        return
    print(f"Deleting fact from database with ID: {memory_id}")
    url = f"{SUPABASE_URL}/rest/v1/memories?id=eq.{memory_id}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY
    }
    try:
        res = requests.delete(url, headers=headers)
        if res.status_code not in [200, 204]:
            print(f"Database delete warning: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"Failed to delete fact from database: {e}")

# Request Models
class MessageItem(BaseModel):
    role: str
    content: str

class AddMemoryRequest(BaseModel):
    user_id: str
    messages: List[MessageItem]

class SearchMemoryRequest(BaseModel):
    query: str
    user_id: str
    limit: Optional[int] = 5

# Initialize bucket on startup
init_supabase_bucket()

# Lazy DB Restore tracker
restored_users = set()

def ensure_user_restored(user_id: str):
    if user_id not in restored_users:
        restore_chroma_db(user_id)
        restored_users.add(user_id)

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "mem0-local-server"}

@app.post("/memories")
async def add_memory(req: AddMemoryRequest, request: Request):
    verify_sidecar_token(request)
    """
    Store new memories for a user based on user/assistant dialog messages.
    """
    try:
        ensure_user_restored(req.user_id)
        api_key = get_api_key_from_header(request)
        engine = get_memory_engine(api_key)
        
        messages_payload = [{"role": msg.role, "content": msg.content} for msg in req.messages]
        result = engine.add(messages=messages_payload, user_id=req.user_id)
        
        # Save extracted facts to the Supabase database
        if isinstance(result, list):
            for item in result:
                if isinstance(item, dict):
                    m_id = item.get("id") or str(uuid.uuid4())
                    memory_text = item.get("memory", "")
                    if memory_text:
                        save_fact_to_supabase_db(req.user_id, memory_text, m_id)
        
        # Backup the updated Chroma DB to cloud storage
        backup_chroma_db(req.user_id)
        
        return {"status": "success", "results": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/search")
async def search_memories(req: SearchMemoryRequest, request: Request):
    verify_sidecar_token(request)
    """
    Search semantic memories for a user matching a textual query.
    """
    try:
        ensure_user_restored(req.user_id)
        api_key = get_api_key_from_header(request)
        engine = get_memory_engine(api_key)
        
        results = engine.search(query=req.query, user_id=req.user_id, limit=req.limit)
        
        formatted_results = []
        for res in results:
            if isinstance(res, dict):
                formatted_results.append({
                    "id": res.get("id", ""),
                    "memory": res.get("memory", res.get("payload", {}).get("memory", "")),
                    "user_id": res.get("user_id", req.user_id)
                })
            else:
                formatted_results.append({
                    "id": getattr(res, "id", ""),
                    "memory": getattr(res, "memory", getattr(res, "payload", {}).get("memory", "")),
                    "user_id": getattr(res, "user_id", req.user_id)
                })
        return formatted_results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/memories")
async def get_all_memories(user_id: str, request: Request):
    verify_sidecar_token(request)
    """
    Retrieve all cognitive memories currently registered for a specific user.
    """
    try:
        ensure_user_restored(user_id)
        api_key = get_api_key_from_header(request)
        engine = get_memory_engine(api_key)
        
        results = engine.get_all(user_id=user_id)
        
        formatted_results = []
        for res in results:
            if isinstance(res, dict):
                formatted_results.append({
                    "id": res.get("id", ""),
                    "memory": res.get("memory", res.get("payload", {}).get("memory", "")),
                    "user_id": res.get("user_id", user_id)
                })
            else:
                formatted_results.append({
                    "id": getattr(res, "id", ""),
                    "memory": getattr(res, "memory", getattr(res, "payload", {}).get("memory", "")),
                    "user_id": getattr(res, "user_id", user_id)
                })
        return formatted_results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str, request: Request):
    verify_sidecar_token(request)
    """
    Purge a specific memory record by its unique ID.
    """
    try:
        api_key = get_api_key_from_header(request)
        engine = get_memory_engine(api_key)
        
        # Delete from local Chroma engine
        engine.delete(memory_id=memory_id)
        
        # Delete from Supabase Database
        delete_fact_from_supabase_db(memory_id)
        
        # Backup the updated Chroma DB to cloud storage for all loaded users
        for u_id in list(restored_users):
            backup_chroma_db(u_id)
            
        return {"status": "success", "message": f"Memory {memory_id} deleted."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Wake Word Detection (/wake SSE endpoint) ──────────────────────────────────
# Uses openWakeWord (hey_jarvis model) to detect "Hey Omni" via microphone.
# Streams Server-Sent Events: "data: detected\n\n" when wake word fires.
# The Rust layer polls this endpoint and emits a Tauri event to the overlay.

WAKE_ENABLED = os.getenv("OMNI_WAKE_ENABLED", "1") == "1"
WAKE_THRESHOLD = float(os.getenv("OMNI_WAKE_THRESHOLD", "0.7"))

def _wake_word_generator():
    """
    Continuously listens on the microphone for the wake word using openWakeWord.
    Yields SSE lines when the wake word is detected.
    Runs in a separate thread (FastAPI uses asyncio, but audio capture is sync).
    """
    try:
        import pyaudio
        import numpy as np
        from openwakeword.model import Model as WakeModel

        # Load the hey_jarvis model as phonetic proxy for "Hey Omni"
        oww = WakeModel(wakeword_models=["hey_jarvis"], inference_framework="onnx")

        FORMAT     = pyaudio.paInt16
        CHANNELS   = 1
        RATE       = 16000
        CHUNK      = 1280  # 80ms at 16kHz — recommended by openWakeWord

        pa  = pyaudio.PyAudio()
        mic = pa.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)
        print("[wake] Wake word listener started (hey_jarvis model, threshold=%.2f)" % WAKE_THRESHOLD, flush=True)

        cooldown_frames = 0   # prevent repeated triggers
        COOLDOWN = int(4 * RATE / CHUNK)   # 4-second cooldown after each detection

        while True:
            try:
                data = mic.read(CHUNK, exception_on_overflow=False)
            except Exception:
                continue

            if cooldown_frames > 0:
                cooldown_frames -= 1
                continue

            audio = np.frombuffer(data, dtype=np.int16)
            oww.predict(audio)

            # Check scores for all loaded models
            for mdl_name, score in oww.prediction_buffer.items():
                if score and score[-1] >= WAKE_THRESHOLD:
                    print(f"[wake] '{mdl_name}' detected (score={score[-1]:.3f})", flush=True)
                    cooldown_frames = COOLDOWN
                    yield "data: detected\n\n"
                    break

    except ImportError as e:
        print(f"[wake] openWakeWord/pyaudio not available: {e}", flush=True)
        yield "data: unavailable\n\n"
    except Exception as e:
        print(f"[wake] Error in wake word loop: {e}", flush=True)
        yield "data: error\n\n"

from fastapi.responses import StreamingResponse
import asyncio
import threading
import queue as _queue

@app.get("/wake")
async def wake_stream(request: Request):
    """
    SSE endpoint that streams wake-word detection events.
    Client keeps this connection open; server sends 'detected' when triggered.
    Protected by sidecar token.
    """
    verify_sidecar_token(request)

    if not WAKE_ENABLED:
        async def _disabled():
            yield "data: disabled\n\n"
        return StreamingResponse(_disabled(), media_type="text/event-stream")

    # Run the blocking audio loop in a thread, bridge to async via queue
    q: _queue.Queue = _queue.Queue()

    def _run():
        for event in _wake_word_generator():
            q.put(event)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    async def _stream():
        loop = asyncio.get_event_loop()
        while True:
            if await request.is_disconnected():
                break
            try:
                item = await loop.run_in_executor(None, lambda: q.get(timeout=1.0))
                yield item
            except _queue.Empty:
                # Send keepalive comment every second
                yield ": keepalive\n\n"
            except Exception:
                break

    return StreamingResponse(_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    # SECURITY: Bind to localhost only — never expose to network
    uvicorn.run(app, host="127.0.0.1", port=port)
