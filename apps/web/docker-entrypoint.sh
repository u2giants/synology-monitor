#!/bin/sh
set -eu

cd /app/apps/web

echo "[entrypoint] cwd=$(pwd)"
echo "[entrypoint] PORT=${PORT:-3000} NODE_ENV=${NODE_ENV:-unset}"
echo "[entrypoint] .next dir: $(test -d .next && echo present || echo MISSING)"
echo "[entrypoint] next bin: $(test -f /app/node_modules/.bin/next && echo present || echo MISSING)"

if [ "${RUN_ISSUE_WORKER:-false}" = "true" ]; then
  /app/node_modules/.bin/next start -p "${PORT:-3000}" &
  WEB_PID=$!

  node scripts/issue-worker.mjs &
  WORKER_PID=$!

  trap 'kill "$WEB_PID" "$WORKER_PID" 2>/dev/null || true' INT TERM

  # Loop only on web server health — restart worker if it dies independently
  while kill -0 "$WEB_PID" 2>/dev/null; do
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
      echo "[entrypoint] issue-worker exited, restarting..."
      node scripts/issue-worker.mjs &
      WORKER_PID=$!
    fi
    sleep 5
  done

  wait "$WEB_PID" || EXIT_CODE=$?
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  exit "${EXIT_CODE:-1}"
fi

exec /app/node_modules/.bin/next start -p "${PORT:-3000}"
