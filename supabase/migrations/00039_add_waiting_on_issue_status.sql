-- ============================================================
-- Migration 00039: allow the waiting_on_issue issue status
-- ============================================================
-- Build step 4 of the issue-agent rebuild (PLAN.md §7). The rebuild's turn state
-- machine ends a turn that is blocked on another issue in `waiting_on_issue`.
--
-- This is also a latent-bug fix: the existing code ALREADY sets this status
-- (issue-agent.ts cross-issue-dependency branch, releaseDependentIssues, and the
-- IssueStatus union), but the CHECK constraint only allowed the original seven
-- values — so any issue that hit the dependency branch failed its UPDATE with a
-- CHECK violation in production. Widening the constraint is additive (it only
-- permits one more value) and unbreaks that path.
--
-- Constraint name is the historical `smon_issues_status_check` (kept; renaming it
-- would be churn — see AGENTS.md on the smon_ legacy).
-- ============================================================

ALTER TABLE public.issues DROP CONSTRAINT IF EXISTS smon_issues_status_check;

ALTER TABLE public.issues
  ADD CONSTRAINT smon_issues_status_check
  CHECK (status = ANY (ARRAY[
    'open'::text,
    'running'::text,
    'waiting_on_user'::text,
    'waiting_for_approval'::text,
    'waiting_on_issue'::text,
    'resolved'::text,
    'stuck'::text,
    'cancelled'::text
  ]));
