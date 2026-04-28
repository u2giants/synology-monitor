#!/bin/sh
set -eu

SERVER=/app/apps/web/server.js

echo "[entrypoint] PORT=${PORT:-3000} NODE_ENV=${NODE_ENV:-unset}"
echo "[entrypoint] server.js: $(test -f "$SERVER" && echo present || echo MISSING)"

if [ "${RUN_ISSUE_WORKER:-false}" = "true" ]; then
  node "$SERVER" &
  WEB_PID=$!

  node /app/apps/web/scripts/issue-worker.mjs &
  WORKER_PID=$!

  trap 'kill "$WEB_PID" "$WORKER_PID" 2>/dev/null || true' INT TERM

  while kill -0 "$WEB_PID" 2>/dev/null; do
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
      echo "[entrypoint] issue-worker exited, restarting..."
      node /app/apps/web/scripts/issue-worker.mjs &
      WORKER_PID=$!
    fi
    sleep 5
  done

  wait "$WEB_PID" || EXIT_CODE=$?
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  exit "${EXIT_CODE:-1}"
fi

exec node "$SERVER"
