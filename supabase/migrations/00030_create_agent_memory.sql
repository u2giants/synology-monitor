-- Agent memory: persistent knowledge extracted from resolved issues.
-- Loaded at the start of each new issue agent run so future agents
-- benefit from patterns and calibration data discovered in past investigations.
-- Subject-indexed so only the relevant topics load per issue (not a full dump).
CREATE TABLE IF NOT EXISTS agent_memory (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nas_id          TEXT,                  -- null = global (applies to all NAS units)
  subject         TEXT        NOT NULL,  -- topic tag: 'HyperBackup', 'RAID', 'SSL', etc.
  memory_type     TEXT        NOT NULL
    CHECK (memory_type IN ('nas_profile', 'issue_pattern', 'calibration', 'institutional')),
  title           TEXT        NOT NULL,  -- short one-line label
  content         TEXT        NOT NULL,  -- 2-4 sentences of durable knowledge
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  source_issue_id UUID,                  -- FK added in migration 00031 after issues rename
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary: load memories by user + subject (the hot path per issue)
CREATE INDEX IF NOT EXISTS idx_agent_memory_user_subject
  ON agent_memory (user_id, subject, created_at DESC);

-- Secondary: all memories for a user filtered to a NAS + global
CREATE INDEX IF NOT EXISTS idx_agent_memory_user_nas
  ON agent_memory (user_id, nas_id, created_at DESC);

ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own memories"
  ON agent_memory FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service role manages agent memory"
  ON agent_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
