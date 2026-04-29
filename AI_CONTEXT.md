# AI Context Map

Last verified: 2026-04-18 UTC

Purpose:
- This file tells a coding agent such as Claude Code how to find the Synology Monitor app's live state in Supabase.
- Use this when the agent has direct Supabase access via MCP or SQL tools.

Scope:
- current findings surfaced by the monitor
- issue conversations with the operator
- remediation proposals, approvals, executions, and results
- supporting evidence, facts, jobs, and stage runs

## Source of truth

The repo is not the source of truth for live monitor state.

Live monitor state is in Supabase.

If an agent is running in this folder without Supabase access, it cannot see the app's full findings/history just by reading local files.

## Table naming

Application code queries the renamed public tables without the `smon_` prefix, for example:
- `nas_units`
- `alerts`
- `analysis_runs`
- `analyzed_problems`
- `issues`
- `issue_messages`

Older migrations and architecture docs still reference the original `smon_*` names. Treat the prefixless names as the active app-facing names unless a database inspection proves otherwise.

## Read this first

To reconstruct the full state of the monitor, query these groups in this order:

1. Current surfaced problems
- `analyzed_problems`
- `analysis_runs`
- `alerts`
- `nas_units`

2. Durable issue threads
- `issues`
- `issue_messages`
- `issue_evidence`
- `issue_actions`

3. Agent workflow state
- `issue_jobs`
- `issue_state_transitions`
- `issue_stage_runs`
- `facts`
- `issue_facts`

4. Capability and telemetry interpretation
- `capability_state` if present, otherwise inspect the capability-store queries in code
- `metrics`
- `nas_logs`
- `storage_snapshots`
- `security_events`

## What each table means

`analysis_runs`
- Each bulk analysis pass over recent telemetry.
- Use this to find the latest monitor-level diagnosis run.

`analyzed_problems`
- The monitor's grouped, surfaced problems from an analysis run.
- This is the closest table to "all the problems the monitor found".
- Important columns:
  - `title`
  - `explanation`
  - `technical_diagnosis`
  - `severity`
  - `affected_nas`
  - `status`
  - `analysis_run_id`
  - `created_at`

`alerts`
- Active or resolved alert rows emitted by monitoring logic.
- Useful for current operator-visible failures and symptoms.
- Important columns:
  - `severity`
  - `status`
  - `source`
  - `title`
  - `message`
  - `details`
  - `nas_id`
  - `created_at`

`nas_units`
- Lookup table for NAS IDs, names, and hostnames.
- Join this to `alerts` and telemetry tables to turn NAS UUIDs into names like `edgesynology1` and `edgesynology2`.

`issues`
- Durable issue threads used by the issue-centric workflow.
- One issue is the long-lived container for discussion, evidence, actions, and status.
- Important columns:
  - `origin_type`
  - `origin_id`
  - `title`
  - `summary`
  - `severity`
  - `status`
  - `affected_nas`
  - `current_hypothesis`
  - `hypothesis_confidence`
  - `next_step`
  - `conversation_summary`
  - `last_agent_message`
  - `last_user_message`
  - `updated_at`

`issue_messages`
- Conversation between the operator and the AI issue worker.
- This is the primary history of "conversations with me".
- Important columns:
  - `issue_id`
  - `role`
  - `content`
  - `created_at`

`issue_evidence`
- Human-readable evidence attached to an issue.
- Includes telemetry summaries, diagnostics, and user statements.

`issue_actions`
- Proposed and executed remediation or diagnostic steps.
- This is the primary history for recommendations and action results.
- Important columns:
  - `kind`
  - `status`
  - `target`
  - `tool_name`
  - `command_preview`
  - `summary`
  - `reason`
  - `expected_outcome`
  - `rollback_plan`
  - `risk`
  - `requires_approval`
  - `result_text`
  - `approval_token`
  - `completed_at`

`issue_jobs`
- Backend queue entries for issue workflow work.
- Useful for understanding what is queued, running, completed, or failed.

`issue_state_transitions`
- Explicit status changes for an issue over time.
- Use this to see whether an issue moved to `running`, `waiting_for_approval`, `resolved`, and so on.

`issue_stage_runs`
- Structured records of model/decision stages such as hypothesis ranking, planning, explanation, and verification.
- Useful for understanding what the issue worker concluded at each step.

`facts`
- Normalized facts derived from telemetry or analysis.
- Higher-signal than raw logs when present.

`issue_facts`
- Join table from `issues` to `facts`.

## Minimal query plan

If the goal is "show me everything the monitor knows right now", do this:

1. Latest surfaced monitor problems
- latest row from `analysis_runs` ordered by `created_at desc`
- all non-resolved rows from `analyzed_problems` for that run
- all `alerts` where `status = 'active'`

2. Durable investigation threads
- latest rows from `issues` ordered by `updated_at desc`
- for the relevant issue IDs:
  - `issue_messages`
  - `issue_evidence`
  - `issue_actions`
  - `issue_jobs`
  - `issue_state_transitions`
  - `issue_stage_runs`

3. NAS identity resolution
- `nas_units` for name/hostname lookup

## SQL starting point

Use queries like these as a starting point.

```sql
select id, created_at, summary, problem_count
from analysis_runs
order by created_at desc
limit 1;
```

```sql
select id, title, explanation, technical_diagnosis, severity, affected_nas, status, created_at
from analyzed_problems
where analysis_run_id = $LATEST_RUN_ID
  and status <> 'resolved'
order by created_at asc;
```

```sql
select a.id, a.severity, a.status, a.source, a.title, a.message, a.details, a.created_at,
       n.name as nas_name, n.hostname
from alerts a
left join nas_units n on n.id = a.nas_id
where a.status = 'active'
order by a.created_at desc;
```

```sql
select id, origin_type, title, summary, severity, status, affected_nas,
       current_hypothesis, hypothesis_confidence, next_step,
       conversation_summary, last_agent_message, last_user_message,
       created_at, updated_at
from issues
order by updated_at desc
limit 25;
```

```sql
select issue_id, role, content, created_at
from issue_messages
where issue_id = $ISSUE_ID
order by created_at asc;
```

```sql
select issue_id, kind, status, target, tool_name, command_preview, summary,
       reason, expected_outcome, rollback_plan, risk, requires_approval,
       result_text, completed_at, created_at
from issue_actions
where issue_id = $ISSUE_ID
order by created_at asc;
```

## Code paths that use this data

For code-level orientation, start here:
- [AGENTS.md](/worksp/monitor/app/AGENTS.md)
- [issue-store.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-store.ts)
- [issue-view.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-view.ts)
- [issue-agent.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-agent.ts)
- [issue-detector.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-detector.ts)
- [log-analyzer.ts](/worksp/monitor/app/apps/web/src/lib/server/log-analyzer.ts)
- [backend-findings.ts](/worksp/monitor/app/apps/web/src/lib/server/backend-findings.ts)

## Practical rule for future agents

If a user asks:
- what problems the monitor found
- what the monitor recommended
- what the AI already told the operator
- what actions were proposed or executed

do not answer from the repo alone.

Query Supabase first.
