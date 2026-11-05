#!/usr/bin/env bash
# Read the running version from the live site and compare it with the merged
# commit. The deploy workflow runs this after Coolify deploys; a mismatch fails
# the run and names both values. The known version path serves
# {"git_sha":"<sha>"} (baked into the image as /usr/share/nginx/html/version.json).
#
# Usage:
#   verify-live-version.sh --url https://pm.designflow.app/version.json \
#       --expected "$GITHUB_SHA" [--mode json] [--attempts 60] [--interval 10]
#
# Exit 0 when the live version matches --expected (exact, or a prefix of at
# least 7 characters on either side). Exit 1 on mismatch or unreachable URL.
set -euo pipefail

url=""
expected=""
mode="json"
attempts=60
interval=10

while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --expected) expected="${2:?--expected needs a value}"; shift 2 ;;
    --mode) mode="${2:?--mode needs a value}"; shift 2 ;;
    --attempts) attempts="${2:?--attempts needs a value}"; shift 2 ;;
    --interval) interval="${2:?--interval needs a value}"; shift 2 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$url" ] || [ -z "$expected" ]; then
  echo "usage: verify-live-version.sh --url <version-url> --expected <sha> [--mode json] [--attempts N] [--interval S]" >&2
  exit 2
fi

if [ "$mode" != "json" ]; then
  echo "unsupported --mode '$mode' (only 'json' is supported)" >&2
  exit 2
fi

# Match on exact equality, or when one side is a prefix of the other and at
# least 7 characters (builds that bake a short commit hash).
sha_matches() {
  live="$1"
  want="$2"
  [ -n "$live" ] || return 1
  if [ "$live" = "$want" ]; then
    return 0
  fi
  case "$want" in
    "$live"*) [ "${#live}" -ge 7 ] && return 0 ;;
  esac
  case "$live" in
    "$want"*) [ "${#want}" -ge 7 ] && return 0 ;;
  esac
  return 1
}

extract_git_sha() {
  sed -n 's/.*"git_sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

fetch_body() {
  # Cache-bust only real HTTP(S) URLs; file:// fixtures are read as-is.
  case "$1" in
    http://* | https://*)
      curl -fsSL --max-time 15 -H 'Cache-Control: no-cache' "${1}?_v=${expected}-${2}" 2>/dev/null || true
      ;;
    *)
      curl -fsSL --max-time 15 "$1" 2>/dev/null || true
      ;;
  esac
}

live=""
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  body="$(fetch_body "$url" "$attempt")"
  live="$(printf '%s' "$body" | extract_git_sha)"
  if [ -n "$live" ] && sha_matches "$live" "$expected"; then
    echo "live version read: ${live} (from ${url})"
    echo "expected merged commit: ${expected}"
    echo "live version matches merged commit ${expected}"
    exit 0
  fi
  if [ -n "$live" ]; then
    echo "waiting for ${url} to serve ${expected}; live version read: ${live} (${attempt}/${attempts})"
  else
    echo "waiting for ${url} to expose a readable git_sha (${attempt}/${attempts})"
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$interval"
  fi
  attempt=$((attempt + 1))
done

echo "live version read: ${live:-<none>} (from ${url})" >&2
echo "expected merged commit: ${expected}" >&2
echo "LIVE VERSION MISMATCH: production is not serving the merged commit ${expected}" >&2
exit 1
