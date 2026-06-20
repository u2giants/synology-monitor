## Archive `___OLD` Directory Mtime Repair

Status:
partial

Done:
- Repaired source directory mtimes under `/volume1/mac/Decor/Character Licensed/___OLD` on `edgesynology1` from `/tmp/edges2_dir_current_authority_20260615.csv`.
- Verified `source_authority_mismatches_after_repair 0` for the affected `___OLD` source subtree.
- Verified `source_dirs_today_count=0` and `source_files_today_count=0` under the source `___OLD` tree.
- Code commit `eb253f25fc6d8e1bdab1f76133b290017e9a0d8a` restores mtimes on source directories that survive a partial archive move.

Next action:
- Repair nine Archive directory mtimes under `/volume1/mac/Archive/Decor/Character Licensed/___OLD` on `edgesynology1`. The SSH user cannot apply these without sudo: `os.utime` returned `PermissionError(1, 'Operation not permitted')`.
- Confirm `GET http://100.107.131.35:7734/health` and `GET http://100.107.131.36:7734/health` report build `eb253f25fc6d8e1bdab1f76133b290017e9a0d8a` or newer after Watchtower updates the NAS API containers.

Risks / watchouts:
- Use `edgesynology2` authority data as evidence, but write repairs only to `edgesynology1` unless the user explicitly asks otherwise.
- The remaining Archive mismatches found on 2026-06-16 were:
  - `Decor/Character Licensed/___OLD`: `2023-02-24 15:38:42 -0500 <- 2026-06-16 10:33:20 -0400`
  - `Decor/Character Licensed/___OLD/Blinds - Paper Shades/Redi Order 1/Raw/Revised 36x78in`: `2024-12-06 08:10:42 -0500 <- 2024-12-06 08:10:36 -0500`
  - `Decor/Character Licensed/___OLD/CNV012 Nick 10x13.5 no LED`: `2026-04-05 12:51:27 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Cap`: `2026-04-05 12:51:25 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Iron Man`: `2026-04-05 12:51:32 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Old/Hulk`: `2026-04-05 12:51:45 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/SpiderMan`: `2026-04-05 12:51:33 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Embossed PVC/WonderWoman`: `2026-04-05 12:51:21 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Jojo Siwa/HIRES (1)`: `2026-04-05 12:51:31 -0400 <- 2026-03-25 00:51:05 -0400`

## Seafile (`seaf-cli`) inotify watch exhaustion — capabilities + remediation

Status:
partial (code complete + tested; not committed/pushed/deployed; NAS not yet remediated)

Done:
- Diagnosed root cause: `seaf-cli` falsely reports "synchronized" because
  `fs.inotify.max_user_watches=8192` is exhausted by the ~541k-dir worktree (82%
  `@eaDir`). Full writeup: `docs/seafile-sync-inotify.md`.
- Added two MCP capabilities (verified: `go test ./internal/validator/...` ok; turbo
  `pnpm type-check` clean):
  - `set_inotify_watches` (tier 2) — `packages/shared/src/nas-tools.ts` + TOOL_GROUPS,
    enabled in `apps/nas-mcp/tools-config.json`.
  - `write_seafile_ignore` (tier 3) — same files.
  - Validator: one `(>>?)\s*['"]?/(btrfs/)?volume\d+/` pattern added to writePatterns
    + filePatterns in `apps/nas-api/internal/validator/validator.go`, with
    `TestInotifyAndSeafileIgnoreClassification` in `validator_test.go`.

Next action:
- Commit + push to `main` (changes are in apps/nas-api, apps/nas-mcp, packages/shared
  → nas-api updates via Watchtower ~5 min; nas-mcp redeploys via Coolify). No compose
  change needed (`/host/etc` already mounted, per `persist_vm_overcommit_memory`).
- Then run the runbook in `docs/seafile-sync-inotify.md` §6 on edgesynology1:
  `set_inotify_watches` (default `1048576 1024`) → `write_seafile_ignore` per library
  root → restart seaf-cli daemon → verify 0 `No space left on device` errors after
  restart.

Risks / watchouts:
- Do NOT remediate by restarting the daemon alone (masks, does not fix).
- Do NOT lower `max_user_watches` "to save memory" — it is a ceiling, not an
  allocation; lowering only removes headroom.
- Unverified: whether seaf-cli's monitor watches dirs listed in `seafile-ignore.txt`.
  Verify per `docs/seafile-sync-inotify.md` §5b after deploy. The ceiling raise is the
  guaranteed fix regardless.
- seaf-cli daemon/container restart is NOT a sanctioned capability (docker allowlist
  blocks it from `run_command`); restart via the seaf-cli stack / DSM Container Manager.
