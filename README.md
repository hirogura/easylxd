# Easy LXD UI

LXD インスタンスをブラウザから管理するための Web UI です（v3.0.1）。
アプリ本体は `127.0.0.1:3329` で待ち受け、Tailscale Serve 経由で Tailnet 内にのみ HTTPS 公開されます。

<img width="512" height="309" alt="Image" src="https://github.com/user-attachments/assets/7a83155c-d35c-4f78-8e4c-3e367c62a16d" />

---

## 主な機能

### インスタンス管理

- 一覧表示 / 起動・停止・再起動・削除
- ステータス（実行中 / 停止中）、作成日時、プロファイル、Tailscale・Docker の稼働状況を表示
- インスタンス名をクリックすると詳細パネルが開き、IP アドレス・マウントデバイス・GPU パススルーの状況を確認できます
- Nesting / 特権 の Allow・Deny をボタンで切り替え（特権の変更は再起動後に反映）

### インスタンス作成

- Ubuntu イメージ（18.04 〜 26.04、LTS を自動判別）またはカスタムイメージ（`debian:12` など任意の alias）から作成
- イメージ欄の「↻ 確認」でリモートの最新 Ubuntu イメージ一覧を取得
- Ubuntu イメージでは以下のオプションを指定できます（複数選択可）
  - **アップデート**: `apt-get update && upgrade` + タイムゾーンを JST (Asia/Tokyo) に設定
  - **Tailscale**: インストール後、authkey で認証。authkey を指定しない場合は通常の `tailscale up`（ログイン URL をブラウザで開く）で認証
    - 認証に失敗した場合、作成中に「別の authkey / 通常の tailscale up / スキップ」を対話で選択できます
  - **Docker**: `security.nesting` と syscall intercept を設定し、Docker と `/opt/docker` を用意
  - **/opt/lxd-data マウント**: ホストの共有ディレクトリを UID/GID 1000 でマウント
  - **スナップショット「TailscaleOK」を作成**: 停止 → スナップショット作成 → 起動まで自動で実行
- 作成の進捗はリアルタイムログ（SSE）で表示されます

### Web ターミナル

- xterm.js + WebSocket + node-pty によるコンテナの対話操作
- セッションは共有され、別の PC からも同じセッションに合流できます（接続時に過去の出力をリプレイ）
- 最後の切断から 24 時間はセッションを保持し、「現在のターミナル」一覧から再接続・リセットが可能
- 画面に合わせたリサイズ（FIT）やドラッグによる高さ変更に対応
- 対話型のインストールスクリプトをそのまま実行できます（KonomiTV のアプリインストールで使用）

### スナップショット / クローン

- スナップショットの作成（コメント付き）・復元・削除
- 復元時はコンテナの `devices` / `config` もスナップショット時点に戻し、元が稼働中なら起動し直します
- クローンはステートレスコピーで作成し、ID マッピング設定 (`raw.idmap`) を付けて起動します

### GPU パススルー

- ホストの GPU を LXD API で検出（取得できない場合は `lspci` にフォールバック）
- 物理 GPU をコンテナに追加・取り外しできます（即時に反映され、再起動は不要です）

### マウントデバイス

- ホスト側パスとコンテナ側パスを指定して disk デバイスを追加・編集・取り外しできます
- `raw.idmap (both 1000 1000)` を自動で合わせ、ホスト UID 1000 のファイルをコンテナ内から読み書きできます
- 稼働中のコンテナでは一度停止して設定を適用した後、自動で起動し直します（ルート `/` へのマウントは拒否）

### アプリ一覧

画面右側の「アプリ一覧」から、稼働中コンテナへのアプリ登録とインストールを行えます。

1. コンテナを選んで「登録」
2. 「インストール」でコンテナ内にインストールスクリプトを実行（進捗はリアルタイムログで表示）
3. インストール済みになると、Tailnet の MagicDNS 名を使った URL の「起動」リンクに変わります

インストール済み判定はコンテナ内の systemd ユニットを基準にしているため、`/opt/lxd-data` 配下にインストールされるアプリ（selfmark / SPW）もスナップショット復元後に正しく判定されます。また、「解除」は登録情報のみを削除し、アプリ本体は削除しません。

| アプリ | 公開ポート |
|--------|-----------|
| selfEx | 3362 |
| SelfNote | 3342 |
| selfrss | 3347 |
| selfmark | 3356 |
| selfphoto | 3360 |
| SPW | 3344 |
| rcloneGUI | 3348 |
| rsyncGUI | 3326 |
| Taildrop Web | 3349 |
| selfRDP | 3375 |
| News Flow | 3364 |
| selfOCR | 3369 |
| faceblur | 3370 |
| bgblur | 3371 |
| htmledit | 3372 |
| honyaku | 3374 |
| shoppinglist | 3368 |

### KonomiTV (DTV)

アプリ一覧の下の KonomiTV ブロックで、以下の順にセットアップします。

1. **px4_drvインストール**: `~/dtv` にリポジトリを取得し、ホスト OS に合ったスクリプト（CachyOS / Arch は `tuner-lxd-cachyos.sh`、Ubuntu / Debian は `tuner-lxd.sh`）のドライバ部分のみをホスト上で実行します
2. **コンテナ作成**: `ubuntu:26.04` のコンテナを作成し、/opt/lxd-data マウント、ID マッピング、Tailscale を設定します。authkey 使用・「TailscaleOK」スナップショット・USB チューナーのパススルー・「TunerOK」スナップショットをそれぞれ指定できます
3. **アプリインストール**: コンテナ内で `install-mirakc-edcb-konomitv.sh` を実行します。B-CAS キー入力などの対話操作が必要なためターミナルが開きます（スクリプトが無い場合は自動ダウンロード）
4. **DTV管理**: DTV 管理ダッシュボードをコンテナ内にインストールし、ポート 80 で HTTP 公開します。インストール後は MagicDNS 名へのリンクに変わります

その他、以下の操作が可能です。

- **バックアップをインポート**: `konomitv-backup-日付.tar.gz` を `/opt/lxd-data/konomitv-backup` に展開します（既存バックアップは上書き）
- **対象コンテナ変更**: 「TunerOK」スナップショットから復元した既存コンテナなどを、KonomiTV セットアップの対象に切り替えます

CachyOS 環境の詳細は [KONOMITV-CACHYOS.md](KONOMITV-CACHYOS.md) を参照してください。

### サーバ管理

- **サーバアップデート**: `lxd-setup.sh` の再適用（ストレージプールは変更しません）、Easy LXD 本体の最新版取得、npm パッケージ更新、サービスの再起動を一括で実行します
- **サーバ再起動**: Easy LXD の systemd サービスを再起動します（ホスト OS の再起動ではありません）

---

## 必要要件

- Ubuntu / Debian 系、または CachyOS / Arch Linux 系（systemd が動くこと）
- LXD（未導入の場合はインストールスクリプトが OS に合わせて自動導入します。
  Ubuntu 系は snap、CachyOS / Arch 系は pacman）
- Tailscale がインストール済みで、ログイン済みであること
- root 権限
- インターネット接続

自動でインストールされるもの:

- Ubuntu / Debian 系: Node.js / npm（NodeSource）、curl、build-essential、python3（node-pty のビルド用）、pciutils（GPU 一覧の取得用）
- CachyOS / Arch 系: curl、git、nodejs、npm、base-devel、python3、pciutils（GPU 一覧の取得用）、
  usbutils（チューナー検出用）、jq、procps-ng、tailscale、lxd、dkms、btrfs-progs、カーネルヘッダ

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
- `lxdbr0` の作成、default プロファイルへの `eth0` 割り当て、IP 転送の有効化
  （ufw / firewalld を使っている場合は lxdbr0 の転送を許可）
- Btrfs 環境のみ: `/opt/lxd-pool`・`/opt/lxd-data` を独立サブボリュームとして事前作成
  （snapper のシステムスナップショットから除外するため。非Btrfs 環境や
  空でない既存ディレクトリでは何もしない）
- ストレージプールを `/opt/lxd-pool` に変更
  （Btrfs 上では `btrfs` ドライバー、それ以外は `dir` ドライバー）
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
| アプリ登録情報・KonomiTV 対象コンテナ | `/opt/easy-lxd/apps.json`, `/opt/easy-lxd/dtv.json` |
| systemd サービス | `/etc/systemd/system/easy-lxd.service` |

---

## 管理コマンド

### サービスの状態確認・再起動

```bash
systemctl status easy-lxd
systemctl restart easy-lxd
```

再起動やアップデートは UI の「サーバ再起動」/「サーバアップデート」ボタンからも実行できます。

### アップデート（最新版へ更新）

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
UID/GID 1000 で共有されます。KonomiTV のバックアップは
`/opt/lxd-data/konomitv-backup` に保存されます。

## ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開されています。
