#!/bin/bash
set -euo pipefail

# ============================================================
# LXD セットアップスクリプト
# 何度実行しても安全。既に設定済みの項目はスキップします。
# ============================================================

LXD_POOL_DIR="/opt/lxd-pool"

# ------------------------------------------------------------
# 1. LXD インストール確認（強制インストールはしない）
# ------------------------------------------------------------
if command -v lxc &>/dev/null || snap list lxd &>/dev/null; then
  echo "[SKIP] LXD は既にインストール済みです"
else
  echo "ERROR: LXD が見つかりません。以下を実行してから再実行してください:"
  echo "  sudo snap install lxd"
  exit 1
fi

# ------------------------------------------------------------
# 2. LXD 初期化（本当に未初期化の時だけ実行）
#    ※ lxc info はデーモンが応答すれば成功するため、未初期化でも
#      ここを通ってしまう。ブリッジ/eth0 の保証は後続ステップで行う。
# ------------------------------------------------------------
if sudo lxc info &>/dev/null; then
  echo "[SKIP] LXD は既に初期化済みです"
else
  echo "[RUN]  LXD を初期化します..."
  sudo lxd init --minimal
fi

# ------------------------------------------------------------
# 3. ネットワークブリッジ lxdbr0 を保証（NAT有効）
#    手動でプールだけ設定された環境では lxdbr0 が無く、コンテナに
#    NIC が付かず疎通できないため、初期化の成否に関係なく保証する。
# ------------------------------------------------------------
if sudo lxc network show lxdbr0 &>/dev/null; then
  echo "[SKIP] lxdbr0 は既に存在します"
else
  echo "[RUN]  lxdbr0 を作成します（IPv4 NAT有効）..."
  sudo lxc network create lxdbr0 ipv4.nat=true
fi

# ------------------------------------------------------------
# 4. default プロファイルへの eth0 (lxdbr0) 割り当てを保証
# ------------------------------------------------------------
if sudo lxc profile device list default 2>/dev/null | grep -qw eth0; then
  echo "[SKIP] default プロファイルには eth0 が設定済みです"
else
  echo "[RUN]  default プロファイルに eth0 を追加します..."
  sudo lxc profile device add default eth0 nic network=lxdbr0 name=eth0
fi

# ------------------------------------------------------------
# 5. コンテナの外部疎通を保証（IP転送・ファイアウォール）
# ------------------------------------------------------------
if [ "$(sysctl -n net.ipv4.ip_forward)" = "1" ]; then
  echo "[SKIP] IP転送は既に有効です"
else
  echo "[RUN]  IP転送を有効化します（永続設定含む）..."
  sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null
  echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-easy-lxd-forward.conf >/dev/null
fi

if command -v ufw &>/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  if sudo ufw status | grep -q "allow in on lxdbr0"; then
    echo "[SKIP] ufw は既に lxdbr0 を許可しています"
  else
    echo "[RUN]  ufw に lxdbr0 の転送許可を追加します..."
    sudo ufw allow in on lxdbr0 || true
    sudo ufw route allow in on lxdbr0 || true
  fi
fi

# ------------------------------------------------------------
# 6. ストレージプールを /opt/lxd-pool に変更
#    （default プールが無い状態でも必ず作成する）
# ------------------------------------------------------------
sudo mkdir -p "$LXD_POOL_DIR"

CURRENT_SOURCE=$(sudo lxc storage get default source 2>/dev/null || echo "")
if [ "$CURRENT_SOURCE" = "$LXD_POOL_DIR" ]; then
  echo "[SKIP] Storage pool は既に $LXD_POOL_DIR を向いています"
else
  echo "[RUN]  Storage pool を $LXD_POOL_DIR に変更します..."
  if sudo lxc storage show default &>/dev/null; then
    # default プールを参照しているプロファイルデバイスを先に外す
    sudo lxc profile device remove default root 2>/dev/null || true
    sudo lxc storage delete default
  fi
  sudo lxc storage create default dir source="$LXD_POOL_DIR"
fi

# ------------------------------------------------------------
# 7. default プロファイルへの root ディスク割り当てを保証
# ------------------------------------------------------------
if sudo lxc profile device list default 2>/dev/null | grep -qw "root"; then
  echo "[SKIP] default プロファイルには root ディスクが設定済みです"
else
  echo "[RUN]  default プロファイルに root ディスクを追加します..."
  sudo lxc profile device add default root disk path=/ pool=default
fi

# ------------------------------------------------------------
# 8. HTTPS API を有効化
# ------------------------------------------------------------
CURRENT_HTTPS=$(sudo lxc config get core.https_address 2>/dev/null || echo "")
if [ "$CURRENT_HTTPS" = ":8443" ]; then
  echo "[SKIP] HTTPS API は既に :8443 で有効です"
else
  echo "[RUN]  HTTPS API を :8443 で有効化します..."
  sudo lxc config set core.https_address :8443
fi

# ------------------------------------------------------------
# 9. ユーザーを lxd グループに追加
# ------------------------------------------------------------
if id -nG "$USER" | grep -qw lxd; then
  echo "[SKIP] $USER は既に lxd グループのメンバーです"
else
  echo "[RUN]  $USER を lxd グループに追加します..."
  sudo usermod -aG lxd "$USER"
  NEED_RELOGIN=true
fi

# ------------------------------------------------------------
# 完了メッセージ
# ------------------------------------------------------------
echo ""
echo "=========================================="
echo " LXD セットアップ完了"
echo "=========================================="
echo " アクセス先:"
echo "   https://$(hostname):8443"
echo "=========================================="
if [ "${NEED_RELOGIN:-false}" = "true" ]; then
  echo ""
  echo "※ グループ変更を反映するため、一度ログアウト＆再ログインしてください"
fi
echo ""
