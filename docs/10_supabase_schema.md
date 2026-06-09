# Omni — Supabase Schema & Backend

Supabase handles: **Authentication**, **Task Sync**, **Memory (pgvector)**, and **Payment-readiness (V2)**.

---

## Authentication

| Method | Detail |
|--------|--------|
| Magic Link | `supabase.auth.signInWithOtp({ email })` |
| Google OAuth | `supabase.auth.signInWithOAuth({ provider: 'google' })` |
| Token storage | Windows Credential Manager (key: `supabase_user_token`) |

---

## Database Schema

### `users` Table

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    plan TEXT DEFAULT 'free',        -- free | pro | pro_plus
    tasks_this_month INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `tasks` Table

```sql
CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status TEXT NOT NULL,             -- running | completed | failed | cancelled
    steps_json JSONB,                -- array of step objects
    outcome TEXT,
    duration_ms INTEGER,
    ai_model TEXT,                   -- which model was used
    ai_tokens_used INTEGER,
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
```

### `memories` Table (pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    memory_type TEXT NOT NULL,       -- episodic | semantic
    content TEXT NOT NULL,
    embedding vector(1536),          -- OpenAI embedding dimension
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_embedding ON memories
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### `audit_log` Table

```sql
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    tool_name TEXT,
    app_name TEXT,
    outcome TEXT NOT NULL,           -- success | failed | denied | cancelled
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_user_id ON audit_log(user_id);
```

### `subscriptions` Table (Razorpay-ready, NULL in V1)

```sql
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    razorpay_subscription_id TEXT,
    razorpay_customer_id TEXT,
    plan TEXT,                       -- pro | pro_plus
    status TEXT,                     -- active | cancelled | past_due
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
```

---

## Row Level Security (RLS)

All tables have RLS enabled. Users can only read/write their own data.

```sql
-- Example for tasks table
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tasks"
    ON tasks FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks"
    ON tasks FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
    ON tasks FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
    ON tasks FOR DELETE
    USING (auth.uid() = user_id);
```

Apply identical policies to: `memories`, `audit_log`, `subscriptions`.

---

## Sync Strategy

| Direction | Frequency | What |
|-----------|-----------|------|
| **Push** (local → Supabase) | Every 5 minutes | Unsynced tasks from SQLite → `tasks` table |
| **Pull** (Supabase → local) | On app start | User profile, subscription status → Zustand store |

### Sync Flow
1. App starts → fetch user profile + subscription from Supabase
2. Background timer (5 min) → query SQLite for `synced_at IS NULL` → upsert to Supabase → mark synced locally
3. On task complete → save locally first (instant), sync in background

---

## Edge Functions (V2)

| Function | Purpose |
|----------|---------|
| `razorpay-webhook` | Receives Razorpay subscription events, updates `subscriptions` table |
| `check-task-limit` | Called before task runs, enforces free tier 50/month limit |