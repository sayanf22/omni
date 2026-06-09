# Omni — Memory System (Complete Specification)

Three tiers working together to make the agent feel like it knows you.
Powered by **Mem0** (open source) on top of **Supabase pgvector**.

> 90% cheaper than sending full history every time. 26% better responses.

---

## Tier 1 — Working Memory (Session RAM)

- Lives **only** while a task is running
- Holds:
  - Current instruction
  - Steps taken so far
  - Active window info
  - Current screen content (screenshot + OCR)
  - Retrieved memories from Tier 2 & 3
- **Clears when task completes**

---

## Tier 2 — Episodic Memory (What Happened)

- Every completed task is **summarized** and stored in Supabase
- Searchable by meaning via **vector search** (pgvector)
- When a new task comes in, the **top 5 most relevant past tasks** are retrieved and added to the AI context

**Example:**
User asks for LinkedIn post → system finds:
*"On June 1 user asked for LinkedIn post. Liked 130 words, professional tone, no hashtags."*
→ AI already knows the style before writing a single word.

---

## Tier 3 — Semantic Memory (Who You Are)

- **Permanent facts** extracted after every task
- Examples:
  - "User prefers Chrome."
  - "User's name is Sayan."
  - "Saves to D:/Work."
  - "LinkedIn posts are professional, ~130 words, no hashtags"
- Shown and **editable** in Memory tab (V2; read-only in V1)
- **Injected into every AI call** as part of the system prompt

---

## V1 vs V2 Memory

| Feature | V1 | V2 |
|---------|----|----|
| API key storage | ✅ Windows Credential Manager | ✅ |
| Last 50 task summaries | ✅ SQLite | ✅ Supabase |
| Basic user preferences | ✅ learned over time | ✅ |
| Memory tab display | ✅ read-only | ✅ interactive (edit/delete) |
| Full Mem0 integration | ❌ | ✅ |
| Vector search retrieval | ❌ basic SQLite | ✅ pgvector top-5 |
| Cross-device sync | ❌ | ✅ |
| Semantic search | ❌ | ✅ "Show me memories about LinkedIn" |

---

## Mem0 Integration (V2 — Actual Implementation)

Omni supports two cognitive memory strategies configurable directly inside Settings:

### Option A: Mem0 Cloud API
- **Endpoint Path:** Wires direct requests to the managed Platform API (`https://api.mem0.ai/v3/memories/search/` and `/v3/memories/add/`).
- **Authorization:** Calls are protected using standard `Authorization: Token <api_key>` headers.
- **Key Store:** The API key is securely encrypted using the Windows DPAPI keychain namespace `Omni/mem0`.

### Option B: Self-Hosted OSS / Local REST Server (Supabase Storage + Database Sync)
- **Local Server (`scratch/mem0_local_server.py`):** Starts a lightweight local FastAPI wrapper utilizing the locally-cloned open-source `mem0` Python repository with a Chroma DB vector store file layer.
- **Lazy Auth Delegation:** To avoid plain-text startup secrets, the local Python server dynamically extracts the user's API keys (OpenAI / DeepSeek) from the standard `Authorization` headers sent securely over localhost by the Rust backend.
- **Structured Database Sync:** Whenever the memory engine extracts new user facts, the local server pushes the structured semantic records directly to the Supabase `memories` table via PostgREST, ensuring important user facts live in the secure cloud database itself.
- **Supabase Storage Backups (5GB Free Tier):** On any memory insertion or deletion, the local server zips the local `./chroma_db` folder and uploads it to the `omni-memories` Supabase Storage bucket under the folder `{user_id}/chroma_db.zip`. On startup or first request, it automatically pulls and unzips this backup to enable instant cross-device memory restore.