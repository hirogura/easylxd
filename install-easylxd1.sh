#!/bin/bash
# ============================================================
# Easy LXD UI Installer (Ubuntu / CachyOS・Arch Linux 対応)
#
# /etc/os-release の ID / ID_LIKE で OS を判別し、パッケージ導入方法を
# 切り替える。
#   - Arch 系 (CachyOS 等): pacman で依存パッケージ (curl git nodejs npm
#     base-devel python3 pciutils usbutils jq tailscale lxd dkms
#     btrfs-progs) とカーネルヘッダを導入。LXD は pacman 版 (snap 不使用)
#     のため lxd.socket / lxd.service 前提の systemd ユニットを生成する。
#   - Ubuntu / Debian 系: apt-get で curl / Node.js (nodesource) /
#     build-essential / pciutils を導入 (従来どおり)。LXD は snap 前提。
# 共通:
#   - Btrfs 環境では /opt/lxd-pool・/opt/lxd-data を事前に独立サブボリューム
#     として作成 (snapper のシステムスナップショットから除外するため。
#     非Btrfs 環境や空でない既存ディレクトリでは通常ディレクトリのまま)。
#   - tarball の正当性検証、node-pty のビルド確認を行う。
# ============================================================
set -euo pipefail

INSTALL_DIR="/opt/easy-lxd"
PORT=3329
REPO_URL="https://github.com/hirogura/easylxd"
GIT_BRANCH="main"

echo "=== Easy LXD UI Installer (GitHub版) ==="
echo ""

# ------------------------------------------------------------
# OS 判別 (/etc/os-release の ID / ID_LIKE で判定)
# ------------------------------------------------------------
IS_ARCH=false
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "OS: ${PRETTY_NAME:-$ID}"
  case "${ID_LIKE:-} ${ID:-}" in
    *arch*)
      IS_ARCH=true
      echo "Arch 系として検出しました。pacman で導入します。"
      ;;
    *)
      echo "Debian/Ubuntu 系として検出しました。apt-get で導入します。"
      ;;
  esac
fi

# --- LXD ---
# LXD のインストール・初期化はソース取得後に lxd-setup.sh で必ず実施する。
# (Ubuntu Server は lxd snap がプリインストールされているため未初期化のまま
#  見逃され、「No root disk device found」エラーの原因になっていた)
# snap 版 lxc が /snap/bin にある環境向けに PATH を通す (存在しない環境では無害)。
if [ -d /snap/bin ]; then
  export PATH="/snap/bin:$PATH"
fi

if [ "$IS_ARCH" = true ]; then
  # ------------------------------------------------------------
  # Arch 系 (CachyOS 等): pacman で依存パッケージを一括導入
  # ------------------------------------------------------------
  command -v pacman &>/dev/null || { echo "ERROR: pacman が見つかりません。CachyOS/Arch 系でのみ動作します。"; exit 1; }
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: root 権限が必要です。sudo で実行してください。"
    exit 1
  fi
  # lxd 本体 / Node.js / ビルドツール / GPU・チューナー検出用 / Tailscale を一括導入。
  echo "依存パッケージを確認・インストール中 (pacman)..."
  pacman -Sy --needed --noconfirm \
    curl git nodejs npm base-devel python3 \
    pciutils usbutils jq procps-ng \
    tailscale lxd dkms btrfs-progs \
    || { echo "ERROR: pacman での依存パッケージ導入に失敗しました"; exit 1; }

  # カーネルヘッダ (px4_drv の DKMS ビルド時に必要。無くても本体動作には支障なし)
  KVER="$(uname -r)"
  if [[ "$KVER" == *cachyos* ]]; then
    pacman -Sy --needed --noconfirm linux-cachyos-headers \
      || echo "WARNING: linux-cachyos-headers を導入できませんでした (px4_drv の DKMS 時に手動導入してください)"
  else
    pacman -Sy --needed --noconfirm linux-headers \
      || echo "WARNING: linux-headers を導入できませんでした (px4_drv の DKMS 時に手動導入してください)"
  fi

  # --- Node.js / npm ---
  command -v node &>/dev/null || { echo "ERROR: node が見つかりません (pacman の nodejs を確認してください)"; exit 1; }
  command -v npm &>/dev/null || { echo "ERROR: npm が見つかりません (pacman の npm を確認してください)"; exit 1; }
  NODE_PATH="$(command -v node)"
  echo "Node: $(node -v) ($NODE_PATH)"
  echo "npm: $(npm -v)"
else
  # ------------------------------------------------------------
  # Ubuntu / Debian 系: apt-get で導入 (従来どおり)
  # ------------------------------------------------------------
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

  # --- pciutils ---
  if ! command -v lspci &>/dev/null; then
    echo "pciutils をインストールします..."
    apt-get install -y pciutils
  fi
fi

# --- tailscale (Serveに必要) ---
command -v tailscale &>/dev/null || { echo "ERROR: tailscale is not installed"; exit 1; }
if ! tailscale status &>/dev/null; then
  echo "WARNING: tailscale にログインしていません。'tailscale up' でログインしてから Serve 設定を確認してください。"
fi

# --- 既存停止 ---
if pgrep -f "node.*easy-lxd/server.js" &>/dev/null; then
  echo "既存の Easy LXD を停止します..."
  pkill -f "node.*easy-lxd/server.js" 2>/dev/null || true
  sleep 1
fi

# --- ディレクトリ ---
mkdir -p "$INSTALL_DIR"

# --- /opt/lxd-pool・/opt/lxd-data をBtrfsサブボリュームとして事前作成 ---
# CachyOS既定では /opt は @ サブボリューム内のため、独立サブボリューム化して
# snapperのシステムスナップショットからコンテナ実体・共有データを除外する。
# (fstab追記不要。非Btrfs環境では通常ディレクトリになる。lxd-setup.sh側でも
#  同じ保証を行うため二重化しても安全。空でない既存ディレクトリは保護のため維持。)
ensure_btrfs_subvolume() {
  local dir="$1"
  command -v btrfs &>/dev/null || { mkdir -p "$dir"; return 0; }
  local parent
  parent="$(dirname "$dir")"
  [ -d "$parent" ] || mkdir -p "$parent"
  if [ "$(stat -f -c %T "$parent" 2>/dev/null)" != "btrfs" ]; then
    mkdir -p "$dir"
    return 0
  fi
  if [ -d "$dir" ] || [ -e "$dir" ]; then
    if btrfs subvolume show "$dir" &>/dev/null; then
      echo "[SKIP] $dir は既に Btrfs サブボリュームです"
      return 0
    fi
    if [ -d "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
      echo "空ディレクトリ $dir をサブボリュームに置き換えます..."
      rmdir "$dir"
    else
      echo "[WARN] $dir は空でないためサブボリューム化をスキップします"
      return 0
    fi
  fi
  echo "Btrfs サブボリューム $dir を作成します..."
  btrfs subvolume create "$dir"
}
ensure_btrfs_subvolume "/opt/lxd-pool" || true
ensure_btrfs_subvolume "/opt/lxd-data" || true

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
# 展開前に正規のアプリ内容か検証する
# (リポジトリ未push時などの不完全な tarball による破壊を防ぐ)。
if ! tar -tzf "$TMP_TAR" | grep -q "server.js"; then
  echo "ERROR: tarball に server.js が含まれていません。"
  echo "リポジトリ (${REPO_URL}) の push 状態を確認してください。"
  rm -f "$TMP_TAR"
  exit 1
fi
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP_TAR" --strip-components=1 -C "$INSTALL_DIR"
rm -f "$TMP_TAR"
echo "GitHub からの取得が完了しました"

# --- 取得ファイルの確認 ---
for f in server.js package.json public/index.html lxd-setup.sh; do
  if [ ! -f "$INSTALL_DIR/$f" ]; then
    echo "ERROR: $INSTALL_DIR/$f が取得できませんでした。リポジトリの公開状態を確認してください。"
    exit 1
  fi
done
echo "ソースファイルの確認 OK"

# --- LXD セットアップ（冪等。未導入なら導入、未初期化なら初期化し、
#     ストレージプールと default プロファイルの root ディスクを必ず保証する）---
# OS 判別 (snap / pacman) は lxd-setup.sh 側で行う。
if [ "$IS_ARCH" = true ]; then
  : # Arch 系は pacman 前提のため snap チェック不要
elif ! command -v snap &>/dev/null; then
  echo "ERROR: snap が見つかりません。LXD を手動でインストールしてから再実行してください。"
  exit 1
fi
echo "LXD セットアップを実行します..."
bash "$INSTALL_DIR/lxd-setup.sh"
command -v lxc &>/dev/null || { echo "ERROR: LXD のセットアップに失敗しました (lxc コマンドが見つかりません)"; exit 1; }
echo "LXD: $(lxc version 2>/dev/null || lxc --version)"

# --- npm パッケージ (WebSocket + PTY) ---
echo "npm パッケージをインストール中..."
cd "$INSTALL_DIR"
npm install
# npm 12+ では install scripts がデフォルトでブロックされるため、
# node-pty (ターミナル用ネイティブモジュール) を明示的に承認してビルドする。
# 承認状態は package.json の allowScripts に保存される。
# (古い npm では install-scripts コマンドが無いため失敗しても無視する)
npm install-scripts approve node-pty 2>/dev/null || true
npm rebuild node-pty 2>/dev/null || npm install --build-from-source node-pty 2>/dev/null || true
if [ ! -f "$INSTALL_DIR/node_modules/node-pty/build/Release/pty.node" ]; then
  echo "ERROR: node-pty のネイティブビルドに失敗しました。"
  echo "Ubuntu の場合: build-essential / python3 が導入されているか確認してください。"
  echo "Arch 系の場合: base-devel / python3 が導入されているか確認してください。"
  echo "手動ビルド: cd ${INSTALL_DIR} && npm install-scripts approve node-pty && npm rebuild node-pty"
  exit 1
fi
echo "npm パッケージ インストール完了 (node-pty ビルド確認 OK)"

# --- systemd ---
# Arch 系 (CachyOS 等) は lxd が socket activation のため After に lxd.socket を含める。
# Ubuntu (snap) では lxd.service のみで動作する。
if [ "$IS_ARCH" = true ]; then
  LXD_AFTER="network-online.target lxd.socket lxd.service"
else
  LXD_AFTER="network.target lxd.service"
fi
SERVICE_FILE="/etc/systemd/system/easy-lxd.service"
if [ -w /etc/systemd/system ] 2>/dev/null || [ "$(id -u)" -eq 0 ]; then
  cat > "$SERVICE_FILE" << SVCEOF
[Unit]
Description=Easy LXD UI
After=${LXD_AFTER}

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
