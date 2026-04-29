# AI Context Queries

Last verified: 2026-04-18 UTC

Purpose:
- This file gives future coding agents copy-paste query patterns for loading Synology Monitor state from Supabase.
- Use this together with [AI_CONTEXT.md](/worksp/monitor/app/AI_CONTEXT.md).

## Read first

This app's live state is in Supabase, not in the repo.

If you are Claude Code or another coding agent with Supabase MCP access, load context from Supabase before answering questions about:
- what the monitor found
- what the AI recommended
- what the operator and AI said to each other
- what remediation actions were proposed or executed

## Recommended retrieval order

Run these in order:

1. Latest monitor findings
2. Active alerts
3. Recent durable issue threads
4. Messages, evidence, and actions for the top issue IDs
5. Jobs, transitions, and stage runs for those same issue IDs

## SQL queries

Replace placeholders like `$ISSUE_ID` before running.

### 1. Latest analysis run

```sql
select id, created_at, summary, problem_count, model
from analysis_runs
order by created_at desc
limit 1;
```

### 2. Open analyzed problems from the latest run

```sql
select id,
       analysis_run_id,
       title,
       explanation,
       technical_diagnosis,
       severity,
       affected_nas,
       affected_shares,
       affected_users,
       affected_files,
       raw_event_count,
       status,
       first_seen,
       last_seen,
       created_at
from analyzed_problems
where analysis_run_id = $LATEST_RUN_ID
  and status <> 'resolved'
order by created_at asc;
```

### 3. Active alerts with NAS names

```sql
select a.id,
       a.severity,
       a.status,
       a.source,
       a.title,
       a.message,
       a.details,
       a.created_at,
       n.id as nas_id,
       n.name as nas_name,
       n.hostname
from alerts a
left join nas_units n on n.id = a.nas_id
where a.status = 'active'
order by a.created_at desc;
```

### 4. Recent issue threads

```sql
select id,
       origin_type,
       origin_id,
       title,
       summary,
       severity,
       status,
       affected_nas,
       current_hypothesis,
       hypothesis_confidence,
       next_step,
       conversation_summary,
       last_agent_message,
       last_user_message,
       created_at,
       updated_at,
       resolved_at
from issues
order by updated_at desc
limit 25;
```

### 5. Full conversation for one issue

```sql
select id, issue_id, role, content, metadata, created_at
from issue_messages
where issue_id = $ISSUE_ID
order by created_at asc;
```

### 6. Evidence for one issue

```sql
select id, issue_id, source_kind, title, detail, metadata, created_at
from issue_evidence
where issue_id = $ISSUE_ID
order by created_at asc;
```

### 7. Actions for one issue

```sql
select id,
       issue_id,
       kind,
       status,
       target,
       tool_name,
       command_preview,
       summary,
       reason,
       expected_outcome,
       rollback_plan,
       risk,
       requires_approval,
       result_text,
       approval_token,
       exit_code,
       created_at,
       completed_at
from issue_actions
where issue_id = $ISSUE_ID
order by created_at asc;
```

### 8. Workflow jobs for one issue

```sql
select id, issue_id, job_type, status, attempts, last_error, created_at, updated_at
from issue_jobs
where issue_id = $ISSUE_ID
order by created_at desc;
```

### 9. Status transitions for one issue

```sql
select id, issue_id, from_status, to_status, reason, metadata, created_at
from issue_state_transitions
where issue_id = $ISSUE_ID
order by created_at asc;
```

### 10. Stage runs for one issue

```sql
select id,
       issue_id,
       stage_key,
       status,
       model_name,
       model_tier,
       input_summary,
       output,
       error_text,
       created_at,
       completed_at
from issue_stage_runs
where issue_id = $ISSUE_ID
order by created_at asc;
```

### 11. Facts attached to one issue

```sql
select f.id,
       f.nas_id,
       f.fact_type,
       f.fact_key,
       f.severity,
       f.status,
       f.title,
       f.detail,
       f.value,
       f.observed_at,
       f.expires_at
from issue_facts ifx
join facts f on f.id = ifx.fact_id
where ifx.issue_id = $ISSUE_ID
order by f.observed_at desc;
```

## One-shot summary query pattern

If the user asks for a fast top-level summary, do this:

1. latest `analysis_runs`
2. matching open `analyzed_problems`
3. all active `alerts`
4. top 10 `issues` by `updated_at`

That is usually enough to answer:
- what problems exist now
- which NAS is affected
- whether the AI is already working an issue

## MCP prompt patterns

If your Supabase MCP supports natural-language SQL execution, prompts like these are the right shape.

### Prompt: current monitor findings

```text
Query Supabase for the latest Synology Monitor findings.
1. Get the newest row from analysis_runs.
2. Get all non-resolved analyzed_problems for that run.
3. Get all active alerts joined to nas_units.
4. Summarize by severity, affected NAS, and technical diagnosis.
```

### Prompt: full issue history

```text
Query Supabase for the full history of issue $ISSUE_ID.
Load:
- issues row
- issue_messages in chronological order
- issue_evidence in chronological order
- issue_actions in chronological order
- issue_jobs
- issue_state_transitions
- issue_stage_runs
- facts joined through issue_facts
Then summarize what the monitor found, what the AI recommended, what the operator said, and what actions succeeded or failed.
```

### Prompt: everything the monitor knows right now

```text
Load the current Synology Monitor backend state from Supabase.
Use analysis_runs, analyzed_problems, alerts, nas_units, and the 10 most recently updated issues.
For those issue IDs also load issue_messages, issue_actions, issue_evidence, issue_jobs, issue_state_transitions, and issue_stage_runs.
Return:
1. current surfaced problems
2. current recommendations/actions
3. unresolved conversations waiting on the operator
4. most recent remediation results
```

## Practical rules

- Prefer `analyzed_problems` plus `alerts` for "what did the monitor find?"
- Prefer `issues` plus related issue tables for "what has the AI already done or said?"
- Prefer `issue_actions.result_text` for remediation outcomes.
- Prefer `issue_messages` over `last_agent_message` when reconstructing a full conversation.
- Prefer `issue_stage_runs` when you need to know why the AI made a decision.

## Repo references

For code that reads or writes this state, start here:
- [issue-store.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-store.ts)
- [issue-view.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-view.ts)
- [issue-agent.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-agent.ts)
- [copilot-issues.ts](/worksp/monitor/app/apps/web/src/lib/server/copilot-issues.ts)
- [log-analyzer.ts](/worksp/monitor/app/apps/web/src/lib/server/log-analyzer.ts)
