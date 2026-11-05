#!/bin/sh
set -eu
cd /app/apps/web

if [ "${RUN_ISSUE_WORKER:-false}" != "true" ] && [ "${RUN_SEARCH_EMBEDDING_WATCHDOG:-false}" != "true" ]; then
  exec npx next start -p "${PORT:-3000}"
fi

npx next start -p "${PORT:-3000}" &
WEB_PID=$!
WORKER_PIDS=""
if [ "${RUN_ISSUE_WORKER:-false}" = "true" ]; then
  node scripts/issue-worker.mjs &
  WORKER_PIDS="$WORKER_PIDS $!"
fi
if [ "${RUN_SEARCH_EMBEDDING_WATCHDOG:-false}" = "true" ]; then
  node scripts/search-embedding-watchdog-worker.mjs &
  WORKER_PIDS="$WORKER_PIDS $!"
fi
trap 'kill "$WEB_PID" $WORKER_PIDS 2>/dev/null || true' EXIT INT TERM

while kill -0 "$WEB_PID" 2>/dev/null; do
  for worker_pid in $WORKER_PIDS; do
    if ! kill -0 "$worker_pid" 2>/dev/null; then
      # Container restart policy recovers a dead background capability.
      exit 1
    fi
  done
  sleep 2
done
EXIT_CODE=0
wait "$WEB_PID" || EXIT_CODE=$?
exit "$EXIT_CODE"
