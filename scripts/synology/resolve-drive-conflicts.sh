#!/bin/bash
# Resolve Synology Drive *_Conflict / *_CaseConflict artifacts under a given root.
#
# WHY THIS EXISTS
#   The NAS filesystem is case-sensitive; the Mac/Windows clients syncing it are
#   not. When two names differ only by case, Synology Drive renames one side to
#   <base>_<device>_<date>_Conflict and pushes it to every client. As of
#   2026-07-16 the "Character Licensed" share alone carried ~492 such artifacts
#   accumulated since Aug 2025 (~10-15/month), plus 49 *_CaseConflict files.
#
# POLICY (identical to the one used to repair the Dollar General FW2026 merge)
#   For each conflict artifact, find the entry it collided with (the same name
#   without the conflict suffix, matched case-insensitively) and compare:
#     - identical content              -> DELETE the conflict copy (redundant)
#     - conflict copy OLDER            -> DELETE it (newest-wins)
#     - conflict copy NEWER            -> KEEP and report (needs a human)
#     - no counterpart at all          -> KEEP and report (it is the only copy)
#   For a conflict DIRECTORY, each file inside is resolved the same way, except:
#     - a file with no counterpart in the target is MOVED into the target
#       (it is real content that would otherwise stay stranded and invisible)
#   A conflict directory is removed only once it is empty.
#
# NOTHING IS EVER DELETED UNLESS A SURVIVING COPY IS PROVEN TO EXIST.
#
# USAGE
#   ROOT=/volume1/mac/... DRY_RUN=1 bash resolve-drive-conflicts.sh   # report
#   ROOT=/volume1/mac/... DRY_RUN=0 bash resolve-drive-conflicts.sh   # apply
#
#   Run as root (sudo) so ownership/permissions are preserved. Take a Btrfs
#   snapshot of the SHARE SUBVOLUME first (not the volume root — snapshots do
#   not recurse into nested subvolumes; see README.md).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-nas-safe.sh
. "$HERE/lib-nas-safe.sh"

ROOT="${ROOT:-}"
DRY_RUN="${DRY_RUN:-1}"
[ -n "$ROOT" ] || { echo "FATAL: set ROOT=/volume1/..."; exit 1; }
[ -d "$ROOT" ] || { echo "FATAL: not a directory: $ROOT"; exit 1; }
nas_pick_cmp || exit 1

DEL=0; MOVED=0; KEPT=0; ORPHAN=0; RMD=0; FIXED=0

echo "ROOT:    $ROOT"
echo "DRY_RUN: $DRY_RUN   (1 = report only)"
echo

# ── Pass 0: unreadable dirs ──────────────────────────────────────────────────
# A mode-000 directory hides its own children from find unless we are root, so
# repeat until a pass finds nothing new.
echo "== PASS 0: directories with mode 000 (unreadable to users)"
p=0
while :; do
  p=$((p+1)); n=0
  while IFS= read -r -d '' d; do
    echo "  777: ${d#$ROOT/}"
    [ "$DRY_RUN" = 0 ] && { chmod 777 "$d" 2>/dev/null || echo "    ERR chmod"; }
    FIXED=$((FIXED+1)); n=$((n+1))
  done < <(find "$ROOT" -type d -perm 000 -not -path '*@eaDir*' -print0 2>/dev/null)
  [ "$DRY_RUN" = 0 ] || break
  [ "$n" -eq 0 ] && break
  [ "$p" -ge 20 ] && { echo "  WARN: still finding mode-000 dirs after $p passes"; break; }
done
[ "$FIXED" -eq 0 ] && echo "  (none)"

# ── Pass 1: conflict FILES ───────────────────────────────────────────────────
echo
echo "== PASS 1: conflict FILES"
while IFS= read -r -d '' f; do
  nas_is_conflict_name "$(basename "$f")" || continue
  d="$(dirname "$f")"; nm="$(basename "$f")"
  ext=""; stem="$nm"
  case "$nm" in *.*) ext=".${nm##*.}"; stem="${nm%.*}";; esac
  base="$(nas_conflict_base "$stem")" || { echo "  UNPARSED (leave): ${f#$ROOT/}"; ORPHAN=$((ORPHAN+1)); continue; }
  m="$(nas_ci_find "$d" "$base$ext" "$f")"
  if [ -z "$m" ]; then
    echo "  ONLY COPY (leave): ${f#$ROOT/}"; ORPHAN=$((ORPHAN+1)); continue
  fi
  if nas_same "$f" "$m"; then
    echo "  DEL identical -> keeps $(basename "$m"): ${f#$ROOT/}"
    [ "$DRY_RUN" = 0 ] && rm -f "$f"; DEL=$((DEL+1))
  elif [ "$(stat -c %Y "$f")" -gt "$(stat -c %Y "$m")" ]; then
    echo "  KEEP conflict-is-NEWER -> REVIEW: ${f#$ROOT/}"; KEPT=$((KEPT+1))
  else
    echo "  DEL stale-older -> keeps $(basename "$m"): ${f#$ROOT/}"
    [ "$DRY_RUN" = 0 ] && rm -f "$f"; DEL=$((DEL+1))
  fi
done < <(find "$ROOT" -type f -name '*Conflict*' -not -path '*@eaDir*' -print0 2>/dev/null)

# ── Pass 2: conflict DIRECTORIES ─────────────────────────────────────────────
echo
echo "== PASS 2: conflict DIRECTORIES"
while IFS= read -r -d '' c; do
  nas_is_conflict_name "$(basename "$c")" || continue
  par="$(dirname "$c")"; nm="$(basename "$c")"
  base="$(nas_conflict_base "$nm")" || { echo "  UNPARSED (leave): ${c#$ROOT/}"; ORPHAN=$((ORPHAN+1)); continue; }
  t="$(nas_ci_find "$par" "$base" "$c")"
  if [ -z "$t" ] || [ ! -d "$t" ]; then
    echo "  NO TARGET (leave): ${c#$ROOT/}"; ORPHAN=$((ORPHAN+1)); continue
  fi
  echo "  ${c#$ROOT/}  ->  $(basename "$t")/"
  while IFS= read -r -d '' f; do
    b="$(basename "$f")"; m="$(nas_ci_find "$t" "$b")"
    if [ -z "$m" ]; then
      echo "      MOVE (stranded content): $b"
      [ "$DRY_RUN" = 0 ] && { mv -n "$f" "$t/$b" 2>/dev/null || echo "        ERR mv"; }
      MOVED=$((MOVED+1))
    elif nas_same "$f" "$m"; then
      echo "      DEL identical: $b"; [ "$DRY_RUN" = 0 ] && rm -f "$f"; DEL=$((DEL+1))
    elif [ "$(stat -c %Y "$f")" -gt "$(stat -c %Y "$m")" ]; then
      echo "      KEEP conflict-is-NEWER -> REVIEW: $b"; KEPT=$((KEPT+1))
    else
      echo "      DEL stale-older: $b"; [ "$DRY_RUN" = 0 ] && rm -f "$f"; DEL=$((DEL+1))
    fi
  done < <(find "$c" -maxdepth 1 -type f -not -name '.DS_Store' -print0 2>/dev/null)

  if [ "$DRY_RUN" = 0 ]; then
    rm -f "$c/.DS_Store" 2>/dev/null
    [ -d "$c/@eaDir" ] && rm -rf "$c/@eaDir" 2>/dev/null
    rmdir "$c" 2>/dev/null && { echo "      removed empty conflict dir"; RMD=$((RMD+1)); }
  fi
done < <(find "$ROOT" -depth -type d -name '*Conflict*' -not -path '*@eaDir*' -print0 2>/dev/null)

echo
echo "===== SUMMARY (DRY_RUN=$DRY_RUN) ====="
echo "  mode-000 dirs fixed:        $FIXED"
echo "  deleted (dupe or stale):    $DEL"
echo "  moved out of conflict dirs: $MOVED"
echo "  KEPT for review:            $KEPT"
echo "  orphan / no counterpart:    $ORPHAN"
echo "  conflict dirs removed:      $RMD"
[ "$DRY_RUN" != 0 ] && echo && echo "Nothing was changed. Re-run with DRY_RUN=0 to apply."
exit 0
