#!/usr/bin/env bash
# One-shot deployment script for mr-mcp-server onto an LXC that already has multi-runners.
#
# Usage (on the LXC):
#   curl -sSL https://raw.githubusercontent.com/DaisukeHori/mr-mcp-server/main/deploy-lxc.sh | bash
#
# Or:
#   git clone https://github.com/DaisukeHori/mr-mcp-server.git /opt/mr-mcp-server
#   cd /opt/mr-mcp-server && bash deploy-lxc.sh

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/DaisukeHori/mr-mcp-server.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mr-mcp-server}"
SERVICE_NAME="${SERVICE_NAME:-mr-mcp-server}"
PORT="${PORT:-4000}"
DEFAULT_OWNER="${DEFAULT_OWNER:-DaisukeHori}"

echo "=== mr-mcp-server deploy ==="
echo "INSTALL_DIR=$INSTALL_DIR"
echo "PORT=$PORT"
echo "DEFAULT_OWNER=$DEFAULT_OWNER"

# 1. Node.js 20+
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  echo "[1/6] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1/6] Node.js $(node -v) already installed"
fi

# 2. Clone or pull
if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "[2/6] git clone $REPO_URL → $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  echo "[2/6] git pull in $INSTALL_DIR"
  cd "$INSTALL_DIR" && git pull
fi

# 3. npm install + build
cd "$INSTALL_DIR"
echo "[3/6] npm install..."
npm install --silent
echo "[4/6] tsc build..."
npx tsc

# 5. Generate ADMIN_KEY if .env not present
if [ ! -f "$INSTALL_DIR/.env" ]; then
  ADMIN_KEY="mrmcp-$(openssl rand -hex 24)"
  WEBHOOK_SECRET="whsec-$(openssl rand -hex 24)"
  cat > "$INSTALL_DIR/.env" <<ENV_EOF
PORT=$PORT
ADMIN_KEY=$ADMIN_KEY
WEBHOOK_SECRET=$WEBHOOK_SECRET
MR_DIR=/opt/multi-runners
DEFAULT_OWNER=$DEFAULT_OWNER
ENV_EOF
  chmod 600 "$INSTALL_DIR/.env"
  echo "[5/6] Generated .env with ADMIN_KEY=$ADMIN_KEY"
  echo "      (save this key — it won't be shown again)"
else
  echo "[5/6] .env already exists, keeping existing credentials"
fi

# 6. systemd service
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<'SVC_EOF'
[Unit]
Description=mr-mcp-server (MCP server for multi-runners)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mr-mcp-server
EnvironmentFile=/opt/mr-mcp-server/.env
ExecStart=/usr/bin/node /opt/mr-mcp-server/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVC_EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
sleep 2

echo "[6/6] systemd service status:"
systemctl status "$SERVICE_NAME" --no-pager -n 10 || true

echo
echo "=== Done ==="
echo "Local health: curl http://localhost:$PORT/health"
echo "Logs:         journalctl -u $SERVICE_NAME -f"
