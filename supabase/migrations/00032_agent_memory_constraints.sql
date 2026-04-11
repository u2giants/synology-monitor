-- Add unique constraint on agent_memory to enable upsert (ON CONFLICT).
-- The composite key (user_id, subject, memory_type, title) identifies a
-- logically distinct memory — same lesson learned about the same topic.
ALTER TABLE IF EXISTS agent_memory
  ADD CONSTRAINT uq_agent_memory_key
  UNIQUE (user_id, subject, memory_type, title);

-- Add trigger to keep updated_at current on every row update.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_memory_updated_at ON agent_memory;
CREATE TRIGGER trg_agent_memory_updated_at
  BEFORE UPDATE ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
