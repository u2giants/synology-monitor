# HANDOFF — 2026-05-29 session

Read `AGENTS.md` first. This file captures the live state at the end of the
2026-05-29 session so the next developer/AI can continue without questions. Delete
it when the two open items below are resolved.

## What this session did and why

The owner reported the "Issue Investigator" felt far dumber than Claude over SSH.
Investigating that surfaced two production bugs (now fixed), several doc/code
inaccuracies (now fixed), committed secrets (now redacted), and produced a full
design for rebuilding the issue-agent (in `PLAN.md`).

## Fully done (committed + deployed to `main`; DB changes applied live)

- **Log/alert ingestion fix** — dropped the brittle `nas_logs`/`alerts` source
  whitelists (migration `00035`); agent no longer emits `"filter"` severity; WAL
  sender now isolates a bad row instead of failing the whole batch
  (`apps/agent/internal/sender/sender.go` `postRows`, + `logwatcher/watcher.go`).
  Verified: previously-blocked sources flow fresh. Commit `b9f1c0c`.
- **pg_partman repair** — re-pointed `part_config` to the renamed parents, drained
  the 6-week default-partition backlog (~12.85M metric rows) into weekly
  partitions, restored retention/premake, reclaimed 3.34 GB. Applied live via
  `psql` (not a migration — it was data movement). Default partitions are empty;
  new writes route correctly.
- **`smon_` cleanup** — migration `00034` renamed 4 standalone functions + cron;
  docs/comments corrected; vestigial pre-rename SQL deleted. Commit `248a3ab`.
- **Secret redaction** — real NAS API secrets/keys, relay tokens, Supabase
  service-role key, and a NAS SSH password were committed in
  `RECOVERY_PROMPT.md`, `apps/relay/.env.runtime`, `scripts/backfill-synobackup.mjs`,
  `apps/web/.env.example`, and `deploy/synology/nas-{1,2}.env.example`. All redacted
  to placeholders; `.env.runtime` untracked + gitignored. Commits `f15822d` + this
  session's docs commit.
- **Relay shell-injection fix** — `find_problematic_files` now quotes its input.
  Commit `e15cbc3`.
- **Documentation pass** — `AGENTS.md` rebuilt to the full 14-section spec; README,
  CLAUDE.md, and `docs/{architecture,development,configuration,deployment}.md`
  corrected against verified code/config; `PLAN.md` added/expanded.

## Open / not started

1. **Rotate the leaked credentials (OWNER ACTION).** Redaction only cleans the
   working tree — the values are still in public git history and must be treated
   as compromised. Regenerate and update in each place that consumes them:
   - NAS API secret + signing key → each NAS `.env` **and** Coolify `NAS_EDGE{1,2}_*`
     (web + nas-mcp).
   - Relay bearer + admin secret → Coolify (relay).
   - Supabase service-role key → Supabase dashboard → then agent `.env` + Coolify web.
   - NAS SSH password for user `popdam`.
2. **Issue-agent 3-stage rewrite (NOT STARTED).** Fully designed in `PLAN.md`.
   Do the coding in a **fresh session** (clean context). Exact next action: open a
   new session, "read `PLAN.md` and `AGENTS.md`, implement from PLAN.md's build
   order step 1." Prerequisite for Stage 2: add direct-provider API keys
   (`ANTHROPIC_API_KEY`, etc.) in Coolify.

## Decisions made this session (and why)

- **Do not re-add a source whitelist** on `nas_logs`/`alerts` — it caused the
  outage and provides no value the app relies on.
- **Sender must isolate poison rows**, never all-or-nothing batches.
- **3-stage rebuild, not 1 model for everything** — a single frontier model would
  waste cost on cheap mechanical work; 3 stages with caching is the sweet spot.
- **Models chosen at runtime via admin** (3 stages × model+effort dropdowns) — do
  not hardcode model ids.
- **Caching must use provider-native SDKs, not an aggregator** on the inference
  path (see PLAN.md §6 — full provider-by-provider playbook + CI guards).

## Dead ends / gotchas hit (so you don't repeat them)

- pg_partman `partition_data_proc` in this Supabase install has a **corrupted
  `format()` in its lock-wait branch** — do NOT pass `p_lock_wait` (leave 0).
- A **120s `statement_timeout`** kills big partman batches — set
  `PGOPTIONS='-c statement_timeout=0'` for maintenance sessions.
- partman cannot partition the **current, actively-written week** (live-write race
  on attaching the new partition) — had to do a manual atomic detach → create
  current+future partitions → backfill instead.
- pg_partman lives in the `public` schema here, not `partman`.

## Risks / unknowns

- Leaked secrets remain exploitable until rotated (item 1).
- The rebuild assumes complete, fresh ingestion — true now, but if ingestion
  regresses, fix that first (check `nas_logs` freshness + the per-row sender path).
- Relay has no CI build workflow — its deploy path is manual/undocumented.

## Session context that would otherwise be lost

The detailed "why the agent underperforms" analysis (lossy extractor, fragmented
7-stage pipeline, narrow fingerprint scope, re-chew loop, no caching, stale-now-
fixed data) and the corrected caching architecture are captured in `PLAN.md` §1
and §6. The operational state of the DB is in memory note
`db-partman-and-ingestion-state`.
