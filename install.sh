#!/usr/bin/env bash
# krouter installer — symlink CLI into PATH + optional systemd service.
# usage: ./install.sh [--systemd]   (run as your user; use sudo only for systemd)
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${PREFIX:-/usr/local/bin}"
NAME="krouter"

if ! command -v node >/dev/null 2>&1; then
  echo "node.js is not installed. install from https://nodejs.org first."
  exit 1
fi

# 1) symlink the CLI
mkdir -p "$PREFIX" 2>/dev/null || true
if ln -sf "$DIR/cli.js" "$PREFIX/$NAME" 2>/dev/null; then
  echo "✓ installed: $PREFIX/$NAME -> $DIR/cli.js"
else
  echo "! could not write $PREFIX (need sudo?). trying ~/.local/bin"
  PREFIX="$HOME/.local/bin"
  mkdir -p "$PREFIX"
  ln -sf "$DIR/cli.js" "$PREFIX/$NAME"
  echo "✓ installed: $PREFIX/$NAME -> $DIR/cli.js"
  echo "  make sure $PREFIX is on your PATH"
fi
chmod +x "$DIR/cli.js" "$DIR/server.js" 2>/dev/null

# 2) register CLI's default server url
"$PREFIX/$NAME" config set --url "http://127.0.0.1:${KROUTER_PORT:-20128}" >/dev/null 2>&1 || true

echo ""
echo "quickstart:"
echo "  krouter start              # start the server"
echo "  krouter status             # health + providers"
echo "  krouter provider add --name X --alias x --base https://api.x.com/v1 --keys k1,k2"
echo "  krouter tunnel start       # public url via cloudflare (auto-downloads cloudflared)"

# 3) optional systemd service
if [ "${1:-}" = "--systemd" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "! --systemd needs root: sudo ./install.sh --systemd"
    exit 1
  fi
  SVC=/etc/systemd/system/krouter.service
  cat > "$SVC" <<EOF
[Unit]
Description=krouter LLM gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now krouter
  echo "✓ systemd service installed and started: systemctl status krouter"
fi
