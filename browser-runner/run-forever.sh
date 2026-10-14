#!/bin/bash
# Keeps the runner alive: restarts it whenever it exits (crash, watchdog, job hang).
cd "$(dirname "$0")"
while true; do
  echo "[supervisor] starting runner $(date -u +%FT%TZ)"
  node src/server.js
  echo "[supervisor] runner exited ($?), restarting in 3s"
  sleep 3
done
