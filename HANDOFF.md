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
