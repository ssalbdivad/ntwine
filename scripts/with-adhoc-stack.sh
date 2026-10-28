#!/bin/bash
# Boot a disposable adhoc stack, run one verify script against it, then tear the stack down.
#
# The stack must not outlive the run: a backgrounded `adhoc-stack.mjs` left idle on this machine gets
# SIGKILLed out from under a later harness, and a half-dead stack fails in ways that read like a bug in
# the code under test. So: one process group, one lifetime, cleanup on any exit path.
#
#   bash scripts/with-adhoc-stack.sh <port> <verify-script.mjs> [extra --flags…]
# The verify script is invoked with --home/--socket/--url filled in from the stack's own json line.
set -uo pipefail
PORT=${1:?usage: with-adhoc-stack.sh <port> <script.mjs> [flags…]}
SCRIPT=${2:?usage: with-adhoc-stack.sh <port> <script.mjs> [flags…]}
shift 2
PROJ=$(cd "$(dirname "$0")/../.." && pwd)
LOG="/tmp/adhoc-stack-$PORT.log"
cd "$PROJ"
: > "$LOG"

node scripts/adhoc-stack.mjs --port="$PORT" --project="$PROJ" >> "$LOG" 2>&1 &
STACK_PID=$!
cleanup() { kill "$STACK_PID" 2>/dev/null; wait "$STACK_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 90); do
  curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
LINE=$(grep -o '{"url".*}' "$LOG" | tail -1)
if [ -z "$LINE" ]; then echo "stack never reported a url; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
HOME_DIR=$(echo "$LINE" | sed 's/.*"home":"\([^"]*\)".*/\1/')
SOCKET=$(echo "$LINE" | sed 's/.*"socket":"\([^"]*\)".*/\1/')
URL=$(echo "$LINE" | sed 's/.*"url":"\([^"]*\)".*/\1/')

node "$SCRIPT" --home="$HOME_DIR" --socket="$SOCKET" --url="$URL" "$@"
STATUS=$?
echo "--- stack log tail ---"
grep -iE "warn|error|watchdog|stale" "$LOG" | tail -15
exit $STATUS
