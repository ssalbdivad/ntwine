#!/bin/bash
# Boot the adhoc stack + seed a realistic board, printing the url. Used by the steering-latency loop.
#   bash scripts/steer-stack.sh <port> <logfile>
set -e
PORT=${1:-4931}
LOG=${2:-/tmp/steer-stack.log}
PROJ=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJ"
: > "$LOG"
node scripts/adhoc-stack.mjs --port="$PORT" --project="$PROJ" >> "$LOG" 2>&1 &
STACK_PID=$!
echo "$STACK_PID" > "/tmp/steer-stack-$PORT.pid"
for i in $(seq 1 90); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
LINE=$(grep -o '{"url".*}' "$LOG" | tail -1)
HOME_DIR=$(echo "$LINE" | sed 's/.*"home":"\([^"]*\)".*/\1/')
SOCKET=$(echo "$LINE" | sed 's/.*"socket":"\([^"]*\)".*/\1/')
node scripts/seed-steer.mjs "$HOME_DIR" "$SOCKET" "$PROJ" "${3:-25}" >/dev/null
echo "$LINE"
