---
issue: 31
status: OPEN
owner: claude/docs-doc-health-overhaul (session of 2026-11-11, edge-dev3)
---

# Handoff — re-verify the pending-work board (synology-monitor)

Written 2026-11-11 3:05 PM EST. Proving issue: https://github.com/u2giants/synology-monitor/issues/31

## 0. Business decisions only the owner can make

One, and only if the check below shows it is still undone: whether to rotate the
AI provider key that the former anonymous SQL path exposed on 2026-07-16 (the
board says "Owner-approved rotation"). Standing rule since then: a value published
off this computer is compromised and the AI rotates it itself, so the successor
should first establish whether the exposure counts as published; ask Albert only
if that is genuinely a business choice. Nothing else needs him.

## 1. What this application is

Synology Monitor (`u2giants/synology-monitor`, branch `main`) watches POP
Creations' two production Synology NAS units. A Go agent on each NAS sends
telemetry to Supabase project `aaxtrlfpnoutziwhshlt`; a dashboard at
`mon.designflow.app` raises issues; a NAS API and the `synology-monitor` MCP
server run guarded diagnostics and repairs. Start at https://github.com/u2giants/synology-monitor/blob/main/AGENTS.md and the
generated index https://github.com/u2giants/synology-monitor/blob/main/docs/INDEX.md.

## 2. What this session set out to do, and why

A documentation overhaul for popcre/designflow-backend issue 391 (owner,
2026-11-11: "All repos should get this."). Delivered and merged as
https://github.com/u2giants/synology-monitor/pull/30 (commit `750f6a9`): the
router went from 42,576 to 18,245 bytes, every document has a header, the index
is generated, the health check is clean, keeper run 43088354502 succeeded.

## 3. Current state

- Done and verified: everything in PR 30. `ai-doc-health --repo .` exits 0.
- NOT done: the board https://github.com/u2giants/synology-monitor/blob/main/docs/pending-work.md was moved word for word from the
  old AGENTS.md. Nobody checked whether its five rows are still true. The
  documentation task forbade NAS, database and application work, so this was
  deliberately left.
- The former root HANDOFF.md (content last updated 2026-08-26) was moved
  verbatim to https://github.com/u2giants/synology-monitor/blob/main/HANDOFF.d/2026-11-11T1929Z-edge-dev3-claude-legacy-migrated-handoff.md . Its file name carries the
  migration date, so the 30-day age check will not flag it until about
  2026-12-11 even though its content is eleven weeks old. It has no contract
  block, so housekeeping reports it UNATTRIBUTED.

The five rows and what is already known:

| Row | Known evidence | Unknown |
|---|---|---|
| Repair nine archive directory mtimes (write NAS 1 only) | Procedure and the table of nine directories are in the legacy handoff, section 3A | Whether any were repaired after 2026-08-26 |
| Complete Seafile inotify remediation | Runbook: https://github.com/u2giants/synology-monitor/blob/main/docs/seafile-sync-inotify.md | Whether the live verification was run |
| Drain expired telemetry and repair pg_partman | https://github.com/u2giants/synology-monitor/blob/main/docs/telemetry-retention.md says the drain is "Complete and live as of 2026-07-17" (about 81.6M rows) and that the pg_partman backlog of about 8.4 GB is still open. So the row is probably half stale: drain done, pg_partman open | Current pg_partman state |
| Rotate the exposed AI key | Incident recorded in https://github.com/u2giants/synology-monitor/blob/main/docs/incident-log.md (2026-07-16) | Whether it was rotated |
| Review `nas_logs` database share, due 2026-08-17 | Overdue by twelve weeks on the face of it | Whether it was ever run |

## 4. What was tried and did not work

Nothing was attempted on these rows. One tooling note: `ai-pr-wait` is a shell
script; running it through `python3` fails with a syntax error. Run it directly.
The `ai-doc-health` launcher is not on PATH on edge-dev3; run
`python3 <ai-devops checkout>/bin/ai-doc-health --repo .`.

## 5. Root causes and key findings

- The board and the legacy handoff drifted because both were hand-kept inside
  large files that every session loaded but few updated.
- `PLAN.md` must stay at the repository root: about 35 code comments and applied
  (immutable) migrations cite it by name.
- A few topic documents still say "AGENTS.md §12/§13"; those numbers were already
  wrong before the overhaul. The content they meant is now in
  https://github.com/u2giants/synology-monitor/blob/main/docs/idiosyncrasies.md and https://github.com/u2giants/synology-monitor/blob/main/docs/incident-log.md.

## 6. Exact next steps

1. Read https://github.com/u2giants/synology-monitor/blob/main/docs/pending-work.md and section 3 and 6 of the legacy handoff.
2. For each row, gather read-only evidence first:
   - mtimes: `stat` the nine directories on `edgesynology1` through the
     `synology-monitor` MCP and compare with the table in the legacy handoff.
   - Seafile: follow the verification section of the Seafile runbook.
   - pg_partman and `nas_logs`: read-only queries from
     https://github.com/u2giants/synology-monitor/blob/main/docs/telemetry-retention.md against project `aaxtrlfpnoutziwhshlt`
     (log the project ref before any query).
   - AI key: check the 1Password `vibe_coding` item's last-changed date and the
     Coolify value's age; never print the value.
3. Update each row to done (with date and evidence), open (with the true next
   action), or split it. Regenerate nothing by hand; if a header changes run
   `ai-doc-health --repo . --fix-index`.
4. Apply the successor rule to the legacy handoff: delete it only if every
   continuation item in it is proven finished; otherwise write what remains
   into your own new HANDOFF.d file and say so. Never edit it in place.
5. Deliver by branch and pull request to `main`, merge it, delete this file in
   the same pull request if the board is fully verified, and close issue 31.

Done when: every row on the board cites evidence dated on or after the day you
check it, `ai-doc-health --repo .` exits 0, and issue 31 is closed.

## 7. Constraints and gotchas

- Verification is read-only. Any repair (mtimes, pg_partman, key rotation) is
  separate work with its own safety rules: https://github.com/u2giants/synology-monitor/blob/main/docs/nas-maintenance-safety.md ,
  https://github.com/u2giants/synology-monitor/blob/main/docs/telemetry-retention.md . For timestamp repair, `edgesynology2` is
  evidence only; write only `edgesynology1`.
- NAS reads over 25 seconds need the long-running-operations skill; avoid large
  crawls while SMB users are active.
- A blocked NAS command is a permanent refusal for that command, not a degraded
  session; use the bounded alternative it names.
- NAS `.env` plaintext passwords are an accepted owner decision; never flag or
  rotate over it.
- The Documentation health workflow is advisory and must never be made a
  required check.

## 8. Access and environment

- NAS access: MCP server named `synology-monitor` (seven tools; reach the rest
  with `tool_search` / `invoke_tool`). SSH aliases `edgesynology1`,
  `edgesynology2` are for diagnostics only; sudo needs the service-account
  password through 1Password `op_run`.
- Secrets: 1Password vault `vibe_coding` only; see https://github.com/u2giants/synology-monitor/blob/main/docs/1password.md .
- Git: commit as Albert's verified identity; sign GitHub posts with
  `$AI_GH_SIGNATURE`.

## 9. Open questions and risks

- If the AI key was never rotated, it has been exposed-then-closed since
  2026-07-16; treat confirming this as the most urgent row.
- pg_partman default partitions may have kept growing since July; measure
  before planning any repair.
- The legacy handoff lists more than the five board rows (compose
  reconciliation, about 470 `_Conflict` artifacts); the board may be
  incomplete as well as stale.
