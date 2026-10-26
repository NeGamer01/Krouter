#!/usr/bin/env bash
# krouter launcher — checks node, picks a free port, starts the server.
# usage: ./start.sh [port]
set -u

PORT="${1:-${KROUTER_PORT:-20128}}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node.js is not installed."
  echo "  install from https://nodejs.org (LTS), then run this script again."
  exit 1
fi

if [ -f "$DIR/server.js" ]; then
  : # ok
else
  echo "server.js not found next to this script — is this the krouter folder?"
  exit 1
fi

# port already listening? don't start a second one
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "port $PORT is already in use. try: ./start.sh 20129"
  exit 1
fi

echo "starting krouter on port $PORT…"
echo "  dashboard:  http://localhost:$PORT/dashboard"
echo "  endpoint:   http://localhost:$PORT/v1"
KROUTER_PORT="$PORT" node "$DIR/server.js"
