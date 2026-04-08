#!/bin/sh
set -eu

cd /app/apps/web

if [ "${RUN_ISSUE_WORKER:-false}" = "true" ]; then
  npx next start -p "${PORT:-3000}" &
  WEB_PID=$!

  node scripts/issue-worker.mjs &
  WORKER_PID=$!

  trap 'kill "$WEB_PID" "$WORKER_PID" 2>/dev/null || true' INT TERM

  while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$WORKER_PID" 2>/dev/null; do
    sleep 2
  done

  EXIT_CODE=1
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    wait "$WEB_PID" || EXIT_CODE=$?
  elif ! kill -0 "$WORKER_PID" 2>/dev/null; then
    wait "$WORKER_PID" || EXIT_CODE=$?
  fi

  kill "$WEB_PID" "$WORKER_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  exit "$EXIT_CODE"
fi

exec npx next start -p "${PORT:-3000}"
