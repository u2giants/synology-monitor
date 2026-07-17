#!/bin/bash
# Tests for the Synology file-server scripts. No NAS required — they run against
# synthetic trees in a temp dir. Every case here is one that actually occurred in
# the "Character Licensed" share.
#
#   bash scripts/synology/tests/run-tests.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$(dirname "$HERE")"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
chk() { if eval "$2"; then echo "  PASS: $1"; else echo "  FAIL: $1"; fail=1; fi; }
old(){ touch -d "2026-01-21 12:00" "$1"; }
new(){ touch -d "2026-01-28 12:00" "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
echo "### lib: conflict-name parsing"
# shellcheck source=../lib-nas-safe.sh
. "$S/lib-nas-safe.sh"
chk "parses simple conflict base" \
    '[ "$(nas_conflict_base "HSR57DYLS05_Elizabeths-MacBook-Pro.local_Jan-19-140821-2026_Conflict")" = "HSR57DYLS05" ]'
chk "parses ADMIN conflict base" \
    '[ "$(nas_conflict_base "PPS Photos_ADMIN_Jul-16-180037-2026_Conflict")" = "PPS Photos" ]'
chk "keeps underscores in base (the greedy-strip trap)" \
    '[ "$(nas_conflict_base "UP00ADYLS12_MOCKUP_DESKTOP-HKGCSV3_Jan-15-123319-2026_Conflict")" = "UP00ADYLS12_MOCKUP" ]'
chk "parses CaseConflict" \
    '[ "$(nas_conflict_base "SNMH7DYLS01_ART_edgesynology2_Jan-21-173321-2026_CaseConflict")" = "SNMH7DYLS01_ART" ]'
chk "rejects a normal name" \
    '! nas_conflict_base "AA066DYLS01_art" >/dev/null'
chk "is_conflict_name true for artifact" \
    'nas_is_conflict_name "x_ADMIN_Jul-16-180037-2026_Conflict.ai"'
chk "is_conflict_name false for normal file" \
    '! nas_is_conflict_name "AA066DYLS01_art.ai"'
# Regression: a DIRECTORY whose device name contains dots (.local). The buggy
# ${name%.*} pre-strip lopped it at .local and skipped 8 real conflict dirs.
chk "is_conflict_name true for .local DIRECTORY" \
    'nas_is_conflict_name "HSR57DYLS05_Elizabeths-MacBook-Pro.local_Jan-19-140821-2026_Conflict"'
chk "conflict_base of .local dir strips only the suffix" \
    '[ "$(nas_conflict_base "HSR57DYLS05_Elizabeths-MacBook-Pro.local_Jan-19-140821-2026_Conflict")" = "HSR57DYLS05" ]'
# Regression: Seafile DownloadCaseConflict, 4-digit time, base with underscore.
chk "is_conflict_name true for DownloadCaseConflict" \
    'nas_is_conflict_name "NUN10DYNX01_art_DiskStation_Nov-18-1047-2025_DownloadCaseConflict.ai"'
chk "conflict_base of DownloadCaseConflict keeps _art" \
    '[ "$(nas_conflict_base "NUN10DYNX01_art_DiskStation_Nov-18-1047-2025_DownloadCaseConflict")" = "NUN10DYNX01_art" ]'
chk "is_conflict_name true for edgesynology2 CaseConflict file" \
    'nas_is_conflict_name "SNMH7DYLS01_ART_edgesynology2_Jan-21-173321-2026_CaseConflict.ai"'

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "### merge-folders.sh: case-insensitivity (BUG 1 regression)"
M="$T/m"; mkdir -p "$M/src/SKU1/PPS Photos" "$M/dst/SKU1/PPS photos"
echo same > "$M/dst/SKU1/PPS photos/a.JPG"; old "$M/dst/SKU1/PPS photos/a.JPG"
echo same > "$M/src/SKU1/PPS Photos/a.JPG"; old "$M/src/SKU1/PPS Photos/a.JPG"
echo brand-new > "$M/src/SKU1/PPS Photos/new.JPG"; old "$M/src/SKU1/PPS Photos/new.JPG"
echo main-newer > "$M/dst/SKU1/_PACKAGING.ai"; new "$M/dst/SKU1/_PACKAGING.ai"
echo wrong-older > "$M/src/SKU1/_packaging.ai"; old "$M/src/SKU1/_packaging.ai"
SRC="$M/src" DST="$M/dst" DRY_RUN=0 bash "$S/merge-folders.sh" >/dev/null 2>&1
chk "did NOT create case-variant dir 'PPS Photos'" '[ ! -d "$M/dst/SKU1/PPS Photos" ]'
chk "new file landed in the EXISTING 'PPS photos'"  '[ -f "$M/dst/SKU1/PPS photos/new.JPG" ]'
chk "identical file not duplicated"                 '[ "$(ls "$M/dst/SKU1/PPS photos" | wc -l)" = "2" ]'
chk "did NOT create case-variant file"              '[ ! -f "$M/dst/SKU1/_packaging.ai" ]'
chk "older source did not overwrite newer dest"     '[ "$(cat "$M/dst/SKU1/_PACKAGING.ai")" = "main-newer" ]'

echo
echo "### merge-folders.sh: newest-wins + flatten + reanchor"
M2="$T/m2"; mkdir -p "$M2/src/WALL CLOCK/MWB10DYLS01" "$M2/dst/MWB10DYLS01"
echo v2 > "$M2/src/WALL CLOCK/MWB10DYLS01/art.ai"; new "$M2/src/WALL CLOCK/MWB10DYLS01/art.ai"
echo v1 > "$M2/dst/MWB10DYLS01/art.ai";            old "$M2/dst/MWB10DYLS01/art.ai"
# Real case: .wrong had "NONWOVEN FABRIC TOY CHEST/NUN4VDYLS01" while main kept
# the same SKU under "Nonwoven Collapsible Toy Chest/NUN4VDYLS01". FLATTEN only
# strips a top-level name containing a space, so the fixture must have one.
mkdir -p "$M2/src/NONWOVEN FABRIC TOY CHEST/NUN4VDYLS01" "$M2/dst/Nonwoven Collapsible Toy Chest/NUN4VDYLS01"
echo x > "$M2/src/NONWOVEN FABRIC TOY CHEST/NUN4VDYLS01/pkg.ai"; old "$M2/src/NONWOVEN FABRIC TOY CHEST/NUN4VDYLS01/pkg.ai"
mkdir -p "$M2/src/_Working Files/sub"; echo w > "$M2/src/_Working Files/sub/w.ai"; old "$M2/src/_Working Files/sub/w.ai"
SRC="$M2/src" DST="$M2/dst" FLATTEN=1 REANCHOR=1 DRY_RUN=0 bash "$S/merge-folders.sh" >/dev/null 2>&1
chk "flattened category out of the path"     '[ ! -d "$M2/dst/WALL CLOCK" ]'
chk "newer source overwrote older dest"      '[ "$(cat "$M2/dst/MWB10DYLS01/art.ai")" = "v2" ]'
chk "reanchored under existing category dir" '[ -f "$M2/dst/Nonwoven Collapsible Toy Chest/NUN4VDYLS01/pkg.ai" ]'
chk "no stray flat dir created"              '[ ! -d "$M2/dst/NUN4VDYLS01" ]'
chk "_Working Files NOT flattened"           '[ -f "$M2/dst/_Working Files/sub/w.ai" ]'

echo
echo "### merge-folders.sh: dry run writes nothing"
M3="$T/m3"; mkdir -p "$M3/src/S" "$M3/dst"; echo a > "$M3/src/S/a.ai"
SRC="$M3/src" DST="$M3/dst" DRY_RUN=1 bash "$S/merge-folders.sh" >/dev/null 2>&1
chk "dry run created nothing" '[ ! -e "$M3/dst/S/a.ai" ]'

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "### resolve-drive-conflicts.sh"
R="$T/r"; mkdir -p "$R/SKU1/PPS photos" "$R/SKU1/PPS Photos_ADMIN_Jul-16-175945-2026_Conflict"
C="$R/SKU1/PPS Photos_ADMIN_Jul-16-175945-2026_Conflict"; Tg="$R/SKU1/PPS photos"
echo same > "$Tg/a.JPG"; old "$Tg/a.JPG"; echo same > "$C/a.JPG"; old "$C/a.JPG"
echo NEW > "$Tg/b.JPG";  new "$Tg/b.JPG"; echo old  > "$C/b.JPG"; old "$C/b.JPG"
echo stranded > "$C/c.JPG"; old "$C/c.JPG"
echo cnew > "$C/d.JPG"; new "$C/d.JPG"; echo dold > "$Tg/d.JPG"; old "$Tg/d.JPG"
mkdir -p "$R/SKU2"
echo p > "$R/SKU2/SKU2_PACKAGING.ai"; new "$R/SKU2/SKU2_PACKAGING.ai"
echo p > "$R/SKU2/SKU2_packaging_ADMIN_Jul-16-180052-2026_Conflict.ai"; old "$R/SKU2/SKU2_packaging_ADMIN_Jul-16-180052-2026_Conflict.ai"
echo lone > "$R/SKU2/ORPH_thing_ADMIN_Jul-16-180000-2026_Conflict.ai"; old "$R/SKU2/ORPH_thing_ADMIN_Jul-16-180000-2026_Conflict.ai"
mkdir -p "$R/SKU3/TP"; echo x > "$R/SKU3/TP/x.ai"; chmod 000 "$R/SKU3/TP"; chmod 000 "$R/SKU3"

ROOT="$R" DRY_RUN=1 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk "dry run deleted nothing" '[ -f "$C/a.JPG" ]'
chk "dry run left mode 000"   '[ "$(stat -c %a "$R/SKU3")" = "0" ]'

ROOT="$R" DRY_RUN=0 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk "identical conflict copy deleted"      '[ ! -e "$C/a.JPG" ]'
chk "stale-older conflict copy deleted"    '[ ! -e "$C/b.JPG" ]'
chk "newer original untouched"             '[ "$(cat "$Tg/b.JPG")" = "NEW" ]'
chk "stranded content MOVED to target"     '[ -f "$Tg/c.JPG" ] && [ "$(cat "$Tg/c.JPG")" = "stranded" ]'
chk "conflict-is-NEWER kept, not deleted"  '[ -f "$C/d.JPG" ]'
chk "conflict dir kept while non-empty"    '[ -d "$C" ]'
chk "identical conflict FILE deleted"      '[ ! -e "$R/SKU2/SKU2_packaging_ADMIN_Jul-16-180052-2026_Conflict.ai" ]'
chk "its original survives"                '[ -f "$R/SKU2/SKU2_PACKAGING.ai" ]'
chk "orphan (only copy) left alone"        '[ -f "$R/SKU2/ORPH_thing_ADMIN_Jul-16-180000-2026_Conflict.ai" ]'
chk "mode-000 dir fixed"                   '[ "$(stat -c %a "$R/SKU3")" = "777" ]'
chk "nested mode-000 dir fixed"            '[ "$(stat -c %a "$R/SKU3/TP")" = "777" ]'

echo
echo "### resolve: .local conflict DIRECTORY is processed (not skipped)"
R3="$T/r3"; mkdir -p "$R3/NCX04MVSX01" "$R3/NCX04MVSX01_Elizabeths-MacBook-Pro.local_Jan-19-141949-2026_Conflict"
CD="$R3/NCX04MVSX01_Elizabeths-MacBook-Pro.local_Jan-19-141949-2026_Conflict"
echo dup > "$R3/NCX04MVSX01/keep.ai"; old "$R3/NCX04MVSX01/keep.ai"
echo dup > "$CD/keep.ai";            old "$CD/keep.ai"          # identical -> del
echo uniq > "$CD/only-here.ai";      old "$CD/only-here.ai"     # stranded -> move
ROOT="$R3" DRY_RUN=0 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk ".local conflict dir was processed"      '[ ! -d "$CD" ] || [ -z "$(ls -A "$CD" 2>/dev/null)" ]'
chk "identical file in .local dir deleted"   '[ ! -e "$CD/keep.ai" ]'
chk "stranded file moved out of .local dir"  '[ -f "$R3/NCX04MVSX01/only-here.ai" ]'

echo
echo "### resolve: NESTED conflict dir (SKU fork with subtree) is merged, not skipped"
# Mirrors NCX04SESC01: a conflict fork whose PPS photos/ + _SAMPLE/ hold unique
# files the target lacks, plus one identical and one stale nested file.
R4="$T/r4"; TG="$R4/NCX04SESC01"; CF="$R4/NCX04SESC01_Elizabeths-MacBook-Pro.local_Jan-19-142001-2026_Conflict"
mkdir -p "$TG/PPS photos" "$TG/_SAMPLE" "$CF/PPS photos" "$CF/_SAMPLE"
echo keep > "$TG/PPS photos/shot (1).JPG"; old "$TG/PPS photos/shot (1).JPG"
echo keep > "$CF/PPS photos/shot (1).JPG"; old "$CF/PPS photos/shot (1).JPG"   # identical -> del
echo uniq2 > "$CF/PPS photos/shot (2).JPG"; old "$CF/PPS photos/shot (2).JPG"  # unique -> move
echo uniq3 > "$CF/PPS photos/shot (3).PNG"; old "$CF/PPS photos/shot (3).PNG"  # unique -> move
echo art   > "$CF/_SAMPLE/NCX04SESC01_art.ai"; old "$CF/_SAMPLE/NCX04SESC01_art.ai"  # unique -> move
echo newmain > "$TG/_SAMPLE/sheet.pdf"; new "$TG/_SAMPLE/sheet.pdf"
echo oldfork > "$CF/_SAMPLE/sheet.pdf"; old "$CF/_SAMPLE/sheet.pdf"            # stale -> del
ROOT="$R4" DRY_RUN=0 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk "unique nested photo moved into target"        '[ -f "$TG/PPS photos/shot (2).JPG" ]'
chk "second unique nested photo moved"             '[ -f "$TG/PPS photos/shot (3).PNG" ]'
chk "unique nested art moved into _SAMPLE"          '[ -f "$TG/_SAMPLE/NCX04SESC01_art.ai" ]'
chk "moved content is intact"                       '[ "$(cat "$TG/PPS photos/shot (2).JPG")" = "uniq2" ]'
chk "identical nested file did not duplicate"       '[ "$(ls "$TG/PPS photos" | wc -l)" = "3" ]'
chk "newer target file NOT overwritten by fork"     '[ "$(cat "$TG/_SAMPLE/sheet.pdf")" = "newmain" ]'
chk "entire conflict fork removed after merge"      '[ ! -d "$CF" ]'

echo
echo "### resolve: nested conflict-is-NEWER is kept, dir retained"
R5="$T/r5"; TG5="$R5/SKU/PPS photos"; CF5="$R5/SKU_dev_Jan-19-140000-2026_Conflict/PPS photos"
mkdir -p "$TG5" "$CF5"
echo oldmain > "$R5/SKU/PPS photos/x.jpg"; old "$R5/SKU/PPS photos/x.jpg"
echo newfork > "$CF5/x.jpg"; new "$CF5/x.jpg"
ROOT="$R5" DRY_RUN=0 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk "newer fork file kept (not deleted)"     '[ -f "$R5/SKU_dev_Jan-19-140000-2026_Conflict/PPS photos/x.jpg" ]'
chk "target copy untouched"                  '[ "$(cat "$R5/SKU/PPS photos/x.jpg")" = "oldmain" ]'
chk "conflict dir retained (has kept file)"  '[ -d "$R5/SKU_dev_Jan-19-140000-2026_Conflict" ]'

echo
echo "### resolve: empty conflict dir is removed"
R2="$T/r2"; mkdir -p "$R2/S/X" "$R2/S/X_ADMIN_Jul-16-175945-2026_Conflict"
ROOT="$R2" DRY_RUN=0 bash "$S/resolve-drive-conflicts.sh" >/dev/null 2>&1
chk "empty conflict dir removed" '[ ! -d "$R2/S/X_ADMIN_Jul-16-175945-2026_Conflict" ]'
chk "its target survives"        '[ -d "$R2/S/X" ]'

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "### scan-case-collisions.sh"
K="$T/k"; mkdir -p "$K/d"
echo 1 > "$K/d/File_ART.ai"; echo 2 > "$K/d/File_art.ai"; echo 3 > "$K/d/Unique.ai"
out="$(ROOT="$K" bash "$S/scan-case-collisions.sh" 2>&1)"
chk "detects the collision pair"   'echo "$out" | grep -q "1 collision group"'
chk "names both colliding entries" 'echo "$out" | grep -q "File_ART.ai" && echo "$out" | grep -q "File_art.ai"'
chk "does not flag unique names"   '! echo "$out" | grep -q "Unique.ai"'
K2="$T/k2"; mkdir -p "$K2/d"; echo 1 > "$K2/d/only.ai"
out2="$(ROOT="$K2" bash "$S/scan-case-collisions.sh" 2>&1)"
chk "reports clean when no collisions" 'echo "$out2" | grep -q "Clean"'

echo
if [ "$fail" = 0 ]; then echo "===== ALL TESTS PASSED ====="; else echo "===== FAILURES ====="; fi
exit "$fail"
