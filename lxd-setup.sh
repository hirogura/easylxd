#!/bin/bash
set -euo pipefail

# ============================================================
# LXD セットアップスクリプト
# 何度実行しても安全。既に設定済みの項目はスキップします。
# ============================================================

LXD_POOL_DIR="/opt/lxd-pool"

# ------------------------------------------------------------
# 1. LXD インストール
# ------------------------------------------------------------
if snap list lxd &>/dev/null; then
  echo "[SKIP] LXD は既にインストール済みです"
else
  echo "[RUN]  LXD をインストールします..."
  sudo snap install lxd --channel=latest/stable
fi

# ------------------------------------------------------------
# 2. LXD 初期化
# ------------------------------------------------------------
if sudo lxc info &>/dev/null 2>&1 && sudo lxc storage list | grep -q "default"; then
  echo "[SKIP] LXD は既に初期化済みです"
else
  echo "[RUN]  LXD を初期化します..."
  sudo lxd init --minimal
fi

# ------------------------------------------------------------
# 3. ストレージプールを /opt/lxd-pool に変更
# ------------------------------------------------------------
sudo mkdir -p "$LXD_POOL_DIR"

CURRENT_SOURCE=$(sudo lxc storage get default source 2>/dev/null || echo "")
if [ "$CURRENT_SOURCE" = "$LXD_POOL_DIR" ]; then
  echo "[SKIP] Storage pool は既に $LXD_POOL_DIR を向いています"
else
  echo ""
  echo "------------------------------------------"
  echo " 既存のデフォルトプールが検出されました"
  echo "   現在のソース: $CURRENT_SOURCE"
  echo "   変更先:      $LXD_POOL_DIR"
  echo "------------------------------------------"
  read -rp " デフォルトプールを $LXD_POOL_DIR に変更しますか？ [Y/n] " CHANGE_POOL
  CHANGE_POOL=${CHANGE_POOL:-Y}
  if [[ "$CHANGE_POOL" =~ ^[Yy]$ ]]; then
    echo "[RUN]  Storage pool を $LXD_POOL_DIR に変更します..."
    # default プールを参照しているプロファイルデバイスを先に外す
    sudo lxc profile device remove default root 2>/dev/null || true
    sudo lxc storage delete default 2>/dev/null || true
    sudo lxc storage create default dir source="$LXD_POOL_DIR"
    sudo lxc profile device add default root disk path=/ pool=default
  else
    echo "[SKIP] デフォルトプールは既存のまま維持します"
  fi
fi

# ------------------------------------------------------------
# 4. HTTPS API を有効化
# ------------------------------------------------------------
CURRENT_HTTPS=$(sudo lxc config get core.https_address 2>/dev/null || echo "")
if [ "$CURRENT_HTTPS" = ":8443" ]; then
  echo "[SKIP] HTTPS API は既に :8443 で有効です"
else
  echo "[RUN]  HTTPS API を :8443 で有効化します..."
  sudo lxc config set core.https_address :8443
fi

# ------------------------------------------------------------
# 5. ユーザーを lxd グループに追加
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
