-- Add cross-issue dependency tracking.
-- When agent A determines its root cause is another open issue B,
-- it stores B's ID here and enters waiting_on_issue status.
-- When B resolves, the workflow re-queues A automatically.

alter table issues
  add column if not exists depends_on_issue_id uuid references issues(id) on delete set null;

create index if not exists idx_issues_depends_on
  on issues(depends_on_issue_id)
  where depends_on_issue_id is not null;
