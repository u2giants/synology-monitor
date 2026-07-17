#!/bin/bash
# Shared helpers for the Synology file-server scripts in this directory.
#
# These exist because DSM's userland is thinner and stranger than a normal Linux
# box, and because this NAS serves case-insensitive clients (Mac/Windows) from a
# case-sensitive filesystem (Btrfs). Both facts have already caused incidents —
# see README.md in this directory.
#
# Source this file; do not execute it.

# ── Content comparison ───────────────────────────────────────────────────────
# Pick a comparison method that actually exists. FAIL LOUDLY if none does: a
# script that silently cannot compare content will "resolve" conflicts by
# rewriting or deleting the wrong side.
nas_pick_cmp() {
  if command -v cmp >/dev/null 2>&1; then NAS_CMP=cmp
  elif command -v md5sum >/dev/null 2>&1; then NAS_CMP=md5
  else
    echo "FATAL: neither 'cmp' nor 'md5sum' is available; cannot verify content equality." >&2
    return 1
  fi
  return 0
}

nas_same() { # $1 $2 -> 0 if byte-identical
  if [ "${NAS_CMP:-}" = cmp ]; then
    cmp -s "$1" "$2"
  else
    [ "$(md5sum "$1" 2>/dev/null | cut -d' ' -f1)" = "$(md5sum "$2" 2>/dev/null | cut -d' ' -f1)" ]
  fi
}

# ── Case-insensitive lookup ──────────────────────────────────────────────────
# THE most important helper here. This NAS is case-sensitive; the Mac/Windows
# clients syncing it are not. Creating "PPS Photos" beside an existing
# "PPS photos" makes Synology Drive rename one of them to *_Conflict and pushes
# the mess to every client. Always resolve a name against what already exists.
#
# nas_ci_find <dir> <name> [exclude_path] -> prints first case-insensitive match
nas_ci_find() {
  local dir="$1" want="$2" exclude="${3:-}"
  find "$dir" -maxdepth 1 -iname "$want" ${exclude:+-not -path "$exclude"} -print 2>/dev/null | head -1
}

# nas_resolve_path <root> <relative/path>
# Walks the relative path one component at a time. At each level, if an entry
# already exists differing only by case, REUSE the existing name. Otherwise keep
# the requested name. Returns an absolute path that can never introduce a new
# case-variant of an existing entry.
nas_resolve_path() {
  # NOTE: declare these separately. `local a="$1" b="$a"` does not see $a under
  # `set -u` in the same statement, which silently yielded an empty path here.
  local root="$1"
  local rel="$2"
  local cur="$root"
  local p m
  local oldifs="$IFS"; IFS='/'
  # shellcheck disable=SC2206
  local parts=($rel)
  IFS="$oldifs"
  for p in "${parts[@]}"; do
    [ -z "$p" ] && continue
    m="$(nas_ci_find "$cur" "$p")"
    if [ -n "$m" ]; then cur="$m"; else cur="$cur/$p"; fi
  done
  printf '%s' "$cur"
}

# ── Directory creation ───────────────────────────────────────────────────────
# NEVER use `chmod --reference` / `chown --reference` on DSM. DSM's chmod does
# not support --reference and instead parses "--reference=/path" as a SYMBOLIC
# MODE — the leading "-" means "remove permission bits" — then exits 0. On
# 2026-07-16 this silently turned 66 directories into d--------- while reporting
# success. Read the mode with stat and apply it literally.
#
# nas_mkdir_like <dest_dir> <source_dir_to_mirror>
nas_mkdir_like() {
  local dd="$1" sd="$2" ug m
  [ -d "$dd" ] && return 0
  nas_mkdir_like "$(dirname "$dd")" "$(dirname "$sd")" || return 1
  mkdir "$dd" 2>/dev/null || { [ -d "$dd" ] || return 1; }
  if [ -d "$sd" ]; then
    ug="$(stat -c '%u:%g' "$sd" 2>/dev/null)" && [ -n "$ug" ] && chown "$ug" "$dd" 2>/dev/null
    m="$(stat -c '%a' "$sd" 2>/dev/null)"    && [ -n "$m" ]  && chmod "$m"  "$dd" 2>/dev/null
    touch -r "$sd" "$dd" 2>/dev/null
  fi
  return 0
}

# ── Conflict-name parsing ────────────────────────────────────────────────────
# Synology Drive names conflict copies:
#   <base>_<device>_<Mon-DD-HHMMSS-YYYY>_Conflict[.ext]
#   <base>_<device>_<Mon-DD-HHMMSS-YYYY>_CaseConflict[.ext]
# e.g. HSR57DYLS05_Elizabeths-MacBook-Pro.local_Jan-19-140821-2026_Conflict
#      UP00ADYLS12_MOCKUP_DESKTOP-HKGCSV3_Jan-15-123319-2026_Conflict.psd
#
# Note the second example: the BASE itself contains underscores, so a greedy
# ${name%%_*_Conflict} strip would wrongly yield "UP00ADYLS12" and lose _MOCKUP.
# Anchor on the device+timestamp shape instead.
NAS_CONFLICT_RE='_[^_]+_[A-Za-z]{3}-[0-9]{2}-[0-9]{6}-[0-9]{4}_(Case)?Conflict$'

# nas_conflict_base <name-without-extension> -> the original base, or empty if
# the name is not a conflict artifact.
nas_conflict_base() {
  local s="$1" out
  out="$(printf '%s' "$s" | sed -E "s/${NAS_CONFLICT_RE}//")"
  [ "$out" = "$s" ] && return 1
  printf '%s' "$out"
}

# nas_is_conflict_name <name> -> 0 if it looks like a Drive conflict artifact
nas_is_conflict_name() {
  printf '%s' "${1%.*}" | grep -qE "${NAS_CONFLICT_RE}"
}
