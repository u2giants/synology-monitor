-- ============================================
-- Fix missing indexes and metadata defaults
-- ============================================

-- Add missing indexes for copilot tables (user_id filtering)
create index if not exists smon_copilot_messages_user_session
  on smon_copilot_messages (user_id, session_id, message_order asc);

create index if not exists smon_copilot_actions_user_session
  on smon_copilot_actions (user_id, session_id, created_at asc);

-- Add default values for nullable metadata columns to prevent String(null) issues
alter table smon_logs alter column metadata set default '{}'::jsonb;
alter table smon_metrics alter column metadata set default '{}'::jsonb;
alter table smon_alerts alter column details set default '{}'::jsonb;
