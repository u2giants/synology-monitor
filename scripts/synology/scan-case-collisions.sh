#!/bin/bash
# READ-ONLY. Find entries that differ only by case within the same parent.
#
# WHY
#   The NAS is case-sensitive (Btrfs); the Mac/Windows clients syncing it are
#   not. Two entries in one folder whose names differ only by case CANNOT both
#   exist on a client. Synology Drive resolves this by renaming one side to
#   *_Conflict and pushing the mess to everyone. Each pair found here is a
#   conflict that has not happened yet.
#
#   This is the root cause of the ~492 conflict artifacts in the "Character
#   Licensed" share and of the botched Dollar General FW2026 merge (2026-07-16).
#
# USAGE
#   ROOT=/volume1/mac bash scan-case-collisions.sh
#
# Run it periodically. Every pair it prints should be consolidated to ONE
# canonical name by a human who knows which is correct — this script never
# writes, because picking the survivor is a judgement call about content.

set -uo pipefail
ROOT="${ROOT:-}"
[ -n "$ROOT" ] || { echo "FATAL: set ROOT=/volume1/..."; exit 1; }
[ -d "$ROOT" ] || { echo "FATAL: not a directory: $ROOT"; exit 1; }

echo "Scanning for case-collisions under: $ROOT"
echo "(entries in the same folder differing only by case)"
echo

find "$ROOT" -not -path '*@eaDir*' -not -name '.DS_Store' \
     -printf '%h\t%f\n' 2>/dev/null |
awk -F'\t' '
{
  parent = $1; name = $2
  key = parent "\t" tolower(name)
  if (key in seen) {
    if (seen[key] != name) {
      if (!(key in reported)) {
        printf "COLLISION in: %s\n", parent
        printf "    %s\n", seen[key]
        reported[key] = 1
        pairs++
      }
      printf "    %s\n", name
      entries++
    }
  } else {
    seen[key] = name
  }
}
END {
  printf "\n===== %d collision group(s), %d extra entrie(s) =====\n", pairs, entries
  if (pairs > 0) {
    print "Each group above will become a Synology Drive *_Conflict artifact on"
    print "the next sync touching it. Consolidate each to ONE canonical name."
  } else {
    print "Clean — no case-collisions found."
  }
}'
