# NAS Monitor — Agent Handoff Prompt

You are continuing work on the NAS Monitor AI resolution agent. Below is a complete picture of the product, architecture, what has been attempted, what is broken, and what needs to be built next.

---

## What the product is

NAS Monitor is a Next.js 15 web app that monitors two Synology NAS devices (edgesynology1, edgesynology2) over SSH. The "Assistant" page (/assistant) hosts an AI agent that diagnoses and fixes NAS problems.

**Stack:**
- Next.js 15, Supabase (Postgres), OpenRouter for AI
- AI models: Gemini Flash (planning/diagnosis fast path via `callMinimaxJSON`), a configurable remediation model for fix proposals (via `callRemediation`), a configurable second-opinion model for reflection/quality gating (via `callSecondOpinion`)
- Deployed at https://mon.designflow.app via Coolify pulling from ghcr.io/u2giants/synology-monitor-web:latest

**Repo:** github.com/u2giants/synology-monitor — push to master only. GitHub Actions builds Docker image → GHCR → Coolify deploys automatically. Coolify is in dockerimage mode (pulls pre-built image from GHCR), NOT dockerfile mode.

**Deployment SSH:** root@178.156.180.212 with ed25519 key; Coolify panel at http://178.156.180.212:8000

**Supabase:** qnjimovrsaacneqkggsn.supabase.co

---

## What the agent is supposed to do (the vision)

1. One linear conversation per issue — user messages are direct replies to agent messages, agent messages are direct replies to user messages. Like a chat with a knowledgeable engineer who happens to be running commands in the background.
2. The agent is the DRIVER, not a passive passenger. It takes charge, proposes actions, executes them, reports back, asks follow-up questions.
3. Persistent memory per issue that survives page refreshes and server restarts — everything tried, every result, every user message, every agent response.
4. When user rejects a fix, agent immediately proposes a different one (not the same thing).
5. When user sends a message, agent reads it and responds to it directly, not just "notes" it somewhere in a prompt.

---

## Current architecture (what exists)

### State machine phases
`planning → diagnosing → analyzing → proposing_fix → awaiting_fix_approval → applying_fix → verifying → resolved/stuck`

- Each phase is processed by a handler: `handlePlanning`, `handleDiagnosing`, `handleAnalyzing`, `handleProposingFix`, `handleApplyingFix`, `handleVerifying`, `handleRejectedFix`
- `tick()` is the main entry point — loads state, runs the appropriate handler, returns new state
- Tick is guarded with an in-memory Set (`activeTicks`) to prevent concurrent execution on the same resolution

### DB tables
- `smon_issue_resolutions` — one row per issue; key fields: `phase`, `diagnosis_summary`, `root_cause`, `fix_summary`, `verification_result`, `stuck_reason`, `description`, `auto_approve_reads`, `attempt_count`, `max_attempts`, `lookback_hours`
- `smon_resolution_steps` — one row per step; key fields: `category` (diagnostic/fix/verification), `tool_name`, `target`, `status` (planned/approved/running/completed/failed/skipped/rejected), `result_text`, `requires_approval`, `batch`, `step_order`, `command_preview`, `reason`, `risk`
- `smon_resolution_log` — activity log; `entry_type` in: `phase_change`, `plan`, `diagnosis`, `analysis`, `fix_proposal`, `step_result`, `verification`, `stuck`, `user_input`, `error`, `reflection`, `software_issue`

### API routes (under `/worksp/monitor/app/apps/web/src/app/api/resolution/`)
- `POST /api/resolution/create` — creates a resolution and triggers first tick
- `POST /api/resolution/tick` — advances the state machine one step
- `POST /api/resolution/approve` — approves or rejects steps, then calls tick
- `POST /api/resolution/message` — logs user message, optionally restarts phase, then calls tick
- `GET /api/resolution/list` — lists all resolutions
- `POST /api/resolution/delete` — deletes a resolution

### Frontend polling
- `use-resolution.ts` hook polls `/api/resolution/tick` every 2.5 seconds when phase is in `ACTIVE_PHASES`
- Stops polling when: terminal phase (resolved/stuck/cancelled), waiting for user (awaiting_fix_approval), or in diagnosing with only `planned` steps (waiting for user approval of read-only steps)

### Key files
```
/worksp/monitor/app/apps/web/src/lib/server/resolution-agent.ts   — main agent logic (~1763 lines)
/worksp/monitor/app/apps/web/src/lib/server/resolution-store.ts   — DB CRUD
/worksp/monitor/app/apps/web/src/lib/server/tools.ts              — NAS SSH tool definitions
/worksp/monitor/app/apps/web/src/lib/server/minimax.ts            — AI client wrapper (fast model)
/worksp/monitor/app/apps/web/src/app/(dashboard)/assistant/page.tsx — UI
/worksp/monitor/app/apps/web/src/hooks/use-resolution.ts          — frontend polling/state
/worksp/monitor/app/apps/web/src/app/api/resolution/             — API routes directory
```

---

## What has been tried and the current state of each problem

### Problem 1: Agent stuck at medium confidence, never proposes fix

**Root cause:** `needsMore` logic used `analysis.confidence !== "high"` — medium confidence always blocked progress.

**Fix applied (code is in place):**
- Changed to only block when `confidence === "low"` OR (`confidence === "medium"` AND `diagnosticRoundCount < MAX_DIAGNOSTIC_ROUNDS` which is 3)
- At max rounds, medium confidence falls through to `proposing_fix`
- Added semantic loop detection: if round 2+ returns the same `root_cause` as before, forces `needs_more_diagnostics = false` and `confidence = "high"`
- `gather_more` reflection at max rounds now logs and falls through — does NOT set `needs_more_diagnostics = true`

**Current status:** SHOULD BE FIXED in code. Watch for the edge case where `reflection.recommendation === "gather_more"` triggers a `callRemediation` that sets `analysis.needs_more_diagnostics = true` in the revised analysis. This revised analysis replaces the original, and could re-block progress if the revised call also returns new steps (though deduplication would filter them).

---

### Problem 2: Agent re-proposes the SAME fix after rejection

**Root cause (3 layers):**
1. The `awaiting_fix_approval` switch case previously did nothing — after rejection the phase stayed `awaiting_fix_approval`, and `hasPendingFix` in `handleProposingFix` treated rejected steps as "pending" and re-transitioned to `awaiting_fix_approval` immediately.
2. `fixProposalPrompt` did not include the list of rejected fixes, so the AI had no way to know what was already rejected.
3. The prompt said "prefer service restarts" which overrode any user context about not wanting restarts.

**Fix applied (code is in place):**
- Added `handleRejectedFix()` which is now called from the `awaiting_fix_approval` case in `tick()`
- `handleRejectedFix` skips orphaned verification steps, appends rejection context to `description`, transitions to `proposing_fix`
- `fixProposalPrompt` now has a "PREVIOUSLY REJECTED FIXES — DO NOT PROPOSE THESE AGAIN" section built from `steps.filter(s => s.category === "fix" && s.status === "rejected")`
- Prompt rule changed to "NEVER propose a fix from the PREVIOUSLY REJECTED FIXES list"
- `hasPendingFix` guard in `handleProposingFix` correctly only blocks on `planned` or `approved` status — rejected steps do not block

**Current status: STILL REPORTED AS FAILING by user.** The code looks correct on inspection. Three things to investigate first:

1. **Is `handleRejectedFix` actually being called?** Add a log at the very first line:
   ```typescript
   await safeAppendLog(supabase, userId, state.resolution.id, "fix_proposal",
     `[DEBUG] handleRejectedFix entered. fixSteps=${fixSteps.length}, pendingFix=${pendingFix.length}`);
   ```
   Check the activity log after a rejection.

2. **Is the rejection actually setting `status = "rejected"` in the DB?** Look at the approve route (`/api/resolution/approve/route.ts`). The `rejectSteps()` function in `resolution-store.ts` has a `.eq("status", "planned")` guard — if a step is already "approved" but not yet "running", this guard may prevent the rejection from landing. Consider removing the status guard from `rejectSteps`.

3. **Is the description field approach actually working?** After several cycles, description looks like:
   ```
   [original description]
   Additional context from user: [msg 1]
   Fix rejection context: Previously rejected fix(es): Restart service...
   User guidance on fix: [msg 2]
   Fix rejection context: Previously rejected fix(es): Restart service...
   ```
   LLMs can deprioritize this. The real fix is the architectural conversation layer (see below).

---

### Problem 3: User messages ignored / agent feels like "2 personalities"

**Root cause:**
1. No agent acknowledgment when user sends a message
2. `getHistoryContext` was gated on `attempt_count > 0`, so planner forgot all history when replanning
3. User messages only flowed into prompts via `getUserContext()` embedded deep in long prompts

**Fix applied (code is in place):**
- Added agent acknowledgments to message route (logged as `analysis` entry type)
- Removed `attempt_count` gate from `getHistoryContext` — always includes all completed/failed diagnostic steps with "DO NOT RE-PROPOSE" directive
- `fixProposalPrompt` now includes `getUserContext(res)` and reads `description` prominently

**Current status:** PARTIALLY FIXED — acknowledgments appear in the activity log. But fundamentally the agent still does not feel like one coherent personality because the underlying architecture has no true conversation layer (see below).

---

### Problem 4: Agent re-runs same diagnostics when replanning

**Root cause:** `getHistoryContext` returned empty string when `attempt_count === 0`.

**Fix applied:** `getHistoryContext` now always includes all completed/failed diagnostic steps. `handlePlanning` builds an `alreadyRun` Set from all existing diagnostic steps and deduplicates AI output against it before creating steps.

**Current status:** SHOULD BE FIXED. Verify in a multi-round resolution.

---

### Problem 5: Synology tools (synopkg, synoshare) not in PATH on SSH sessions

**Fix applied:** Changed to full paths `/usr/syno/bin/synopkg` and `/usr/syno/sbin/synoshare` in `tools.ts`.

**Current status:** FIXED.

---

## The fundamental architectural problem (not yet fixed)

This is the most important thing to understand. The "conversation" is broken at the architectural level, which is why patches keep not feeling right.

**1. There is no conversation — there is a dashboard with an activity log bolted on.**

The agent communicates through: structured fields on the resolution record (`diagnosis_summary`, `fix_summary` — these overwrite each other), and activity log entries (what the agent DID, not what it SAID). There is no concept of "the agent said X to the user" as a distinct tracked action.

**2. The message box is disconnected from the agent's decision loop.**

When the user types something, `message/route.ts` logs it as `user_input` and calls `tick()`. But `tick()` runs the next phase handler mechanically. It does not "read" the message and respond to it. The agent only indirectly sees user messages via `getUserContext()` embedded deep in AI prompts. There is no "agent response to user message" step.

**3. The `description` field is a dumping ground.**

Description accumulates: original description + "Additional context from user: ..." + "Fix rejection context: ..." + "User guidance on fix: ...". This is not a proper conversation history. It grows without bound, gets deprioritized by LLMs, and has no semantic structure.

**4. The UI is designed for a dashboard, not a conversation.**

The Assistant page shows: phase stepper, diagnosis card, fix card, verification card, pending actions, message box, activity log. The activity log is great for technical transparency. But there is no chat thread — no back-and-forth dialogue, no way to see the agent's "voice" separate from its technical actions.

---

## What needs to be built next (in order)

### Step 1: Immediate debug fixes

Add the debug log at the top of `handleRejectedFix` and verify it fires after a rejection. Fix the `rejectSteps` status guard if needed. These are quick and will confirm whether the rejection flow works end-to-end.

### Step 2: Add a proper conversation layer

**Add a new Supabase table:**
```sql
create table smon_resolution_messages (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid references smon_issue_resolutions(id) on delete cascade,
  user_id uuid,
  role text check (role in ('user', 'agent')),
  content text not null,
  created_at timestamptz default now()
);
create index on smon_resolution_messages(resolution_id, created_at);
```

**Add to `resolution-store.ts`:**
- `appendMessage(supabase, userId, resolutionId, role, content)` — writes to `smon_resolution_messages`
- `loadMessages(supabase, userId, resolutionId)` — loads all messages ordered by `created_at`

**Update `resolution-agent.ts`:**
After each significant phase transition, the agent writes a conversational message with `role = 'agent'`:
- After `handlePlanning` creates steps: "Starting investigation. I'm going to check [plan_summary]. This should take about a minute."
- After `handleAnalyzing` completes: "Here's what I found: [diagnosis_summary]. Root cause: [root_cause]. Proposing a fix now."
- After `handleProposingFix` creates steps: "I'd like to [fix_summary]. Risk: [risk_assessment]. Please approve or reject below."
- After `handleRejectedFix`: "Got it. I won't do that. Looking for a different approach..."
- After `handleVerifying` if resolved: "Issue is resolved. [verification_summary]"
- After `handleVerifying` if not resolved: "The fix didn't fully work. [remaining_concerns]. Starting another round."
- After any `stuck` transition: "I'm stuck and need your help. [stuck_reason]"

**Update `message/route.ts`:**
- Write user message to `smon_resolution_messages` with `role = 'user'` (in addition to or instead of the `user_input` log entry)
- After logging, generate a brief conversational response: call the AI with the last 5 messages as context and ask it to acknowledge the user's message and explain what it will do next (1-2 sentences). Write this as `role = 'agent'`.
- Stop appending to `description`. Instead, the conversation table IS the history.

**Update the prompts:**
- Replace `getUserContext()` (which scans log entries for `user_input` type) with a function that reads the last N messages from `smon_resolution_messages`
- Replace description-appending in `message/route.ts` and `handleRejectedFix` with conversation table reads

**Update the UI:**
- In `use-resolution.ts`, load messages alongside steps and log: add `messages` to `ResolutionFull`
- In `assistant/page.tsx`, render `smon_resolution_messages` as a chat thread (user bubbles right, agent bubbles left) above or alongside the activity log
- The message box already exists; wire it to write to the conversation table

**Key insight:** The activity log is for technical transparency (what commands ran, step results, phase changes). The conversation thread is for the human-agent dialogue (what was said, what was decided). These serve different purposes and MUST be separate.

---

## Important conventions

- **Always commit and push after every implementation.** User expects the full commit+push cycle automatically. Do not ask "want me to commit?" — just do it. Run `git add [files] && git commit -m "..." && git push origin master` from `/worksp/monitor/app` (or the repo root — check with `git rev-parse --show-toplevel`).
- Push to `master` branch only.
- Coolify is in dockerimage mode. GitHub Actions builds on push to master and pushes to GHCR. Coolify polls GHCR and deploys. Do not change Coolify settings.
- `updateResolution` in `resolution-store.ts` does NOT have a `description` field in its typed `updates` parameter — raw Supabase queries are used directly to update `description`.
- `safeAppendLog` wraps `appendLog` and never throws — use it for informational entries. Use `appendLog` directly only when failure to log should propagate (rare).
- The tick lock (`activeTicks`) is in-memory and resets on server restart. Fine for single-instance; would need a DB-level lock on multi-instance.

---

## Quick orientation checklist for the new Claude

1. Read `/worksp/monitor/app/apps/web/src/lib/server/resolution-agent.ts` — focus on `handleRejectedFix` (~line 1616) and `handleProposingFix` (~line 1447) to understand the fix rejection flow.
2. Read `/worksp/monitor/app/apps/web/src/app/api/resolution/approve/route.ts` to see how step approval/rejection works end-to-end.
3. Check `rejectSteps` in `resolution-store.ts` (~line 311) for the `.eq("status", "planned")` guard that may be preventing rejection.
4. Add the debug log to `handleRejectedFix`, push, reproduce the rejection, and check the activity log.
5. Once the rejection flow is confirmed working, proceed with the conversation layer architectural change.
