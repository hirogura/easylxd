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

- Ubuntu / Debian 系、または CachyOS / Arch Linux 系（systemd が動くこと）
- LXD（未導入の場合はインストールスクリプトが OS に合わせて自動導入します。
  Ubuntu 系は snap、CachyOS / Arch 系は pacman）
- Tailscale がインストール済みで、ログイン済みであること
- root 権限
- インターネット接続

自動でインストールされるもの:

- Node.js / npm
- Ubuntu 系: build-essential, python3（node-pty のビルド用）、pciutils（GPU 一覧の取得用）
- CachyOS / Arch 系: base-devel, python3、pciutils（GPU 一覧の取得用）、
  usbutils（チューナー検出用）、jq、lxd、dkms、btrfs-progs、カーネルヘッダ

---

## インストール

### 手順1: LXD のセットアップ（未導入の場合のみ）

> 未導入のまま 手順2 のインストールスクリプトを実行すると、LXD をインストールするか
> 確認が表示され、`y` を選ぶとこのセットアップが自動で実行されます。
> 手動で実行したい場合のみ、以下のコマンドを使用してください。

```bash
curl -fsSL -o /tmp/lxd-setup.sh \
  https://raw.githubusercontent.com/hirogura/easylxd/main/lxd-setup.sh
chmod +x /tmp/lxd-setup.sh
/tmp/lxd-setup.sh
```

実行内容（何度実行しても安全・既に設定済みの項目はスキップ）:

- LXD のインストール（Ubuntu 系は snap、CachyOS / Arch 系は pacman。
  後者は `lxd.socket` / `lxd.service` の有効化も行う）
- CachyOS / Arch 系のみ: `/etc/subuid`・`/etc/subgid` の root マッピング追加、
  firewalld が有効な場合の lxdbr0 許可
- `lxd init --minimal` による初期化
- Btrfs 環境のみ: `/opt/lxd-pool`・`/opt/lxd-data` を独立サブボリュームとして事前作成
  （snapper のシステムスナップショットから除外するため。非Btrfs 環境や
  空でない既存ディレクトリでは何もしない）
- ストレージプールを `/opt/lxd-pool` に変更
  （Btrfs 上では `btrfs` ドライバー、それ以外は `dir` ドライバー）
- HTTPS API の有効化（`:8443`）
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

> LXD が未インストールの場合は、先に LXD をインストールするか確認が表示されます。
> `y` を入力すると 手順1 のセットアップ（`lxd-setup.sh`）が自動で実行された後、
> Easy LXD UI のインストールが続行されます。`n` を入力すると中止されます。

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

UI の「サーバアップデート」ボタンから、lxd-setup.sh の再適用と EasyLXD 本体
（server.js / public など）の最新版取得・npm パッケージ更新・サービス再起動を
一括で実行できます。

インストールスクリプトを再実行する方法でも最新版へ更新できます。

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

### KonomiTV (DTV) について

コンテナ操作（作成・Tailscale・Docker・マウント等）はコンテナ内が Ubuntu のため
ホスト OS によらずそのまま動作します。ホスト側のチューナードライバ（px4_drv）導入は、
「px4_drvインストール」ボタンがホスト OS を自動判定し、
CachyOS / Arch 系では `tuner-lxd-cachyos.sh`（ソース + DKMS 方式）、
Ubuntu / Debian 系では従来どおり `tuner-lxd.sh`（.deb + apt 方式）の
ドライバ部分を実行します。
CachyOS での詳細は [KONOMITV-CACHYOS.md](KONOMITV-CACHYOS.md) を参照してください。

## ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開されています。
