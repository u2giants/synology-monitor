#!/bin/sh
# Deliberately no set -eu so the container stays alive on any failure

SERVER=/app/apps/web/server.js

echo "[entrypoint] === startup diagnostics ==="
echo "[entrypoint] PORT=${PORT:-3000} NODE_ENV=${NODE_ENV:-unset}"
echo "[entrypoint] server.js: $(test -f "$SERVER" && echo PRESENT || echo *** MISSING ***)"
echo "[entrypoint] /app/apps/web contents:"
ls /app/apps/web/ 2>&1 || echo "(ls failed)"
echo "[entrypoint] node version: $(node --version 2>&1)"
echo "[entrypoint] ==========================="

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

  wait "$WEB_PID"
  EXIT_CODE=$?
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  echo "[entrypoint] *** web server exited with code $EXIT_CODE ***"
  echo "[entrypoint] sleeping 1h so you can read logs in Coolify — then redeploy to restart"
  sleep 3600
  exit "$EXIT_CODE"
fi

node "$SERVER"
EXIT_CODE=$?
echo "[entrypoint] *** node server.js exited with code $EXIT_CODE ***"
echo "[entrypoint] sleeping 1h so you can read logs in Coolify — then redeploy to restart"
sleep 3600
exit "$EXIT_CODE"
