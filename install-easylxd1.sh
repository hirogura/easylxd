#!/bin/bash
set -euo pipefail

INSTALL_DIR="/opt/easy-lxd"
PORT=3329
REPO_URL="https://github.com/hirogura/easylxd"
GIT_BRANCH="main"

echo "=== Easy LXD UI Installer v1 (GitHub版) ==="
echo ""

# --- curl (GitHubからの取得に必要) ---
if ! command -v curl &>/dev/null; then
  echo "curl をインストールします..."
  apt-get install -y curl
fi

# --- Node.js ---
NODE_PATH=""
if command -v node &>/dev/null; then
  NODE_PATH=$(command -v node)
  echo "Node: $(node -v) ($NODE_PATH)"
else
  for candidate in /usr/local/bin/node /usr/bin/node "$HOME/.nvm/versions/node"/*/bin/node /root/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then NODE_PATH="$candidate"; echo "Node (found): $NODE_PATH"; break; fi
  done
fi
if [ -z "$NODE_PATH" ]; then
  echo "Node.js が見つかりません。インストールします..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
  NODE_PATH=$(command -v node)
fi
if [[ "$NODE_PATH" == *"/.nvm/"* ]]; then
  ln -sf "$NODE_PATH" /usr/local/bin/node
  NODE_PATH=/usr/local/bin/node
fi
[ ! -x "$NODE_PATH" ] && { echo "ERROR: node のインストールに失敗"; exit 1; }

# --- npm ---
if ! command -v npm &>/dev/null; then
  echo "npm が見つかりません。インストールします..."
  apt-get install -y npm
fi
echo "npm: $(npm -v)"

# --- build tools for node-pty ---
if ! dpkg -s build-essential &>/dev/null 2>&1; then
  echo "build-essential をインストール中..."
  apt-get install -y build-essential python3
fi

# --- lxc ---
command -v lxc &>/dev/null || { echo "ERROR: lxc is not installed"; exit 1; }
echo "LXC: $(lxc version 2>/dev/null || lxc --version)"

# --- pciutils ---
if ! command -v lspci &>/dev/null; then
  echo "pciutils をインストールします..."
  apt-get install -y pciutils
fi

# --- tailscale (Serveに必要) ---
command -v tailscale &>/dev/null || { echo "ERROR: tailscale is not installed"; exit 1; }

# --- 既存停止 ---
pgrep -f "node.*easy-lxd/server.js" &>/dev/null && { pkill -f "node.*easy-lxd/server.js" 2>/dev/null; sleep 1; }

# --- ディレクトリ ---
mkdir -p "$INSTALL_DIR"

# --- /opt/lxd-data ディレクトリ作成と権限設定 ---
if [ ! -d "/opt/lxd-data" ]; then
  echo "/opt/lxd-data ディレクトリを作成します..."
  mkdir -p /opt/lxd-data
fi

# raw.idmap "both 1000 1000" はコンテナ内 UID/GID 1000 をシフトせずホストにそのまま通す設定。
# ユーザー名の存在有無に依存せず、数値UID/GIDで直接 chown することで確実に権限を合わせる。
echo "/opt/lxd-data の権限を UID/GID 1000 に設定します..."
chown -R 1000:1000 /opt/lxd-data
chmod -R 775 /opt/lxd-data

# --- GitHub からソースを取得 ---
echo "GitHub からソースを取得中..."
echo "  URL: ${REPO_URL}/archive/refs/heads/${GIT_BRANCH}.tar.gz"
TMP_TAR="$(mktemp)"
curl -fsSL -o "$TMP_TAR" "${REPO_URL}/archive/refs/heads/${GIT_BRANCH}.tar.gz"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_TAR" --strip-components=1 -C "$INSTALL_DIR"
rm -f "$TMP_TAR"
echo "GitHub からの取得が完了しました"

# --- 取得ファイルの確認 ---
for f in server.js package.json public/index.html; do
  if [ ! -f "$INSTALL_DIR/$f" ]; then
    echo "ERROR: $INSTALL_DIR/$f が取得できませんでした。リポジトリの公開状態を確認してください。"
    exit 1
  fi
done
echo "ソースファイルの確認 OK"

# --- npm パッケージ (WebSocket + PTY) ---
echo "npm パッケージをインストール中..."
cd "$INSTALL_DIR"
npm install
echo "npm パッケージ インストール完了"

# --- systemd ---
SERVICE_FILE="/etc/systemd/system/easy-lxd.service"
if [ -w /etc/systemd/system ] 2>/dev/null || [ "$(id -u)" -eq 0 ]; then
  cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=Easy LXD UI
After=network.target lxd.service

[Service]
Type=simple
ExecStart=${NODE_PATH} ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable easy-lxd
  systemctl restart easy-lxd
  echo "Systemd サービスをインストールし起動しました"
else
  echo ""
  echo "NOTE: root 権限がないため systemd サービスを作成できません。"
  echo "手動起動: setsid ${NODE_PATH} ${INSTALL_DIR}/server.js </dev/null > /tmp/easy-lxd.log 2>&1 &"
fi

# --- Tailscale Serve (HTTPS / Tailnet限定で公開、LANには公開しない) ---
echo ""
echo "Tailscale Serve を設定中..."
TAILSCALE_PORT=$PORT
# 冪等性確保のため一旦offにしてから再登録（tailscale serve reset は使わない）
tailscale serve --https="${TAILSCALE_PORT}" off >/dev/null 2>&1 || true
tailscale serve --bg --https="${TAILSCALE_PORT}" "http://127.0.0.1:${PORT}"

TAILSCALE_DOMAIN=""
if command -v jq &>/dev/null; then
  TAILSCALE_DOMAIN=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
else
  TAILSCALE_DOMAIN=$(tailscale status --json | python3 -c "import json,sys;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "")
fi

if [ -n "$TAILSCALE_DOMAIN" ]; then
  echo "Tailscale Serve 設定完了: https://${TAILSCALE_DOMAIN}:${TAILSCALE_PORT}"
else
  echo "WARNING: Tailscale ドメインの取得に失敗しました。'tailscale serve status' で確認してください。"
fi

echo ""
echo "=== インストール完了 ==="
echo "  Node:  ${NODE_PATH} ($(${NODE_PATH} -v))"
if [ -n "$TAILSCALE_DOMAIN" ]; then
  echo "  URL:   https://${TAILSCALE_DOMAIN}:${TAILSCALE_PORT}  (Tailnet内のみ)"
else
  echo "  URL:   tailscale serve status で確認してください"
fi
echo "  Dir:   ${INSTALL_DIR}"
echo ""
