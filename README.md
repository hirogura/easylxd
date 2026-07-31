# Easy LXD UI

LXD インスタンスをブラウザから管理するための Web UI です。

- インスタンスの一覧 / 起動・停止・再起動・削除
- インスタンス作成（Ubuntu / カスタムイメージ対応）
  - apt アップデート、Tailscale、Docker、/opt/lxd-data マウント をワンクリックで設定
- Web ターミナル（xterm.js + WebSocket + PTY）
- スナップショット作成・復元・削除
- クローン
- GPU パススルー
<img width="512" height="309" alt="Image" src="https://github.com/user-attachments/assets/7a83155c-d35c-4f78-8e4c-3e367c62a16d" />
---

## 必要要件

- Ubuntu（または systemd が動く Linux）
- LXD（未導入の場合は手順1 の `lxd-setup.sh` で導入できます）
- Tailscale がインストール済みで、ログイン済みであること
- root 権限
- インターネット接続

自動でインストールされるもの:

- Node.js / npm
- build-essential, python3（node-pty のビルド用）
- pciutils（GPU 一覧の取得用）

---

## インストール

### 手順1: LXD のセットアップ（未導入の場合のみ）

LXD がまだインストールされていない場合は、先にセットアップスクリプトを実行してください。

```bash
curl -fsSL -o /tmp/lxd-setup.sh \
  https://raw.githubusercontent.com/hirogura/easylxd/main/lxd-setup.sh
chmod +x /tmp/lxd-setup.sh
/tmp/lxd-setup.sh
```

実行内容（何度実行しても安全・既に設定済みの項目はスキップ）:

- LXD のインストール（snap）
- `lxd init --minimal` による初期化
- ストレージプールを `/opt/lxd-pool` に変更
- HTTPS API の有効化（`:8443`）
- LXD UI の有効化
- 実行ユーザーを `lxd` グループに追加

**完了後、一度再起動してから次の手順に進んでください。**

> 既に LXD がインストール済みで動作している場合は、この手順は不要です。

### 手順2: Easy LXD UI のインストール

インストールスクリプトをダウンロードして実行します。

```bash
curl -fsSL -o /tmp/install-easylxd1.sh \
  https://raw.githubusercontent.com/hirogura/easylxd/main/install-easylxd1.sh
chmod +x /tmp/install-easylxd1.sh
sudo /tmp/install-easylxd1.sh
```

> root 権限が必要です。通常ユーザーで実行する場合は `sudo` を付けてください。
> 注意: スクリプトの実行前に、スクリプトの内容を確認してください。

インストール完了時には、以下が表示されます。

```bash
=== インストール完了 ===
  Node:  /usr/bin/node (v20.11.0)
  URL:   https://<マシン名>.ts.net:3329  (Tailnet内のみ)
  Dir:   /opt/easy-lxd
```

---

## アクセス方法

- Tailscale ネットワーク（Tailnet）内のブラウザから、インストール完了時に表示された URL にアクセスします。
  - 例: `https://<マシン名>.ts.net:3329`
- URL が分からなくなった場合は、サーバー上で以下を実行して確認できます。

  ```bash
  tailscale serve status
  tailscale status
  ```

---

## 公開範囲について

**Tailnet 内のみに公開されます。** アプリ本体は `127.0.0.1:3329` でのみ待ち受け、
Tailscale Serve 経由で Tailscale ネットワーク（Tailnet）内に HTTPS で公開されます。
LAN やインターネットには公開されません。

---

## インストール内容

| 項目 | 場所 |
|------|------|
| アプリ本体（サーバー + Web UI） | `/opt/easy-lxd/` |
| npm 依存パッケージ | `/opt/easy-lxd/node_modules/` |
| データ共有ディレクトリ（コンテナへマウント） | `/opt/lxd-data/` |
| systemd サービス | `/etc/systemd/system/easy-lxd.service` |

---

## 管理コマンド

### サービスの状態確認・再起動

```bash
systemctl status easy-lxd
systemctl restart easy-lxd
```

### アップデート（最新版へ更新）

インストールスクリプトを再実行すると、GitHub から最新版を取得して上書きし、
npm パッケージを更新したうえでサービスを再起動します。

```bash
curl -fsSL -o /tmp/install-easylxd1.sh \
  https://raw.githubusercontent.com/hirogura/easylxd/main/install-easylxd1.sh
chmod +x /tmp/install-easylxd1.sh
sudo /tmp/install-easylxd1.sh
```

### アンインストール

```bash
systemctl stop easy-lxd
systemctl disable easy-lxd
rm /etc/systemd/system/easy-lxd.service
systemctl daemon-reload
rm -rf /opt/easy-lxd
```

> 注意: `/opt/lxd-data` はコンテナと共有しているデータのため、削除しません。

---

## ポート

- アプリ本体: `3329`（127.0.0.1 のみ）
- Tailscale Serve: `https://<マシン名>.ts.net:3329`

ポートを変更したい場合は `install-easylxd1.sh` 内の `PORT` を変更してください。

---

## 補足

### /opt/lxd-data について

インスタンス作成時に「/opt/lxd-data マウント」を有効にすると、
コンテナ内の `/opt/lxd-data` にホストの `/opt/lxd-data` がマウントされ、
UID/GID 1000 で共有されます。
