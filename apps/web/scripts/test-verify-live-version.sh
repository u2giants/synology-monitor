#!/usr/bin/env bash
# Prove the live-version check behaves: a matching version passes and a
# deliberately stale expected sha fails. Fixture files only — no network, so
# this cannot go red for a reason outside the check itself.
set -euo pipefail

cd "$(dirname "$0")"

FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

LIVE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
STALE_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SHORT_LIVE="${LIVE_SHA:0:7}"
STALE_SHORT="ccccccc"

printf '{"git_sha":"%s","commit":"%s","date":"2026-01-01T00:00:00Z"}\n' \
  "$LIVE_SHA" "$SHORT_LIVE" >"$FIXTURE_DIR/version.json"
printf '{"commit":"%s"}\n' "$SHORT_LIVE" >"$FIXTURE_DIR/no-git-sha.json"

# file:// URL that works with both msys and native curl.
to_file_url() {
  p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -m "$p")"
  fi
  case "$p" in
    /*) printf 'file://%s' "$p" ;;
    *) printf 'file:///%s' "$p" ;;
  esac
}

VERSION_URL="$(to_file_url "$FIXTURE_DIR/version.json")"
NO_SHA_URL="$(to_file_url "$FIXTURE_DIR/no-git-sha.json")"

failures=0

check() {
  name="$1"
  want_exit="$2"
  want_text="$3"
  shift 3
  out="$("$@" 2>&1)" && got_exit=0 || got_exit=$?
  if [ "$got_exit" -ne "$want_exit" ]; then
    echo "not ok - ${name}: expected exit ${want_exit}, got ${got_exit}"
    printf '%s\n' "$out" | sed 's/^/  /'
    failures=$((failures + 1))
    return
  fi
  if ! printf '%s\n' "$out" | grep -qF "$want_text"; then
    echo "not ok - ${name}: output missing '${want_text}'"
    printf '%s\n' "$out" | sed 's/^/  /'
    failures=$((failures + 1))
    return
  fi
  echo "ok - ${name}"
  printf '%s\n' "$out" | sed 's/^/  /'
}

# 1. Matching full sha passes and reports the live read against the commit.
check "matching version passes" 0 "live version matches merged commit ${LIVE_SHA}" \
  bash verify-live-version.sh --url "$VERSION_URL" --expected "$LIVE_SHA" --attempts 1

# 2. Deliberately stale expected sha fails and names both values.
check "deliberately stale check fails" 1 "LIVE VERSION MISMATCH" \
  bash verify-live-version.sh --url "$VERSION_URL" --expected "$STALE_SHA" --attempts 1

# 3. A short expected sha that is a prefix of the live sha matches.
check "short expected sha prefix matches" 0 "live version matches merged commit ${SHORT_LIVE}" \
  bash verify-live-version.sh --url "$VERSION_URL" --expected "$SHORT_LIVE" --attempts 1

# 4. A stale short sha fails the same way.
check "stale short sha fails" 1 "LIVE VERSION MISMATCH" \
  bash verify-live-version.sh --url "$VERSION_URL" --expected "$STALE_SHORT" --attempts 1

# 5. An unreadable version document fails instead of passing quietly.
check "missing git_sha fails" 1 "LIVE VERSION MISMATCH" \
  bash verify-live-version.sh --url "$NO_SHA_URL" --expected "$LIVE_SHA" --attempts 1

# 6. An unreachable URL fails instead of passing quietly.
check "unreachable url fails" 1 "LIVE VERSION MISMATCH" \
  bash verify-live-version.sh --url "$(to_file_url "$FIXTURE_DIR/absent.json")" --expected "$LIVE_SHA" --attempts 1

if [ "$failures" -gt 0 ]; then
  echo "FAILED: ${failures} live-version check(s) did not behave as required" >&2
  exit 1
fi
echo "All live-version check behaviors proven."
