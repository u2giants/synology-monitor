# Synology Monitor Remediation Plan

## Purpose

This file is the implementation brief for the next coding pass.

The goal is to make the Synology Monitor web app's alert analysis, sync triage,
and NAS Copilot flows actually useful for a non-technical operator.

This plan is intentionally detailed so an implementation model can code against
it directly without needing to rediscover the current failures.

The most important product outcome is:

1. When a user sees a sync or system problem, the UI must explain it in plain
   English.
2. The user must be able to send one problem or many related problems into AI
   for grouped diagnosis.
3. NAS Copilot must receive actual context when launched from an alert,
   diagnosed problem, or triage workflow.
4. The dashboard, sync triage view, and AI insights page must use a coherent
   data model instead of three unrelated pipelines.

## Current Production Reality

These observations were verified from:

1. The checked-out repository in `/worksp/monitor/app`
2. The live Coolify application `nas-monitor-web`
3. The live Supabase project tables with prefix `smon_`

### Live app / deployment facts

1. Coolify app UUID is `lrddgp8im0276gllujfu7wm3`.
2. Coolify says the app deploys from GitHub repo `u2giants/synology-monitor`
   branch `master`.
3. The production environment has these key variables configured:
   `OPENROUTER_API_KEY` (replaces old `OPENAI_API_KEY`, `MINIMAX_API_KEY`,
   `MINIMAX_GROUP_ID`), `CRON_SECRET`, NAS SSH connection variables, and
   Supabase public env vars pointing to the dedicated `qnjimovrsaacneqkggsn`
   project.

### Live database facts (updated 2026-04-06)

1. `smon_ai_analyses` has live rows and is still being populated.
2. `smon_analysis_runs` — now receiving rows (RLS policies were added to fix
   silent insert block).
3. `smon_analyzed_problems` — now receiving rows (same RLS fix).
4. `smon_alerts` has many active rows.
5. `smon_copilot_sessions` has rows.
6. There are extra live tables such as `smon_drive_activities` and
   `smon_sync_remediations` that are not defined in the tracked migrations in
   this repo.
7. `smon_process_snapshots`, `smon_disk_io_stats`, `smon_net_connections`,
   `smon_sync_task_snapshots` — resource attribution tables, active and
   receiving data. Created via `resource-snapshot-migration.sql`.
8. `smon_service_health` — new; DSM service status snapshots. Migration 00019.
9. `smon_custom_metric_schedules`, `smon_custom_metric_data` — new; AI-driven
   dynamic metric collection. Migrations 00018, 00020.

### Important implication

Production is running with a mixed state:

1. An older SQL-driven AI pipeline is working (writes `smon_ai_analyses`).
2. A newer application-driven analysis pipeline (google/gemini-2.5-flash via
   OpenRouter) writes `smon_analysis_runs` and `smon_analyzed_problems`.
3. The newer pipeline is now functional after RLS and token limit fixes.
4. The UI expects the newer pipeline in several places.
5. Several of the problems below have been fixed (see items marked **FIXED**).

## User-Visible Problems To Fix

The following are the concrete product issues that must be solved.

### Problem 1: raw alert details are useless

Example:

`"28 sync errors detected in the last hour on NAS edgesynology1."`

When the user opens details, they see only:

```json
{
  "error_count": 28
}
```

That is not a diagnosis.

The system must instead surface:

1. What actually failed
2. Which NAS was affected
3. Which files/shares/users were involved if known
4. The likely cause in plain English
5. The suggested next action

### Problem 2: analysis is one-at-a-time instead of grouped

The user does not want to click one problem after another and manually ask AI
to reason over each item separately.

The system must support:

1. Grouped analysis over many related alerts/logs
2. Pattern detection across repeated sync failures
3. Correlation across NASes
4. A single "analyze this cluster" or "analyze all current sync issues" flow

### Problem 3: Sync Triage is a raw log dump

The current page is mostly a filtered log viewer.

That is useful for an engineer, but not enough for the intended operator.

Sync Triage must provide:

1. Plain-English grouped issue summaries
2. Evidence from the underlying logs
3. Root cause candidates
4. A button to ask Copilot with real payload attached
5. Suggested fix paths

### Problem 4: AI Insights is unclear

The page currently implies "No AI analyses yet" unless rows load. But in
production `smon_ai_analyses` already has rows, and the page's purpose is not
explained clearly enough.

This page must clearly represent:

1. What the scheduled AI pipeline is
2. What it is analyzing
3. Why it may differ from on-demand grouped problem analysis
4. The latest successful scheduled run time
5. Whether the scheduled pipeline is healthy

### Problem 5: Active Alerts and Sync Triage don't match

Overview and Sync Triage use different datasets:

1. Overview active alerts use `smon_alerts`
2. Sync Triage uses filtered `smon_logs`

This is why "View All Alerts" lands on a page with different items.

The app needs a consistent mapping:

1. Alerts should link to the exact underlying issue or cluster
2. Sync Triage should be able to show the alert-generated issue source
3. If a view crosses datasets, the UI must say so explicitly

### Problem 6: Run Analysis Now does nothing — **FIXED**

Was caused by two issues: (1) `smon_analysis_runs`/`smon_analyzed_problems` had
RLS enabled with no policies (silent insert block); (2) diagnosis model
responses were being truncated at 8K tokens. Both fixed. The pipeline now
persists results correctly.

### Problem 8: I/O spike diagnosis had no process/disk attribution — **FIXED**

Added three new agent collectors (process, diskstats, connections) and four new
Supabase tables. The Copilot now automatically includes this data in every
response without needing an SSH tool call. See `AGENTS.md` for schema details.

### Problem 9: AI cannot diagnose Synology Drive/ShareSync failures — **FIXED**

The AI was saying "the decisive logs are missing" and acting as a passive
passenger. Root causes identified and fixed:

1. **Wrong log files** — added synowebapi.log, synoshare.log, synostorage.log,
   kern.log, synoservice.log, synoinfo.log to the logwatcher
2. **Missing DSM API integrations** — added GetShares(), GetInstalledPackages(),
   GetRecentSystemLogs() to the DSM client and ShareHealthCollector
3. **No targeted diagnostic tools** — added check_io_stalls, check_share_database,
   check_drive_package_health, check_kernel_io_errors, search_webapi_log,
   check_drive_database, search_all_logs, check_filesystem_health
4. **No Synology error pattern knowledge** — added KNOWN SYNOLOGY ERROR PATTERNS
   section to both planningPrompt and analysisPrompt
5. **SSH banner treated as normal** — now flagged as a symptom
6. **AI didn't know it could expand collection** — prompts now explain the
   missing_data_suggestions mechanism explicitly
7. **AI acted passive** — SAFETY_PREAMBLE rewritten as "YOU ARE THE DRIVER"
8. **Infinite diagnostic loop** — MAX_DIAGNOSTIC_ROUNDS = 3 prevents cycling
9. **"undefined (undefined): undefined" bug** — null/undefined steps filtered
   before display in stuck message
10. **Second opinion JSON failures** — callSecondOpinion() rewritten with
    dedicated JSON enforcement (system message + prompt instruction + regex
    fallback)

### Problem 10: No visibility into DSM service health — **FIXED**

Added `ServiceHealthCollector` (services.go) polling 12 key DSM services every
60 seconds, plus OOM kill / segfault detection from dmesg. All results go to
`smon_service_health` and `smon_logs` source `kernel_health`.

### Problem 11: Missing memory pressure, inode, and temperature data — **FIXED**

Added `SysExtrasCollector` (sysextras.go) polling every 30 seconds for:
- Memory pressure (MemAvailable%, SwapUsed%, Dirty+Writeback KB)
- Inode usage (df -i /volume1)
- CPU temperature (/sys/class/thermal/thermal_zone*/temp)

### Problem 12: AI cannot permanently expand what the agent collects — **FIXED**

Added the dynamic metric collection system:
- AI specifies missing_data_suggestions in analysis response
- processMissingDataSuggestions() creates smon_custom_metric_schedules rows
- CustomCollector (custom.go) polls schedules every 60s, runs commands natively
- Results in smon_custom_metric_data, injected into future analyses
- referenced_count tracks how often each metric is used; >= 3 = promote to
  built-in collector

### Problem 7: Analyze with Copilot opens Copilot without context

The current button flow depends on `problemId` from `smon_analyzed_problems`.
That table is empty, so prompt generation fails.

The Copilot launch flow must work for:

1. analyzed problem rows
2. alert rows
3. triage-selected raw logs
4. grouped clusters assembled on the fly

## Root Causes Identified So Far

### Root cause A: Minimax response parsing — **FIXED**

The diagnosis model (now google/gemini-2.5-flash via OpenRouter) was returning
valid JSON that was being truncated because `maxTokens` was set to 8000.
Increased to 32000. The parser also strips markdown fences and leading/trailing
whitespace. Analysis runs are now persisted correctly.

### Root cause B: the UI depends on empty analysis tables — **PARTIALLY FIXED**

The analysis tables are now populated. UI wiring improvements (Problems 1–5,
7) from the original plan remain as future work.

### Root cause C: the alert pipeline stores only counts, not explanation

The older SQL-based AI pipeline inserts alerts with generic summary text and a
small `details` object.

Example live row:

1. title: `Sync Errors Detected`
2. message: `28 sync errors detected in the last hour on NAS edgesynology2.`
3. details: `{"error_count":28}`

That data model is too thin for a useful details UI.

### Root cause D: there are two AI pipelines with unclear responsibilities

Pipeline 1:

1. SQL cron pipeline
2. writes `smon_ai_analyses`
3. writes generic `smon_alerts`

Pipeline 2:

1. application route `/api/analysis`
2. uses google/gemini-2.5-flash
3. writes `smon_analysis_runs`
4. writes `smon_analyzed_problems`

These pipelines overlap conceptually but are not integrated.

### Root cause E: alert and triage views are not normalized around a common issue entity

The UI currently jumps between:

1. raw alerts
2. raw logs
3. analyzed problems
4. Copilot sessions

without one stable "issue" record that everything points to.

### Root cause F: AI acted as passive passenger — **FIXED**

The AI's SAFETY_PREAMBLE has been rewritten. The AI now:
- Is told explicitly it is "THE DRIVER, NOT A PASSENGER"
- Knows the escalation ladder: search_all_logs → specific tool → add collection_command → ask operator
- Knows it can ask about service interruption timing
- Has pre-loaded knowledge of Synology-specific error patterns
- Has 8 new targeted diagnostic tools to use before giving up

## Design Direction

The correct product shape is:

1. Raw telemetry enters `smon_logs`, `smon_alerts`, `smon_security_events`,
   and other source tables.
2. A grouping/diagnosis layer produces issue records suitable for humans.
3. The UI primarily presents grouped issues, not isolated raw rows.
4. Raw logs remain available as evidence, not as the main user-facing diagnosis.
5. NAS Copilot consumes one structured evidence bundle regardless of entry
   point.

## Recommended Architecture

### Keep both AI pipelines, but separate their purposes clearly

#### Scheduled pipeline

Use `smon_ai_analyses` for:

1. periodic health snapshots
2. anomaly summaries
3. background trend reports
4. passive monitoring

This powers the AI Insights page.

#### On-demand / issue-grouping pipeline

Use `smon_analysis_runs` and `smon_analyzed_problems` for:

1. grouping recent alerts/logs by root cause
2. generating plain-English issue summaries
3. driving dashboard "Diagnosed Problems"
4. driving Sync Triage AI summaries
5. launching Copilot with structured issue context

This powers operator workflows.

### Introduce a canonical evidence bundle builder

Create one shared server-side path that can build Copilot input from:

1. analyzed problem IDs
2. alert IDs
3. lists of raw log IDs
4. ad hoc grouped filters such as "all current sync issues"

The result should be a structured object with:

1. summary
2. human explanation
3. technical diagnosis
4. related alerts
5. related logs
6. related NAS names
7. affected files/shares/users
8. recommended questions for Copilot

### Normalize UI navigation around issue context

Buttons should not merely route to `/assistant`.

They should carry enough context for the backend to reconstruct the exact issue.

Preferred model:

1. `contextType`
2. `contextId`
3. optional `sourceIds`

Examples:

1. `/assistant?contextType=problem&contextId=<problem_id>`
2. `/assistant?contextType=alert&contextId=<alert_id>`
3. `/assistant?contextType=triageCluster&contextId=<cluster_id>`

## Implementation Plan

The work should be done in the order below.

### Phase 1: repair the broken analysis pipeline — **COMPLETE**

✅ Analysis pipeline repaired (RLS fix, token limit fix)
✅ Second opinion model JSON enforcement
✅ Infinite loop prevention (MAX_DIAGNOSTIC_ROUNDS)
✅ Null step filtering in stuck message

### Phase 2: make alerts understandable

#### 4. Translate raw sync-error alerts into plain English

Files likely involved:

1. `apps/web/src/components/dashboard/alert-list.tsx`
2. new shared formatting helper under `apps/web/src/lib/server/` or
   `apps/web/src/lib/`
3. possibly new API support if alert details need server-side enrichment

Tasks:

1. Detect known alert patterns such as:
   1. `Sync Errors Detected`
   2. generic AI anomaly alerts
   3. storage / security / agent alerts
2. For sync-error alerts, enrich them by looking up the related recent
   `drive_server` / `drive_sharesync` rows near the alert window.
3. Generate a layman explanation.
4. Show:
   1. "what happened"
   2. "why we think it happened"
   3. "what to do next"
5. Preserve access to raw details for engineers.

Known live sync cases to support:

1. `edgesynology2` repeated `share-service.cpp(30): Failed to SYNOShareGet()`
2. `edgesynology2` `service-ctrl.cpp.o(406): error when reading st (st) :stoi`
3. `edgesynology2` references to `/volume1/@synologydrive/@sync` "no such
   share"
4. `edgesynology1` repeated thumbnail / Exiv2 read failures

### Phase 3: unify alert-to-Copilot handoff

#### 5. Replace problem-only Copilot launch with generic context launch

Files:

1. `apps/web/src/app/(dashboard)/assistant/page.tsx`
2. `apps/web/src/app/api/copilot/problem-prompt/route.ts`
3. `apps/web/src/lib/server/resolution-agent.ts`
4. possibly a renamed route like `api/copilot/context-prompt/route.ts`

Tasks:

1. Replace the narrow `problemId` flow with a more general context route.
2. Add support for:
   1. `problemId`
   2. `alertId`
   3. `logIds`
   4. `scope=all-current-sync-issues`
3. Build a prompt and evidence bundle from whichever source launched the
   assistant.
4. If a row is missing, show a clear error inside the chat UI instead of just
   navigating with no context.

### Phase 4: enable grouped multi-error analysis

#### 7. Add "analyze all current sync issues" flow

Files:

1. `apps/web/src/app/(dashboard)/sync-triage/page.tsx`
2. `apps/web/src/app/(dashboard)/page.tsx`
3. `apps/web/src/lib/server/log-analyzer.ts`
4. maybe a new server helper for clustering selected rows

Tasks:

1. Add a bulk action from Sync Triage and/or Overview.
2. Allow analysis against:
   1. all sync-related alerts
   2. all sync-related logs in the chosen window
   3. selected rows
3. Persist the resulting grouped problems.
4. Make the grouped result visible before going into Copilot.

### Phase 5: repair Sync Triage UX

#### 9. Make AI analysis first-class in Sync Triage

Files:

1. `apps/web/src/app/(dashboard)/sync-triage/page.tsx`

Tasks:

1. Keep the raw log list, but move it into an evidence section.
2. Promote grouped diagnoses to the top of the page.
3. Add one-click actions:
   1. Analyze current filtered rows
   2. Send filtered rows to Copilot
   3. Show root-cause summary

### Phase 6: clarify AI Insights

#### 11. Redefine AI Insights as scheduled health intelligence

Files:

1. `apps/web/src/app/(dashboard)/ai-insights/page.tsx`

Tasks:

1. Update the copy so the page explicitly says this is the scheduled background
   AI pipeline.
2. Show:
   1. last scheduled run
   2. analysis type
   3. whether the pipeline is healthy
3. If no rows exist, explain why.
4. If rows exist but the page cannot load them, show an error state instead of
   a misleading "No AI analyses yet."

### Phase 7: data-model cleanup

#### 12. Decide what to do with legacy / out-of-band tables

Live DB contains tables not defined in current repo migrations:

1. `smon_drive_activities`
2. `smon_sync_remediations`
3. possibly others

Tasks:

1. Inventory whether production still depends on them.
2. If they are still required:
   1. add migrations to this repo so GitHub is the source of truth
3. If they are obsolete:
   1. stop referencing them in UI logic
   2. optionally deprecate them later

## Concrete Code Changes Expected

This section lists the likely code touchpoints.

### High-confidence files to modify

1. `apps/web/src/lib/server/log-analyzer.ts`
2. `apps/web/src/app/api/analysis/route.ts`
3. `apps/web/src/app/(dashboard)/page.tsx`
4. `apps/web/src/app/(dashboard)/sync-triage/page.tsx`
5. `apps/web/src/app/(dashboard)/ai-insights/page.tsx`
6. `apps/web/src/app/(dashboard)/assistant/page.tsx`
7. `apps/web/src/lib/server/resolution-agent.ts`
8. `apps/web/src/components/dashboard/alert-list.tsx`

### Possible new files

1. `apps/web/src/lib/server/alert-explainer.ts`
2. `apps/web/src/lib/server/copilot-context.ts`
3. `apps/web/src/app/api/copilot/context-prompt/route.ts`
4. `apps/web/src/app/(dashboard)/alerts/page.tsx`

### Possible migration files

Only if needed:

1. a migration to extend `smon_analysis_runs` with failure status
2. a migration to bring undocumented live tables into source control
3. a migration to support richer alert-to-issue linkage if necessary

## Detailed Behavior Requirements

### A. Alert explanation requirements

For each alert shown in the UI:

1. show title
2. show a one-sentence plain-English explanation
3. show evidence summary
4. show recommended next step
5. provide raw JSON/log access separately

### B. Analysis button requirements

When the user clicks "Run Analysis Now":

1. show immediate activity state
2. report success or failure explicitly
3. update the visible grouped problems list
4. record the latest run time
5. surface any failure reason in a compact human-readable message

### C. Copilot launch requirements

When launching Copilot from any issue source:

1. create a new chat by default
2. send the issue context automatically
3. attach evidence IDs / evidence blocks
4. show a visible activity message while context is loading
5. if prompt generation fails, display that failure in the chat area

### D. Sync Triage requirements

The page must let the user do all of the following:

1. inspect raw sync logs
2. read grouped English summaries
3. analyze the currently filtered set
4. launch Copilot with the current filtered set
5. see what evidence the AI used

### E. AI Insights requirements

The page must say clearly:

1. this is scheduled background AI
2. it is different from on-demand incident diagnosis
3. it currently runs on a schedule
4. the latest run status/time

## Testing Plan

### Unit / local logic tests

Add tests for:

1. JSON extraction from second opinion model prose responses
2. alert explanation mapping for known sync failure patterns
3. prompt generation for:
   1. problem context
   2. alert context
   3. multi-log context
4. missing_data_suggestions → schedule row creation

### Integration checks

Verify:

1. `POST /api/analysis` successfully stores:
   1. one row in `smon_analysis_runs`
   2. one or more rows in `smon_analyzed_problems`
2. dashboard loads those problems
3. Sync Triage loads and filters grouped sync problems
4. assistant auto-seeds a chat from problem/alert context
5. custom metric schedules are picked up by the CustomCollector within 60s

### Live data checks

Use current live cases:

1. `edgesynology2` repeated `SYNOShareGet()` / `stoi` failures
2. `edgesynology1` repeated `Exiv2 exception: E20 Failed to read input data`
3. current `smon_ai_analyses` rows

The app should be able to explain those cases sensibly.

## Non-Goals

Do not spend time on these before the core issue flow works:

1. cosmetic styling changes
2. broad refactors unrelated to analysis / triage / Copilot wiring
3. replacing the scheduled SQL AI pipeline entirely
4. changing NAS agent telemetry collection unless needed for missing context
   (note: the agent now has 13 collectors and dynamic metric collection — the
   collection layer is now very comprehensive)

## Recommended Execution Order For The Coding Pass

1. ~~Fix analysis pipeline~~ ✅ Done
2. ~~Verify rows appear in `smon_analysis_runs`~~ ✅ Done
3. ~~Add diagnostic tools and log sources~~ ✅ Done (8 new tools, 6 new log sources)
4. ~~Add service health, memory pressure, inode, temperature collection~~ ✅ Done
5. ~~Add dynamic metric collection~~ ✅ Done
6. ~~Fix infinite loop and second opinion JSON~~ ✅ Done
7. Make dashboard and Sync Triage show analysis rows clearly
8. Replace problem-only Copilot handoff with generic context handoff
9. Add alert-context prompt generation
10. Add grouped multi-error analysis and "send filtered set to Copilot"
11. Clarify AI Insights as scheduled background analysis
12. Reconcile undocumented live tables or document why they remain external

## Definition Of Done

This work is done only when all of the following are true:

1. `Run Analysis Now` creates a visible, persisted analysis result. ✅
2. The dashboard shows grouped human-readable issues instead of only vague raw
   alerts.
3. Clicking into a sync-error issue explains the actual likely problem in plain
   English.
4. The user can analyze multiple related sync errors together.
5. Sync Triage offers AI diagnosis on the current filtered problem set.
6. Launching NAS Copilot from an issue actually sends issue data into the chat.
7. AI Insights accurately reflects the scheduled background pipeline.
8. Navigation between alerts, triage, grouped problems, and Copilot is
   consistent and understandable.
9. The resolution agent successfully diagnoses Drive/ShareSync failures without
   saying "I don't have access to X". ✅ (in progress — new tools + data
   available; real-world validation pending)

## Final Instruction To The Implementing Model

Do not patch around symptoms one page at a time.

Implement the issue flow end to end:

1. reliable grouped analysis persistence ✅
2. understandable alert explanation
3. consistent issue-to-Copilot context passing
4. clear separation between scheduled AI insights and on-demand incident
   diagnosis

If a tradeoff is required, prioritize:

1. plain-English issue quality
2. grouped multi-error reasoning
3. successful Copilot context handoff
4. coherent data model

over

1. perfect UI polish
2. preserving legacy alert behavior exactly as-is
