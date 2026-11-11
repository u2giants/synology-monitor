---
summary: Critical incidents since 2026-05: merge conflicts, anonymous SQL exposure, ingestion lag, wrong Supabase project, leaked secrets.
kind: living
status: current
read-when: Investigating a failure, or about to repeat an operation that has gone wrong before.
---

# Critical incidents

Moved verbatim from `AGENTS.md` on 2026-11-11 so the router stays small. Add each new incident here, never in `AGENTS.md`. Longer evidence lives in the dated incident documents listed in [`INDEX.md`](INDEX.md).

### 2026-07-16/17 — a folder merge created 63 sync conflicts and 66 unreadable directories

What happened:
Merging `Dollar General Fall Winter 2026.wrong` into its live sibling copied 39
files that already existed under a different case, and created 66 directories with
mode `000`.

Impact:
Synology Drive forked the case-colliding files into 63 `*_Conflict` artifacts and
pushed them to every SeaDrive client; users could not enter the 66 directories.
No data was lost.

Root cause:
Two defects in the merge script. It compared paths case-sensitively on a
case-sensitive filesystem serving case-insensitive clients. And it mirrored
directory permissions with `chmod --reference`, which DSM parses as a symbolic
mode that strips all bits and returns success.

Recovery:
A repair pass restored the 66 directories to `777`, deleted 40 redundant/stale
copies (each with a verified surviving counterpart), and moved 23 stranded files
back. A later recursive pass resolved 21 pre-existing conflict artifacts, which
*recovered* 81 files — including product photography that existed only inside the
conflict forks. Recovery point: Btrfs snapshot of the `mac` subvolume.

Rule added to prevent recurrence:
See "Moving or merging files inside a share" in [`nas-maintenance-safety.md`](nas-maintenance-safety.md). Tooling and 55 regression tests
live in `scripts/synology/`; both defects have named tests. The share still holds
~470 unresolved conflict artifacts — work order in
`docs/synology-fileserver-audit.md`.

### 2026-07-16 — anonymous SQL execution exposed the AI key

What happened:
A `SECURITY DEFINER` SQL executor retained default execute grants.

Impact:
The anonymous role could run arbitrary SQL and read stored AI credentials.

Root cause:
Function ownership was hardened without revoking default grants.

Recovery:
Live grants were revoked and migration `00043` records the fix.

Rule added to prevent recurrence:
Every privileged function needs explicit role tests and revoked `PUBLIC`/`anon`
execute grants. Rotation follow-up remains in the open handoff under `HANDOFF.d/`.

### 2026-07-16 — agent ingestion fell roughly 80 minutes behind

What happened:
Large mixed inserts repeatedly retried one bad row and shutdown truncated flushing.

Impact:
Telemetry looked current enough to trust while lag kept growing.

Root cause:
Whole-batch retry and a ten-second container stop window.

Recovery:
Batch isolation shipped and `stop_grace_period: 90s` was materialized on both NASes.

Rule added to prevent recurrence:
Alert on ingestion age, isolate rejected rows, and verify compose-only changes live.

### 2026-06-22 — retention work targeted the deleted Ohio project

What happened:
Stale repository references pointed database work at the rollback project.

Impact:
The live Virginia backend received none of the intended retention work.

Root cause:
Stashed stale project references and an unsafe script fallback.

Recovery:
All active references now use `aaxtrlfpnoutziwhshlt`; the runner requires an
explicit URL and rejects the retired ref.

Rule added to prevent recurrence:
Log and verify the project ref before database work. See the migration and retention docs.

### 2026-05-29 — ingestion freeze and pg_partman failure

What happened:
One invalid log row stalled a batch, while pg_partman cron called a procedure with
`SELECT` and failed repeatedly.

Impact:
Logs/alerts froze and partition defaults accumulated millions of rows.

Root cause:
Silent batch retry and an invalid maintenance invocation.

Recovery:
Sender isolation fixed ingestion; pg_partman recovery remains active work.

Rule added to prevent recurrence:
No silent fallback, monitor freshness/cron results, and run maintenance manually
under observation before re-enabling cron. See `docs/telemetry-retention.md`.

### 2026-05 — secrets committed and MCP/NAS diagnostics overloaded production

What happened:
Recovery/example files contained live credentials; separate recursive diagnostics
ran for days and MCP sessions hung.

Impact:
Credential rotation and production NAS load were required.

Root cause:
Inadequate ignore/secret discipline and unbounded recursive commands.

Recovery:
Secrets were rotated, `.mcp.json` is ignored, recursive internal-store scans are
hard-blocked, and MCP became stateless/lazy-loaded.

Rule added to prevent recurrence:
Use 1Password references, never commit runtime env, and bound NAS diagnostics.
Detailed evidence is in `docs/mcp-incident-2026-05.md` and the Synology incident docs.

