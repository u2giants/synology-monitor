# Current Task

## Status: PHASE 1 COMPLETE — AWAITING REVIEW & PUSH

## Task: Remediation Plan Implementation (PLAN.md)

### Summary
Implement the full remediation plan defined in PLAN.md to make the Synology Monitor
web app's alert analysis, sync triage, and NAS Copilot flows actually useful for
a non-technical operator.

### Phases (from PLAN.md)

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Repair broken analysis pipeline (Minimax parsing + persistence) | ✅ Complete |
| 2 | Make alerts understandable (plain-English explanations) | ⏳ Not started |
| 3 | Unify alert-to-Copilot handoff (generic context launch) | ⏳ Not started |
| 4 | Enable grouped multi-error analysis | ⏳ Not started |
| 5 | Repair Sync Triage UX | ⏳ Not started |
| 6 | Clarify AI Insights page | ⏳ Not started |
| 7 | Data-model cleanup (undocumented live tables) | ⏳ Not started |

### Active Branch
`main` (Albert confirmed: work directly on main)

### Phase 1 Changes

| File | What Changed |
|------|-------------|
| `apps/web/src/lib/server/minimax.ts` | Added `sanitizeMinimaxResponse()` + `extractFirstJSON()`. Strips `<think>` tags, markdown fences, extracts first valid JSON via bracket-counting. Applied in `callMinimaxJSON()` before `JSON.parse()`. Parse failures log only first 500 chars of raw response. |
| `apps/web/src/lib/server/log-analyzer.ts` | Added `storeFailedRun()` helper. Added `AnalysisFailureReason` type. `analyzeRecentLogs()` now returns `failureReason` in all error paths and calls `storeFailedRun()` on `minimax_error`. `no_events` does not store a failed run. |
| `apps/web/src/app/api/analysis/route.ts` | POST returns HTTP 200 + `noEvents: true` for `no_events`. Real failures return HTTP 500 with `{ error, failureReason, userMessage }`. GET handler unchanged. |
| `supabase/migrations/00015_add_analysis_run_status.sql` | Adds `status TEXT NOT NULL DEFAULT 'success'` and `error_message TEXT` to `smon_analysis_runs`. |

### Next Step
Reviewer-Pusher to review and push to remote.

### Last Updated
2026-04-05
