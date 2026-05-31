-- PLACEHOLDER — no drops applied until owner confirms intent.
--
-- Tables audited 2026-05-31. Findings:
--
-- drive_team_folders_partitioned (DO NOT DROP):
--   Created in 00008 as a partition parent for future scale. No child partitions
--   exist yet and the agent writes to drive_team_folders instead. This is
--   forward infrastructure — keep until a decision is made to either activate
--   partitioned storage or formally retire the plan.
--
-- issue_resolutions, resolution_steps, resolution_log, resolution_messages (CANDIDATE):
--   The /api/resolution/* routes were rewritten to use the issues/issue_messages/
--   issue_actions tables. Zero TypeScript code reads or writes these four tables.
--   They appear to be superseded by the issue-agent pipeline.
--   Confirm with owner before dropping — add the DROP statements here once confirmed.
--
-- smon_run_sync_remediation pg_cron job + sync_remediations: ACTIVE, do not touch.
-- All other tables: active or reserved — see memory/db-schema-reference.md.

SELECT 1; -- no-op so Supabase migration runner accepts this file
