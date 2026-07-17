#!/bin/bash
# Merge one folder into another on the NAS, safely.
#
# ORIGIN
#   Written 2026-07-16 to merge
#     "Dollar General Fall Winter 2026.wrong"  ->  "Dollar General Fall Winter 2026"
#   under /volume1/mac/Decor/Character Licensed/____New Structure/In Development/
#   Customer Adopted/Dollar General/. The first version shipped two bugs that
#   reached live data; both are fixed here and covered by tests/. Read README.md
#   before reusing this.
#
# POLICY
#   - Copy a file only if the destination does not already have it.
#   - If the destination has it: skip when the content is identical; otherwise
#     newest-wins (never copy an older file over a newer one).
#   - Case-insensitive throughout (see BUG 1 below).
#   - Timestamps preserved; @eaDir and .DS_Store ignored.
#
# BUG 1 (fixed) — CASE COLLISIONS
#   The original compared paths case-sensitively. The NAS is case-sensitive but
#   the Mac/Windows clients syncing it are not, and the tree contains both
#   "PPS photos" and "PPS Photos", "_packaging.ai" and "_PACKAGING.ai". 39 files
#   that already existed under a different case were copied anyway; Synology
#   Drive then produced 63 *_Conflict artifacts. Fixed by resolving every path
#   component against what already exists (nas_resolve_path).
#
# BUG 2 (fixed) — chmod --reference
#   The original mirrored directory permissions with `chmod --reference`. DSM's
#   chmod does not support it and instead reads "--reference=/path" as a
#   symbolic mode whose leading "-" REMOVES bits, then exits 0. 66 directories
#   became d--------- while the script reported success. Fixed by reading the
#   mode with stat and applying it literally (nas_mkdir_like).
#
# OPTIONS
#   SRC, DST                required, absolute paths
#   DRY_RUN=1               default; 1 = report only, 0 = apply
#   FLATTEN=0|1             default 0. When 1, a top-level directory in SRC whose
#                           name contains a space is treated as a category
#                           grouping and stripped from the destination path, so
#                           SRC/"WALL CLOCK"/MWB10DYLS01/x.ai lands at
#                           DST/MWB10DYLS01/x.ai. Names in FLATTEN_KEEP are not
#                           stripped.
#   FLATTEN_KEEP="_Working Files"
#                           colon-separated top-level names FLATTEN must not strip.
#   REANCHOR=0|1            default 0. When 1 and the destination has no top-level
#                           entry for a flattened first component, but exactly one
#                           spaced top-level directory in DST contains it, land the
#                           files there instead. (This is what keeps NUN4V* merging
#                           into DST/"Nonwoven Collapsible Toy Chest"/NUN4V* rather
#                           than creating a stray flat folder.)
#
# USAGE
#   SRC=... DST=... FLATTEN=1 REANCHOR=1 DRY_RUN=1 sudo -E bash merge-folders.sh
#   Run as root so cp -p preserves ownership. Snapshot the SHARE SUBVOLUME first.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-nas-safe.sh
. "$HERE/lib-nas-safe.sh"

SRC="${SRC:-}"; DST="${DST:-}"
DRY_RUN="${DRY_RUN:-1}"
FLATTEN="${FLATTEN:-0}"
FLATTEN_KEEP="${FLATTEN_KEEP:-_Working Files}"
REANCHOR="${REANCHOR:-0}"

[ -n "$SRC" ] && [ -n "$DST" ] || { echo "FATAL: set SRC= and DST="; exit 1; }
[ -d "$SRC" ] || { echo "FATAL: no such SRC: $SRC"; exit 1; }
[ -d "$DST" ] || { echo "FATAL: no such DST: $DST"; exit 1; }
nas_pick_cmp || exit 1

copied=0; overwritten=0; skip_same=0; skip_older=0; errors=0

keep_toplevel() { # $1 = name -> 0 if it must NOT be flattened
  local oldifs="$IFS" k; IFS=':'
  # shellcheck disable=SC2206
  local keeps=($FLATTEN_KEEP); IFS="$oldifs"
  for k in "${keeps[@]}"; do [ "$1" = "$k" ] && return 0; done
  return 1
}

# If DST has no top-level entry for $1, but exactly one spaced top-level dir in
# DST contains it, return that dir's name. Otherwise return empty.
reanchor_prefix() {
  local sku="$1" hits=0 found="" d
  [ -n "$(nas_ci_find "$DST" "$sku")" ] && return 0   # already at top level
  while IFS= read -r -d '' d; do
    case "$(basename "$d")" in *" "*) ;; *) continue;; esac
    if [ -n "$(nas_ci_find "$d" "$sku")" ]; then hits=$((hits+1)); found="$(basename "$d")"; fi
  done < <(find "$DST" -mindepth 1 -maxdepth 1 -type d -not -name '@eaDir' -print0 2>/dev/null)
  [ "$hits" -eq 1 ] && printf '%s' "$found"
  return 0
}

echo "SRC: $SRC"
echo "DST: $DST"
echo "DRY_RUN=$DRY_RUN FLATTEN=$FLATTEN REANCHOR=$REANCHOR"
echo

while IFS= read -r -d '' src; do
  rel="${src#"$SRC"/}"

  # Optional category flattening.
  norm="$rel"
  if [ "$FLATTEN" = 1 ]; then
    first="${rel%%/*}"
    if [ "$rel" != "$first" ] && [ "$first" != "${first// /}" ] && ! keep_toplevel "$first"; then
      norm="${rel#*/}"
    fi
  fi

  # Optional re-anchor of the leading component.
  target="$norm"
  if [ "$REANCHOR" = 1 ]; then
    sku="${norm%%/*}"
    if [ "$norm" != "$sku" ] && ! keep_toplevel "$sku"; then
      pfx="$(reanchor_prefix "$sku")"
      [ -n "$pfx" ] && target="$pfx/$norm"
    fi
  fi

  # Resolve against existing names, case-insensitively. This is the fix for BUG 1.
  dest="$(nas_resolve_path "$DST" "$target")"

  if [ ! -e "$dest" ]; then
    echo "COPY (new): ${dest#"$DST"/}"
    if [ "$DRY_RUN" = 0 ]; then
      nas_mkdir_like "$(dirname "$dest")" "$(dirname "$src")" || { echo "  ERROR mkdir"; errors=$((errors+1)); continue; }
      cp -p "$src" "$dest" || { echo "  ERROR copy"; errors=$((errors+1)); continue; }
    fi
    copied=$((copied+1)); continue
  fi

  ss=$(stat -c %s "$src"  2>/dev/null) || { errors=$((errors+1)); continue; }
  sd=$(stat -c %s "$dest" 2>/dev/null) || { errors=$((errors+1)); continue; }
  if [ "$ss" = "$sd" ] && nas_same "$src" "$dest"; then
    skip_same=$((skip_same+1)); continue
  fi

  ts=$(stat -c %Y "$src" 2>/dev/null); td=$(stat -c %Y "$dest" 2>/dev/null)
  if [ "$ts" -gt "$td" ]; then
    echo "OVERWRITE (differs, src newer): ${dest#"$DST"/}"
    if [ "$DRY_RUN" = 0 ]; then cp -p "$src" "$dest" || { echo "  ERROR copy"; errors=$((errors+1)); continue; }; fi
    overwritten=$((overwritten+1))
  else
    skip_older=$((skip_older+1))
  fi
done < <(find "$SRC" -type f -not -path '*/@eaDir/*' -not -name '.DS_Store' -print0 2>/dev/null)

echo
echo "===== SUMMARY (DRY_RUN=$DRY_RUN) ====="
echo "  new files copied:            $copied"
echo "  overwritten (differs+newer): $overwritten"
echo "  skipped (identical content): $skip_same"
echo "  skipped (dest newer):        $skip_older"
echo "  errors:                      $errors"
[ "$DRY_RUN" != 0 ] && echo && echo "Nothing was written. Re-run with DRY_RUN=0 to apply."
exit 0
