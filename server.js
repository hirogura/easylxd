const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const pty = require('node-pty');

const PORT = 3329;

function run(cmd, args = [], timeout = 120000, onData = null, env = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; if (onData) onData(d); });
    child.stderr.on('data', d => { stderr += d; if (onData) onData(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Command timed out')); }, timeout);
    child.on('close', code => { clearTimeout(timer); code !== 0 ? reject(new Error(stderr.trim() || `Command failed with exit code ${code}`)) : resolve({ stdout: stdout.trim() }); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function lxc(...args) { return run('lxc', args); }

async function lxdApi(method, apiPath, body = null, etag = null) {
  const args = ['query', '--wait', '-X', method];
  if (etag) args.push('-H', `If-Match: ${etag}`);
  if (body) args.push('--data', JSON.stringify(body));
  args.push(apiPath);
  const result = await run('lxc', args);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

async function lxdGetInstance(name) {
  const result = await run('lxc', ['query', '--wait', '--raw', `/1.0/instances/${name}?recursion=1`]);
  const data = JSON.parse(result.stdout);
  return data.metadata || data;
}

async function lxdUpdateInstance(name, updateFields) {
  const inst = await lxdGetInstance(name);
  const payload = {
    devices: { ...(inst.devices || {}) },
    config: { ...(inst.config || {}) },
    profiles: inst.profiles || ['default'],
    description: inst.description || '',
    ephemeral: inst.ephemeral || false,
    stateful: inst.stateful || false
  };
  Object.assign(payload, updateFields);
  return run('lxc', ['query', '--wait', '-X', 'PUT', '--data', JSON.stringify(payload), `/1.0/instances/${name}`]);
}

function parseBody(req, maxBytes = 1000000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > maxBytes) {
        tooLarge = true;
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => { if (!tooLarge) { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// SSE (Server-Sent Events) レスポンスを開始し、log/done/error イベント送信関数を返す。
function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  return (evt, data) => { try { res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
}

// Tailscale IP (CGNAT 100.64.0.0/10) が tailscale0 に割り当てられているか。
// lxc list の state.network を見るだけなので追加の exec は不要。
function hasTailscaleIp(inst) {
  const net = inst.state && inst.state.network;
  const ts = net && net.tailscale0;
  return !!(ts && (ts.addresses || []).some(a => a.family === 'inet' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)));
}

// dockerd は起動時に docker0 ブリッジを作成するため、その有無で
// Docker が動作中かを判定できる（exec 不要・Tailscale と同じ方式）。
function hasDockerBridge(inst) {
  const net = inst.state && inst.state.network;
  return !!(net && net.docker0);
}

// 稼働中かつ Docker が動作しているコンテナ名の一覧を返す。
async function getDockerContainers() {
  try {
    return (await getInstances())
      .filter(i => i.status === 'Running' && i.docker)
      .map(i => i.name);
  } catch (e) { return []; }
}

async function getInstances() {
  const { stdout } = await lxc('list', '--format', 'json');
  return JSON.parse(stdout).map(c => {
    const cfg = c.config || {};
    return {
      name: c.name, status: c.status, ephemeral: c.ephemeral, type: c.type,
      architecture: c.architecture, created_at: c.created_at, profiles: c.profiles,
      devices: c.devices || {},
      security: {
        nesting: cfg['security.nesting'] === 'true',
        privileged: cfg['security.privileged'] === 'true'
      },
      state: c.state ? { status: c.state.status, pid: c.state.pid, memory: c.state.memory, disk: c.state.disk, cpu: c.state.cpu, network: c.state.network } : null,
      snapshots: c.snapshots || [],
      tailscale: c.status === 'Running' && hasTailscaleIp(c),
      docker: c.status === 'Running' && hasDockerBridge(c)
    };
  });
}

async function getInstance(name) {
  const instances = await getInstances();
  const inst = instances.find(i => i.name === name);
  if (!inst) throw new Error('Instance not found');
  return inst;
}

async function getSnapshots(container) {
  const inst = await getInstance(container);
  return (inst.snapshots || []).map(s => ({ name: s.name, created_at: s.created_at, size: s.size }));
}

async function lxcExec(name, script, timeout = 300000, onData = null, env = null) {
  // env 指定時は lxc exec --env 経由でコンテナ内へ渡す（authkey 等のコマンドライン露出を避ける）。
  const args = ['exec', name];
  for (const [k, v] of Object.entries(env || {})) args.push('--env', `${k}=${v}`);
  args.push('--', 'bash', '-euo', 'pipefail', '-c', script);
  return run('lxc', args, timeout, onData);
}

// コマンドの標準出力/エラー出力を1行ずつ progress ログへ流すためのヘルパー。
// バッファに溜まったチャンクを改行区切りで取り出し、空行は無視する。
function streamToLog(log, prefix = '  ') {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim()) log(`${prefix}${line}`);
    }
  };
}

function waitRunning(name, timeout = 30) {
  return new Promise(resolve => {
    let elapsed = 0;
    const iv = setInterval(async () => {
      try { const { stdout } = await lxc('info', name); if (/Status:\s*RUNNING/.test(stdout)) { clearInterval(iv); resolve(); } } catch (e) {}
      elapsed++; if (elapsed >= timeout) { clearInterval(iv); resolve(); }
    }, 1000);
  });
}

// lxc info の Status: RUNNING はコンテナプロセスが起動したことしか示さず、
// systemd-resolved 等のネットワーク/DNS初期化が終わっている保証はない。
// 起動直後に apt-get update / curl | sh を実行すると
// "Could not resolve host" で失敗することがあるため、実際に名前解決込みの
// 疎通確認ができるまでポーリングして待つ。
async function waitNetworkReady(name, timeoutSec = 30) {
  for (let i = 1; i <= timeoutSec; i++) {
    try {
      await lxcExec(name, 'curl -fsSL --max-time 3 https://get.docker.com -o /dev/null', 5000);
      return { ok: true, waited: i };
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, waited: timeoutSec };
}

const UBUNTU_VERSIONS = ['26.04', '25.10', '25.04', '24.04', '22.04', '20.04', '18.04'];
let cachedImages = null;

function getImages() {
  if (cachedImages) return cachedImages;
  return UBUNTU_VERSIONS.map(ver => {
    // 偶数年 .04 のみ LTS（26.04 / 24.04 / 22.04 / 20.04 / 18.04）。
    // 25.04 / 25.10 のような中間リリースに LTS と付けない。
    const major = parseInt(ver.split('.')[0], 10);
    const isLts = ver.endsWith('.04') && major % 2 === 0;
    return { alias: `ubuntu:${ver}`, description: `Ubuntu ${ver}${isLts ? ' LTS' : ''}` };
  });
}

async function refreshImages() {
  const { stdout } = await run('lxc', ['image', 'list', 'ubuntu:', '--format', 'json']);
  const raw = JSON.parse(stdout);
  const seen = new Set();
  const images = [];
  for (const img of raw) {
    if (img.architecture !== 'x86_64') continue;
    for (const alias of (img.aliases || [])) {
      const name = alias.name || '';
      if (name.includes('/') || seen.has(name)) continue;
      seen.add(name);
      const desc = ((img.properties && img.properties.description) || '').replace(/\s*\(release\)/, '').trim();
      images.push({ alias: `ubuntu:${name}`, description: desc || `Ubuntu ${name}` });
    }
  }
  images.sort((a, b) => { const va = a.alias.replace(/[^0-9.]/g, ''); const vb = b.alias.replace(/[^0-9.]/g, ''); return vb.localeCompare(va, undefined, { numeric: true }); });
  cachedImages = images;
  return images;
}

// CachyOS/Arch ではカーネル更新後に再起動せず `lxc launch` すると
// veth 作成に失敗する（実行中カーネルの /lib/modules が pacman で
// 削除済みのため "Unknown device type" になる）。
// LXD のエラーだけでは原因が分かりづらいため、事前に検出して
// 再起動を促すメッセージで失敗させる。
async function checkHostVeth(log) {
  const { stdout: kver } = await run('uname', ['-r']);
  if (!fs.existsSync(`/lib/modules/${kver}`)) {
    throw new Error(`ホストのカーネル (${kver}) 用モジュールが見つかりません。カーネル更新後に再起動していない可能性があります。ホストを再起動 (sudo reboot) してから再試行してください。`);
  }
  // veth が実際に作れるか試す。別要因（権限等）の失敗では警告に留め、
  // 先に進んで LXD 側のエラーをそのまま出す。
  // インターフェース名は15文字制限 (IFNAMSIZ) のため短くする。
  const a = `ev${process.pid}a`;
  const b = `ev${process.pid}b`;
  try {
    await run('ip', ['link', 'add', a, 'type', 'veth', 'peer', 'name', b], 15000);
    await run('ip', ['link', 'del', a], 15000).catch(() => {});
  } catch (e) {
    if (/Unknown device type/i.test(e.message)) {
      throw new Error(`ホストで veth を作成できません (Unknown device type)。カーネル更新後の再起動が必要な可能性があります。ホストを再起動 (sudo reboot) してから再試行してください。`);
    }
    (log || (() => {}))(`WARNING: veth 事前確認をスキップします: ${e.message}`);
  }
}

async function createInstance(opts, progress) {
  const { name, image, update: doUpdate, tailscale, docker, mount, tailscaleAuthkey, snapTailscaleOK } = opts;
  const isUbuntu = image.startsWith('ubuntu:');
  const log = progress || (() => {});

  log('ホストのネットワーク機能(veth)を確認中...');
  await checkHostVeth(log);
  log('ホストのネットワーク機能(veth)を確認しました');
  log(`lxc launch ${image} ${name}`);
  await run('lxc', ['launch', image, name], 300000, streamToLog(log));
  log('コンテナを起動中...');
  await waitRunning(name);
  log('起動完了');

  // マウントはネットワークに依存しないため最初に必ず実行する。
  // (疎通がない環境では apt-get update 等が失敗して例外で中断され、
  //  マウント処理まで到達しないという症状になっていた。)
  if (isUbuntu && mount) {
    log('/opt/lxd-data マウント設定中...');
    try {
      await lxc('stop', name);
    } catch (e) {
      if (!/already stopped/i.test(e.message)) throw e;
    }
    await lxc('config', 'device', 'add', name, 'opt-lxd-data', 'disk', 'source=/opt/lxd-data', 'path=/opt/lxd-data');
    await lxc('config', 'set', name, 'raw.idmap', 'both 1000 1000');
    // LXD の raw.idmap によりホスト側 root (UID 0) がコンテナ内 nobody にマッピングされ、
    // /opt/lxd-data/konomitv-backup に書き込めなくなる。事前に権限を緩和する。
    try {
      const fs = require('fs');
      fs.mkdirSync('/opt/lxd-data/konomitv-backup', { recursive: true });
      fs.chmodSync('/opt/lxd-data/konomitv-backup', 0o777);
    } catch (_) {}
    await lxc('start', name);
    await waitRunning(name);
    try {
      const { stdout } = await lxcExec(name, 'stat -c "%U:%G %a" /opt/lxd-data 2>&1 || echo "確認失敗"');
      log(`/opt/lxd-data 確認: ${stdout}`);
    } catch (e) {
      log(`/opt/lxd-data 確認できませんでした: ${e.message}`);
    }
    log('マウント設定完了');
  }

  if (isUbuntu && (doUpdate || tailscale || docker)) {
    log('ネットワーク疎通(DNS解決)を確認中...');
    const net = await waitNetworkReady(name, 30);
    log(net.ok
      ? `ネットワーク疎通を確認しました (${net.waited}秒)`
      : `WARNING: ネットワーク疎通が${net.waited}秒以内に確認できませんでした（続行しますが、update/tailscale/dockerが失敗する可能性があります）`);
  }

  if (isUbuntu && doUpdate) {
    try {
      log('apt-get update && upgrade 実行中...');
      await lxcExec(name, 'apt-get update && apt-get upgrade -y', 600000, streamToLog(log));
      log('アップデート完了');
    } catch (e) {
      log(`WARNING: アップデートに失敗しました（作成は継続します）: ${e.message}`);
    }
    try {
      log('タイムゾーンを JST (Asia/Tokyo) に設定中...');
      await lxcExec(name, 'sudo timedatectl set-timezone Asia/Tokyo', 60000, streamToLog(log));
      log('タイムゾーン設定完了');
    } catch (e) {
      log(`WARNING: タイムゾーン設定に失敗しました（作成は継続します）: ${e.message}`);
    }
  }
  if (isUbuntu && tailscale) {
    try {
      log('Tailscale インストール中...');
      await lxcExec(name, 'curl -fsSL https://tailscale.com/install.sh | sh -s -- --no-autostart', 300000, streamToLog(log));
      log('Tailscale インストール完了');
    } catch (e) {
      log(`WARNING: Tailscale インストールに失敗しました（作成は継続します）: ${e.message}`);
    }
    // authkey 指定時は tailscaled を起動して `tailscale up` まで行う（KonomiTV コンテナ作成と同じ挙動）。
    if (tailscaleAuthkey) {
      try {
        log('Tailscale 認証中 (authkey)...');
        await lxcExec(name, [
          'systemctl enable --now tailscaled',
          'for i in $(seq 1 30); do systemctl is-active --quiet tailscaled && break; sleep 1; done',
          'tailscale up --authkey="$TS_AUTHKEY"',
          'echo "Tailscale IP: $(tailscale ip -4 | head -n1)"'
        ].join('\n'), 180000, streamToLog(log), { TS_AUTHKEY: tailscaleAuthkey });
        log('Tailscale 認証完了');
      } catch (e) {
        log(`WARNING: Tailscale 認証に失敗しました（作成は継続します）: ${e.message}`);
      }
    }
  }
  if (isUbuntu && docker) {
    log('Docker インストール準備中 (security.nesting)...');
    try {
      await lxc('stop', name);
    } catch (e) {
      if (!/already stopped/i.test(e.message)) throw e;
    }
    await lxc('config', 'set', name, 'security.nesting', 'true');
    // overlay2 ストレージドライバがネストされたコンテナ内で正しく動くよう
    // mknod / setxattr のシステムコールをホスト側で代行する設定を追加。
    // security.nesting だけだと dockerd の起動が固まる/失敗するケースがある。
    await lxc('config', 'set', name, 'security.syscalls.intercept.mknod', 'true');
    await lxc('config', 'set', name, 'security.syscalls.intercept.setxattr', 'true');
    await lxc('start', name);
    await waitRunning(name);
    log('ネットワーク疎通(DNS解決)を再確認中...');
    const netAfterNesting = await waitNetworkReady(name, 30);
    log(netAfterNesting.ok
      ? `ネットワーク疎通を確認しました (${netAfterNesting.waited}秒)`
      : `WARNING: ネットワーク疎通が${netAfterNesting.waited}秒以内に確認できませんでした（続行します）`);
    try {
      log('Docker インストール中 (curl -fsSL https://get.docker.com | sh)...');
      // DEBIAN_FRONTEND / NEEDRESTART_MODE を明示しないと、Ubuntu 22.04+ の
      // needrestart が非TTY環境で対話待ちのままハングし、タイムアウトするまで
      // 何も進捗が出ない状態になることがあるため明示的に自動化する。
      await lxcExec(
        name,
        'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1; curl -fsSL https://get.docker.com | sh',
        600000,
        streamToLog(log)
      );
      log('Docker ディレクトリ設定中...');
      await lxcExec(name, `mkdir -p /opt/docker && if getent group docker >/dev/null 2>&1; then chown -R root:docker /opt/docker && chmod -R 775 /opt/docker; else chown -R root:root /opt/docker && chmod -R 755 /opt/docker; fi`, 300000, streamToLog(log));
      log('Docker インストール完了');
    } catch (e) {
      // Docker のインストールに失敗しても、既に完了しているマウント設定や
      // インスタンス自体の作成は無駄にしない。エラーはログに残して先に進む。
      log(`WARNING: Docker インストールに失敗しました（インスタンス作成は継続します）: ${e.message}`);
    }
  }
  // スナップショットは停止状態で取るため、停止 → スナップショット → 起動まで行う。
  if (snapTailscaleOK) {
    log('スナップショット「TailscaleOK」を作成するためコンテナを停止中...');
    try {
      await lxc('stop', name);
    } catch (e) {
      if (!/already stopped/i.test(e.message)) throw e;
    }
    await lxc('snapshot', name, 'TailscaleOK');
    log('スナップショット「TailscaleOK」を作成しました');
    await lxc('start', name);
    await waitRunning(name);
    log('コンテナを起動しました');
  }
  const features = []; if (isUbuntu && doUpdate) features.push('update'); if (isUbuntu && tailscale) features.push(tailscaleAuthkey ? 'tailscale(auth)' : 'tailscale');
  if (isUbuntu && docker) features.push('docker'); if (isUbuntu && mount) features.push('mount');
  if (snapTailscaleOK) features.push('snap:TailscaleOK');
  return `Instance ${name} created (${image}${features.length ? ' + ' + features.join(' + ') : ''})`;
}

const activeTerminals = new Map();
const MAX_BUFFER = 65536;
const SESSION_GRACE_MS = 86400000;

function killSession(session, instanceName) {
  if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }
  try { session.term.kill(); } catch (e) {}
  activeTerminals.delete(instanceName);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8'));
  }
  if (pathname === '/favicon.svg') {
    return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg'), 'utf-8'));
  }
  if (pathname === '/api/instances' && req.method === 'GET') {
    try { return json(res, 200, await getInstances()); } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const instMatch = pathname.match(/^\/api\/instances\/([^/]+)\/(start|stop|restart|delete)$/);
  if (instMatch && req.method === 'POST') {
    const [, name, action] = instMatch;
    try {
      if (action === 'delete') {
        try { await lxc('stop', name, '--force'); } catch (e) { if (!/already stopped/i.test(e.message)) throw e; }
        await lxc('delete', name);
      }
      else if (action === 'stop') await lxc('stop', name);
      else await lxc(action, name);
      return json(res, 200, { ok: true, message: `${action} completed for ${name}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/instances/create' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.image) return json(res, 400, { error: 'name and image are required' });
      return json(res, 200, { ok: true, message: await createInstance({
        name: body.name, image: body.image, update: !!body.update, tailscale: !!body.tailscale,
        docker: !!body.docker, mount: !!body.mount,
        tailscaleAuthkey: String(body.tailscaleAuthkey || '').replace(/[\r\n]/g, '').trim(),
        snapTailscaleOK: !!body.snapTailscaleOK
      }) });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/instances/create/stream' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n');
    const send = (evt, data) => { try { res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
    try {
      const body = await parseBody(req);
      if (!body.name || !body.image) { send('error', { error: 'name and image are required' }); res.end(); return; }
      send('log', { message: `=== ${body.name} の作成を開始 ===` });
      const result = await createInstance(
        {
          name: body.name, image: body.image, update: !!body.update, tailscale: !!body.tailscale,
          docker: !!body.docker, mount: !!body.mount,
          tailscaleAuthkey: String(body.tailscaleAuthkey || '').replace(/[\r\n]/g, '').trim(),
          snapTailscaleOK: !!body.snapTailscaleOK
        },
        (msg) => send('log', { message: msg })
      );
      send('done', { message: result });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    return;
  }

  const cloneMatch = pathname.match(/^\/api\/instances\/([^/]+)\/clone$/);
  if (cloneMatch && req.method === 'POST') {
    const [, srcName] = cloneMatch;
    try {
      const body = await parseBody(req);
      const newName = String(body.newName || '').trim();
      if (!newName) return json(res, 400, { error: 'newName is required' });
      if (!/^[a-zA-Z0-9_-]+$/.test(newName)) return json(res, 400, { error: 'newName は英数字と - _ のみ使用できます' });
      await lxc('copy', srcName, newName, '--stateless');
      await lxc('config', 'set', newName, 'raw.idmap', 'both 1000 1000'); await lxc('start', newName);
      return json(res, 200, { ok: true, message: `Cloned ${srcName} to ${newName}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const snapListMatch = pathname.match(/^\/api\/instances\/([^/]+)\/snapshots$/);
  if (snapListMatch && req.method === 'GET') {
    try { return json(res, 200, await getSnapshots(snapListMatch[1])); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (snapListMatch && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      // コメント由来のスナップショット名は英数字・-_ のみに正規化する。
      // '/' や '..' が混入すると `lxc delete <inst>/<snap>` のパス解釈が壊れるため。
      const safeComment = String(body.comment || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
      const snap = `snap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${safeComment ? '-' + safeComment : ''}`;
      await lxc('snapshot', snapListMatch[1], snap);
      return json(res, 200, { ok: true, message: `Snapshot ${snap} created`, name: snap });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const snapRestoreMatch = pathname.match(/^\/api\/instances\/([^/]+)\/snapshots\/([^/]+)\/restore$/);
  if (snapRestoreMatch && req.method === 'POST') {
    try {
      const [, instName, snapName] = snapRestoreMatch;
      const snapRaw = await lxdApi('GET', `/1.0/instances/${instName}/snapshots/${snapName}`);
      const snapMeta = snapRaw.metadata || snapRaw;
      const snapDevices = snapMeta.devices || {};
      const snapConfig = snapMeta.config || {};

      let wasRunning = false;
      try {
        const { stdout } = await lxc('info', instName);
        wasRunning = /Status:\s*RUNNING/.test(stdout);
      } catch (e) {}

      if (wasRunning) {
        await lxc('stop', instName, '--force');
      }
      await lxc('restore', instName, snapName);

      const inst = await lxdGetInstance(instName);
      const currentDevices = inst.devices || {};
      const currentConfig = inst.config || {};
      const needsUpdate = JSON.stringify(snapDevices) !== JSON.stringify(currentDevices)
                       || JSON.stringify(snapConfig) !== JSON.stringify(currentConfig);
      if (needsUpdate) {
        await lxdUpdateInstance(instName, { devices: snapDevices, config: snapConfig });
      }

      if (wasRunning) {
        await lxc('start', instName);
      }
      return json(res, 200, { ok: true, message: `Restored ${instName} from ${snapName}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const snapDeleteMatch = pathname.match(/^\/api\/instances\/([^/]+)\/snapshots\/([^/]+)$/);
  if (snapDeleteMatch && req.method === 'DELETE') {
    try { await lxc('delete', `${snapDeleteMatch[1]}/${snapDeleteMatch[2]}`); return json(res, 200, { ok: true, message: `Deleted snapshot ${snapDeleteMatch[2]}` }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/images' && req.method === 'GET') {
    try { return json(res, 200, { images: getImages(), cached: !!cachedImages }); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/images/refresh' && req.method === 'POST') {
    try { return json(res, 200, { images: await refreshImages() }); } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/gpus' && req.method === 'GET') {
    try {
      const resources = await lxdApi('GET', '/1.0/resources?recursion=1');
      const gpus = (resources.gpu || []).map(gpu => ({ pci: gpu.pci_address || '', desc: `${gpu.vendor || ''} ${gpu.product || ''}`.trim(), vendor: gpu.vendor || '', product: gpu.product || '', driver: gpu.driver || '', driverVersion: gpu.driver_version || '', numaNode: gpu.numa_node })).filter(g => g.pci);
      if (gpus.length === 0) {
        const { stdout } = await run('lspci', ['-Dnn']);
        stdout.split('\n').filter(l => /VGA compatible controller|3D controller|Display controller/i.test(l)).forEach(line => {
          const match = line.match(/^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d)\s+(.*)/);
          if (match) gpus.push({ pci: match[1], desc: match[2], vendor: '', product: '', driver: '', driverVersion: '' });
        });
      }
      return json(res, 200, { gpus });
    } catch (e) {
      try {
        const { stdout } = await run('lspci', ['-Dnn']);
        const gpus = stdout.split('\n').filter(l => /VGA compatible controller|3D controller|Display controller/i.test(l)).map(line => {
          const match = line.match(/^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d)\s+(.*)/);
          return match ? { pci: match[1], desc: match[2], vendor: '', product: '', driver: '', driverVersion: '' } : null;
        }).filter(Boolean);
        return json(res, 200, { gpus });
      } catch (e2) { return json(res, 500, { error: e2.message }); }
    }
  }

  const gpuAddMatch = pathname.match(/^\/api\/instances\/([^/]+)\/gpu\/add$/);
  if (gpuAddMatch && req.method === 'POST') {
    const [, name] = gpuAddMatch;
    try {
      const body = await parseBody(req);
      if (!body.pci) return json(res, 400, { error: 'pci address is required' });
      const inst = await lxdGetInstance(name);
      const devices = inst.devices || {};
      let devName = 'gpu0'; let n = 0;
      while (devices[`gpu${n}`]) n++; devName = `gpu${n}`;
      await lxdUpdateInstance(name, { devices: { ...devices, [devName]: { type: 'gpu', gputype: 'physical', pci: body.pci } } });
      return json(res, 200, { ok: true, message: `GPU ${body.pci} added as ${devName}`, deviceName: devName });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const gpuRemoveMatch = pathname.match(/^\/api\/instances\/([^/]+)\/gpu\/remove$/);
  if (gpuRemoveMatch && req.method === 'POST') {
    const [, name] = gpuRemoveMatch;
    try {
      const body = await parseBody(req);
      if (!body.deviceName) return json(res, 400, { error: 'deviceName is required' });
      const inst = await lxdGetInstance(name);
      const devices = inst.devices || {};
      if (!devices[body.deviceName]) return json(res, 400, { error: `Device ${body.deviceName} not found` });
      const newDevices = { ...devices }; delete newDevices[body.deviceName];
      await lxdUpdateInstance(name, { devices: newDevices });
      return json(res, 200, { ok: true, message: `GPU device ${body.deviceName} removed` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // --- マウントデバイス (disk デバイス) の追加・編集 ---
  const mountAddMatch = pathname.match(/^\/api\/instances\/([^/]+)\/mount\/add$/);
  if (mountAddMatch && req.method === 'POST') {
    const [, name] = mountAddMatch;
    try {
      const body = await parseBody(req);
      // 末尾スラッシュは正規化しておく（デバイス名生成と重複判定の一貫性のため）。
      const normalize = p => { const s = String(p || '').trim(); return s.length > 1 ? s.replace(/\/+$/, '') : s; };
      const source = normalize(body.source);
      const targetPath = normalize(body.path);
      if (!source.startsWith('/') || !targetPath.startsWith('/')) return json(res, 400, { error: 'source/path は / から始まる絶対パスで指定してください' });
      // コンテナのルート (/) へのマウントはコンテナを破壊するため拒否する。
      if (targetPath === '/') return json(res, 400, { error: 'コンテナ側パスに / (ルート) は指定できません' });
      let wasRunning = false;
      try { const { stdout } = await lxc('info', name); wasRunning = /Status:\s*RUNNING/.test(stdout); } catch (e) {}
      // raw.idmap の変更は停止状態でしか適用できないため、稼働中は一旦停止する。
      // 終了後は自動で起動し直すので再起動確認は不要になる。
      let stoppedByUs = false;
      if (wasRunning) {
        try { await lxc('stop', name); stoppedByUs = true; } catch (e) { if (!/already stopped/i.test(e.message)) throw e; }
      }
      const inst = await lxdGetInstance(name);
      const devices = { ...(inst.devices || {}) };
      let devName = String(body.deviceName || '').trim();
      if (devName && !devices[devName]) devName = ''; // 編集指定だが既に削除済みの場合は新規扱い
      if (!devName) {
        // コンテナ側パスからデバイス名を自動生成（例: /opt/lxd-data → opt-lxd-data）
        const base = targetPath.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'disk';
        devName = base; let n = 2;
        while (devices[devName]) devName = `${base}${n++}`;
      }
      devices[devName] = { type: 'disk', source, path: targetPath };
      // マッピング文字を合わせる: 既存コンテナでも作成時フローと同じ raw.idmap
      // (UID/GID 1000 → 1000) を必ず通す。ホスト側 1000 所有のファイルが
      // コンテナ内から書き込めるようになる。
      const config = inst.config || {};
      const idmapLines = String(config['raw.idmap'] || '').split('\n').map(s => s.trim()).filter(Boolean);
      const has1000Map = idmapLines.some(l => l.split(/\s+/).filter(p => p === '1000').length >= 2);
      if (!has1000Map) {
        idmapLines.push('both 1000 1000');
        await lxc('config', 'set', name, 'raw.idmap', idmapLines.join('\n'));
      }
      await lxdUpdateInstance(name, { devices });
      if (stoppedByUs) {
        await lxc('start', name);
        await waitRunning(name);
      }
      return json(res, 200, { ok: true, message: `${source} → ${targetPath} をデバイス ${devName} として設定しました`, deviceName: devName, running: stoppedByUs ? false : wasRunning });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const mountRemoveMatch = pathname.match(/^\/api\/instances\/([^/]+)\/mount\/remove$/);
  if (mountRemoveMatch && req.method === 'POST') {
    const [, name] = mountRemoveMatch;
    try {
      const body = await parseBody(req);
      if (!body.deviceName) return json(res, 400, { error: 'deviceName is required' });
      let wasRunning = false;
      try { const { stdout } = await lxc('info', name); wasRunning = /Status:\s*RUNNING/.test(stdout); } catch (e) {}
      const inst = await lxdGetInstance(name);
      const devices = inst.devices || {};
      if (!devices[body.deviceName] || devices[body.deviceName].type !== 'disk') return json(res, 404, { error: `Disk device ${body.deviceName} not found` });
      const newDevices = { ...devices }; delete newDevices[body.deviceName];
      await lxdUpdateInstance(name, { devices: newDevices });
      return json(res, 200, { ok: true, message: `マウントデバイス ${body.deviceName} を取り外しました`, running: wasRunning });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // --- アプリ一覧 ---
  // 登録情報は apps.json に永続化する（ランタイムデータのためリポジトリ外管理）。
  // アプリの追加は APP_REGISTRY にエントリを足すだけでよい。
  // installCmds は対象コンテナ内で順に実行されるコマンド列（lxc exec の作業ディレクトリは /root）。
  const APPS_FILE = path.join(__dirname, 'apps.json');
  const APP_REGISTRY = {
    selfexplorer: {
      label: 'SelfExplorer',
      installDir: '/opt/selfexplorer',
      port: 3346,
      installCmds: ['sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/hirogura/selfexplorer/main/install-selfexplorer1.sh)"']
    },
    selfnote: {
      label: 'SelfNote',
      installDir: '/opt/selfnote',
      port: 3342,
      installCmds: ['sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/hirogura/selfnote/main/install-selfnote.sh)"']
    },
    selfrss: {
      label: 'selfrss',
      installDir: '/opt/selfrss',
      port: 3347,
      installCmds: [
        // 再インストールに備え clone 先を初期化してから指定コマンドを実行する。
        'rm -rf selfrss',
        'git clone https://github.com/hirogura/selfrss.git',
        'cd selfrss',
        'sudo bash install-selfrss1.sh'
      ]
    },
    selfmark: {
      label: 'selfmark',
      // インストール先は /opt/lxd-data（ブラウズ共有領域）配下なので注意。
      installDir: '/opt/lxd-data/selfmark',
      port: 3356,
      installCmds: [
        'curl -fsSL -o install-selfmark1.sh https://raw.githubusercontent.com/hirogura/selfmark/main/install-selfmark1.sh',
        'sudo bash install-selfmark1.sh'
      ]
    },
    selfphoto: {
      label: 'selfphoto',
      installDir: '/opt/selfphoto',
      port: 3360,
      installCmds: [
        // 再インストールに備え clone 先を初期化してから指定コマンドを実行する。
        'cd /opt',
        'rm -rf selfphoto',
        'git clone https://github.com/hirogura/selfphoto.git',
        'cd selfphoto',
        'sudo ./install.sh'
      ]
    },
    spw: {
      label: 'SPW',
      installDir: '/opt/lxd-data/spw',
      // アプリ本体は3345で待機し、Tailscale Serve (HTTPS) が3344で公開する。
      port: 3344,
      installCmds: [
        'curl -fsSL https://raw.githubusercontent.com/hirogura/spw/main/install-spw.sh -o install-spw.sh',
        'sudo bash install-spw.sh'
      ]
    },
    rclonegui: {
      label: 'rcloneGUI',
      installDir: '/opt/rclonegui',
      port: 3348,
      installCmds: [
        'curl -fsSL https://raw.githubusercontent.com/hirogura/rclonegui/main/install-rclonegui.sh -o install-rclonegui.sh',
        'sudo bash install-rclonegui.sh'
      ]
    },
    rsyncgui: {
      label: 'rsyncGUI',
      installDir: '/opt/rsyncgui',
      port: 3326,
      installCmds: ['curl -fsSL https://raw.githubusercontent.com/hirogura/rsyncgui/main/install-rsyncgui.sh | sudo bash']
    },
    taildropweb: {
      label: 'Taildrop Web',
      installDir: '/opt/taildrop-web',
      port: 3349,
      installCmds: ['sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/hirogura/taildropweb/main/install-taildropweb.sh)"']
    },
    immich: {
      label: 'immich',
      installDir: '/opt/docker/immich',
      // アプリ本体は2283で待機し、Tailscale Serve (HTTPS) が3307で公開する。
      // Docker Compose 必須のため requiresDocker を付ける。
      port: 3307,
      requiresDocker: true,
      installCmds: [
        'curl -fsSL -o /tmp/install-immich.sh https://raw.githubusercontent.com/hirogura/scripts/main/install-immich.sh',
        'sudo bash /tmp/install-immich.sh'
      ]
    }
  };

  function readApps() {
    try { return JSON.parse(fs.readFileSync(APPS_FILE, 'utf-8')); } catch (e) { return {}; }
  }
  function writeApps(apps) {
    fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2) + '\n');
  }
  // インストール済み判定はアプリごとのインストールディレクトリの有無で行う。
  async function isAppInstalled(name, cfg) {
    try {
      await lxcExec(name, `test -d ${cfg.installDir}`, 15000);
      return true;
    } catch (e) { return false; }
  }

  // コンテナ内の Tailscale に問合わせて Self の MagicDNS 名を取得する。
  // tailnet ドメインは環境ごとに異なるためクライアント側へは生成済み URL のみ返す。
  async function getTailscaleDnsName(name) {
    try {
      const { stdout } = await lxcExec(name, 'tailscale status --json', 15000);
      const ts = JSON.parse(stdout);
      return ((((ts || {}).Self || {}).DNSName) || '').replace(/\.$/, '');
    } catch (e) { return ''; }
  }

  if (pathname === '/api/apps' && req.method === 'GET') {
    try {
      const apps = readApps();
      let instanceNames = new Set();
      try { instanceNames = new Set((await getInstances()).map(i => i.name)); } catch (e) {}
      // 削除済みインスタンスの登録は自動的に掃除する。
      let dirty = false;
      for (const appId of Object.keys(APP_REGISTRY)) {
        const before = apps[appId] || [];
        const after = before.filter(c => instanceNames.has(c));
        if (after.length !== before.length) { apps[appId] = after; dirty = true; }
      }
      if (dirty) writeApps(apps);
      // 稼働中のコンテナのみインストール状態を確認（停止中は exec できないため null）。
      const result = await Promise.all(Object.entries(APP_REGISTRY).map(async ([appId, cfg]) => {
        const containers = await Promise.all((apps[appId] || []).map(async name => {
          const inst = await getInstance(name).catch(() => null);
          const running = !!inst && inst.status === 'Running';
          const installed = running ? await isAppInstalled(name, cfg) : null;
          const dns = running && installed ? await getTailscaleDnsName(name) : '';
          return { container: name, running, installed, url: dns ? `https://${dns}:${cfg.port}/` : null };
        }));
        return { id: appId, label: cfg.label, requiresDocker: !!cfg.requiresDocker, containers };
      }));
      return json(res, 200, { apps: result, dockerContainers: await getDockerContainers() });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const appActionMatch = pathname.match(/^\/api\/apps\/([^/]+)\/(register|install\/stream)$/);
  if (appActionMatch && appActionMatch[2] === 'register' && req.method === 'POST') {
    try {
      const [, appId] = appActionMatch;
      const cfg = APP_REGISTRY[appId];
      if (!cfg) return json(res, 404, { error: `Unknown app: ${appId}` });
      const body = await parseBody(req);
      if (!body.container) return json(res, 400, { error: 'container is required' });
      await getInstance(body.container); // 存在チェック
      const apps = readApps();
      const list = new Set(apps[appId] || []);
      list.add(body.container);
      apps[appId] = [...list];
      writeApps(apps);
      return json(res, 200, { ok: true, message: `${body.container} を ${cfg.label} に登録しました` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  if (appActionMatch && appActionMatch[2] === 'install/stream' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n');
    const send = (evt, data) => { try { res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
    try {
      const [, appId] = appActionMatch;
      const cfg = APP_REGISTRY[appId];
      if (!cfg) throw new Error(`Unknown app: ${appId}`);
      const body = await parseBody(req);
      if (!body.container) { send('error', { error: 'container is required' }); res.end(); return; }
      await getInstance(body.container);
      send('log', { message: `=== ${body.container} へ ${cfg.label} をインストール開始 ===` });
      cfg.installCmds.forEach(l => send('log', { message: `$ ${l}` }));
      await lxcExec(body.container, cfg.installCmds.join('\n'), 1800000, streamToLog(msg => send('log', { message: msg })));
      const installed = await isAppInstalled(body.container, cfg);
      send('done', { message: installed ? `${cfg.label} のインストールが完了しました` : `スクリプトは終了しましたが ${cfg.installDir} が見つかりません` });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    return;
  }

  // --- KonomiTV (DTV) セットアップ ---
  // ほかのアプリと異なりコンテナ選択を行わない専用フロー。
  // ホスト側スクリプト (Ubuntu・Debian用 tuner-lxd.sh / CachyOS・Arch用
  // tuner-lxd-cachyos.sh) は対話式（y/n プロンプト・コンテナ名/authkey 入力）のため、
  // セクション見出しコメントを境界に awk で分割し、
  //   stage1 = ドライバ部分（セクション1まで）  …「px4_drvインストール」ボタン
  //   stage2 = 残り（セクション2以降・プロローグ再結合） …「コンテナ作成」ボタン
  // として実行する。対話への回答は標準入力ファイル経由で与える
  // （authkey もファイル経由のためログには流れない）。
  // 両スクリプトのセクション見出しは同一のため、分割用 awk は共通で使える。
  const DTV_REPO_URL = 'https://github.com/hirogura/mirakc-edcb-konomitv.git';
  const DTV_MANAGE_URL = 'https://raw.githubusercontent.com/hirogura/mirakc-edcb-konomitv/main/install-dtv-manage.sh';
  // 分割位置は tuner-lxd.sh / tuner-lxd-cachyos.sh のセクション見出しコメントで判定（index で前方一致比較）。
  const DTV_AWK_STAGE1 = 'index($0,"# 2. コンテナ名の入力")==1{exit}\n{print}';
  const DTV_AWK_STAGE2 = [
    'index($0,"# 1. チューナードライバのインストール")==1{skip=1}',
    'index($0,"# 2. コンテナ名の入力")==1{skip=0}',
    'skip!=1{print}'
  ].join('\n');
  // tuner-lxd.sh の対話プロンプト (read) を横取りし、あらかじめ用意した回答キューから
  // 1行ずつ返すランナー。stdin を /dev/null に保って実行することで、回答ファイルを
  // 標準入力に流す方式で起きていた「残りの回答行が lxc コマンドの YAML 設定入力と
  // して解釈される」問題 (api.InstancePut unmarshal エラー) を防ぐ。
  const DTV_RUNNER_B64 = Buffer.from([
    '#!/bin/bash',
    'set -euo pipefail',
    'mapfile -t DTV_QUEUE < "$DTV_ANSWERS"',
    'DTV_QIDX=0',
    'read() {',
    '  local var=""',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      -*p*) shift; shift ;;',
    '      -*) shift ;;',
    '      *) var="$1"; break ;;',
    '    esac',
    '  done',
    '  if [ "$DTV_QIDX" -ge "${#DTV_QUEUE[@]}" ]; then return 1; fi',
    "  printf -v \"$var\" '%s' \"${DTV_QUEUE[$DTV_QIDX]}\"",
    '  DTV_QIDX=$((DTV_QIDX + 1))',
    '}',
    '. "$DTV_STAGE"',
    'exit 0'
  ].join('\n'), 'utf-8').toString('base64');
  const DTV_STATE_FILE = path.join(__dirname, 'dtv.json');

  function readDtvState() {
    try { return JSON.parse(fs.readFileSync(DTV_STATE_FILE, 'utf-8')); } catch (e) { return {}; }
  }
  function writeDtvState(st) {
    fs.writeFileSync(DTV_STATE_FILE, JSON.stringify(st, null, 2) + '\n');
  }

  if (pathname === '/api/dtv/status' && req.method === 'GET') {
    try {
      const st = readDtvState();
      const name = st.container || null;
      let exists = false;
      let manageInstalled = false;
      if (name) {
        const inst = await getInstance(name).catch(() => null);
        exists = !!inst;
        // DTV管理ダッシュボードのインストール済み判定は /opt/dtv-manage の有無。
        // 稼働中コンテナのみ確認（停止中は exec できないため false）。
        if (inst && inst.status === 'Running') {
          try { await lxcExec(name, 'test -d /opt/dtv-manage', 15000); manageInstalled = true; } catch (e) {}
        }
      }
      return json(res, 200, { container: name, exists, manageInstalled });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 「対象コンテナ変更」: 稼働中コンテナを指定して dtv.json の対象コンテナを差し替える。
  // TunerOK スナップショットから復元済みの既存コンテナに対して、
  // アプリインストール以降のステップを実行できるようにするためのもの。
  if (pathname === '/api/dtv/container/select' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const name = String(body.container || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return json(res, 400, { error: 'コンテナ名が不正です' });
      const inst = await getInstance(name).catch(() => null);
      if (!inst) return json(res, 404, { error: `インスタンス ${name} が見つかりません` });
      const st = readDtvState();
      const prev = st.container || null;
      st.container = name;
      writeDtvState(st);
      return json(res, 200, { ok: true, message: prev === name ? `対象コンテナはすでに ${name} です` : `対象コンテナを ${prev ? prev + ' から ' + name : name} に変更しました`, container: name });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 「px4_drvインストール」ボタン: ~/dtv にリポジトリを取得し、ホスト OS に合った
  // スクリプト (CachyOS/Arch: tuner-lxd-cachyos.sh / Ubuntu/Debian: tuner-lxd.sh)
  // のドライバ部分のみホスト上で実行する。対話プロンプトには全て y で回答する
  // （既存ドライバの再利用 / 新バージョンの取得、どちらの分岐でも最新側を選択。
  //  CachyOS 版でカーネルヘッダが無い場合の導入確認にも y で回答する）。
  if (pathname === '/api/dtv/driver/stream' && req.method === 'POST') {
    const send = sseStart(res);
    try {
      send('log', { message: '=== KonomiTV セットアップ (1/4): px4_drv ドライバのインストール ===' });
      const script = [
        'set -euo pipefail',
        '# snap 版 lxc が /snap/bin にある環境 (Ubuntu) 向けに PATH を通す (存在しない環境では無害)',
        '[ -d /snap/bin ] && export PATH="/snap/bin:$PATH"',
        // systemd 経由の起動では HOME が未設定のため /root にフォールバックする。
        'DTV_DIR="${HOME:-/root}/dtv"',
        'if [ -d "$DTV_DIR/.git" ]; then',
        '  echo "既存のリポジトリを最新化中..."',
        '  git -C "$DTV_DIR" fetch origin main',
        '  git -C "$DTV_DIR" reset --hard origin/main',
        'else',
        `  git clone ${DTV_REPO_URL} "$DTV_DIR"`,
        'fi',
        'cd "$DTV_DIR"',
        // ホスト OS に合ったドライバ導入スクリプトを選択する。
        'if command -v pacman >/dev/null 2>&1; then',
        '  DTV_SCRIPT="tuner-lxd-cachyos.sh"',
        'elif command -v apt-get >/dev/null 2>&1; then',
        '  DTV_SCRIPT="tuner-lxd.sh"',
        'else',
        '  echo "ERROR: pacman / apt-get のどちらも無いため px4_drv を導入できません。"',
        '  exit 1',
        'fi',
        'echo "使用スクリプト: $DTV_SCRIPT"',
        'test -f "$DTV_SCRIPT" || { echo "ERROR: $DTV_SCRIPT がリポジトリに見つかりません"; exit 1; }',
        'STAGE=$(mktemp /tmp/easylxd-dtv-stage1.XXXXXXXX.sh)',
        'RUNNER=$(mktemp /tmp/easylxd-dtv-runner.XXXXXXXX.sh)',
        'ANSWERS=$(mktemp /tmp/easylxd-dtv-answer.XXXXXXXX.txt)',
        'chmod 600 "$ANSWERS"',
        "trap 'rm -f \"$STAGE\" \"$RUNNER\" \"$ANSWERS\"' EXIT",
        `awk '${DTV_AWK_STAGE1}' "$DTV_SCRIPT" > "$STAGE"`,
        'grep -q px4_drv "$STAGE" || { echo "ERROR: $DTV_SCRIPT からドライバ部分を抽出できませんでした"; exit 1; }',
        'if grep -q "コンテナ名を入力" "$STAGE"; then echo "ERROR: $DTV_SCRIPT の分割に失敗しました"; exit 1; fi',
        `echo ${DTV_RUNNER_B64} | base64 -d > "$RUNNER"`,
        // 対話プロンプト（ドライバインストール可否・既存ドライバ再利用/新バージョン取得・
        // CachyOS 版のカーネルヘッダ導入確認）には y で回答。
        "printf 'y\\ny\\ny\\n' > \"$ANSWERS\"",
        'echo "--- $DTV_SCRIPT のドライバ部分を実行 ---"',
        'DTV_ANSWERS="$ANSWERS" DTV_STAGE="$STAGE" bash "$RUNNER" < /dev/null',
        'echo "px4_drv ドライバのインストールが完了しました"'
      ].join('\n');
      await run('bash', ['-c', script], 1800000, streamToLog(msg => send('log', { message: msg })));
      send('done', { message: 'ドライバインストール完了 — 続いて「コンテナ作成」を実行してください' });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    return;
  }

  // 「コンテナ作成」ボタン: driver ステップの続きとして tuner-lxd.sh の残りを実行する。
  // 回答の並びはスクリプトの読み込み順どおり:
  //   コンテナ名 → authkey 有無 → authkey → TailscaleOK → USBパススルー → TunerOK
  //   → 「今すぐインストールスクリプトを実行」は n（後続の「アプリインストール」ボタンで実施）
  if (pathname === '/api/dtv/container/stream' && req.method === 'POST') {
    const send = sseStart(res);
    try {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('コンテナ名が不正です（英数字と - _ のみ使用可）');
      const useAuthkey = !!body.useAuthkey;
      const authkey = String(body.authkey || '').replace(/[\r\n]/g, '').trim();
      if (useAuthkey && !authkey) throw new Error('Tailscale の authkey が入力されていません');
      const snapTs = body.snapTailscale === false ? 'n' : 'y';
      const usbPass = body.usbPassthrough === false ? 'n' : 'y';
      const snapTuner = body.snapTuner === false ? 'n' : 'y';
      send('log', { message: `=== KonomiTV セットアップ (2/4): コンテナ '${name}' の作成 ===` });
      const script = [
        'set -euo pipefail',
        '# snap 版 lxc が /snap/bin にある環境 (Ubuntu) 向けに PATH を通す (存在しない環境では無害)',
        '[ -d /snap/bin ] && export PATH="/snap/bin:$PATH"',
        // systemd 経由の起動では HOME が未設定のため /root にフォールバックする。
        'DTV_DIR="${HOME:-/root}/dtv"',
        // ホスト OS に合ったスクリプトを使う (driver ステップと同じ選択)。
        // コンテナ作成以降は LXD 操作のため OS 非依存だが、スクリプト側の
        // 前提チェック (セクション0) が OS 別になっているため合わせる。
        'if command -v pacman >/dev/null 2>&1; then',
        '  DTV_SCRIPT="tuner-lxd-cachyos.sh"',
        'elif command -v apt-get >/dev/null 2>&1; then',
        '  DTV_SCRIPT="tuner-lxd.sh"',
        'else',
        '  echo "ERROR: pacman / apt-get のどちらも無いためコンテナ作成スクリプトを実行できません。"',
        '  exit 1',
        'fi',
        // 片方しか無いリポジトリ状態に備えてフォールバックする。
        '[ -f "$DTV_DIR/$DTV_SCRIPT" ] || DTV_SCRIPT="tuner-lxd.sh"',
        '[ -f "$DTV_DIR/$DTV_SCRIPT" ] || DTV_SCRIPT="tuner-lxd-cachyos.sh"',
        'if [ ! -f "$DTV_DIR/$DTV_SCRIPT" ]; then',
        '  echo "ERROR: $DTV_DIR に tuner-lxd.sh / tuner-lxd-cachyos.sh が見つかりません。先に「px4_drvインストール」を実行してください。"',
        '  exit 1',
        'fi',
        'echo "使用スクリプト: $DTV_SCRIPT"',
        'cd "$DTV_DIR"',
        // カーネル更新後の未再起動では veth が作れず lxc launch が eth0 開始エラーになる。
        // 外部スクリプトの cryptic な失敗の前に分かりやすいメッセージで止める。
        'KVER="$(uname -r)"',
        'if [ ! -d "/lib/modules/$KVER" ]; then',
        '  echo "ERROR: 実行中カーネル ($KVER) 用のモジュールが見つかりません。カーネル更新後に再起動していない可能性があります。ホストを再起動 (sudo reboot) してから再試行してください。"',
        '  exit 1',
        'fi',
        'STAGE=$(mktemp /tmp/easylxd-dtv-stage2.XXXXXXXX.sh)',
        'RUNNER=$(mktemp /tmp/easylxd-dtv-runner.XXXXXXXX.sh)',
        'ANSWERS=$(mktemp /tmp/easylxd-dtv-answer.XXXXXXXX.txt)',
        'chmod 600 "$ANSWERS"',
        "trap 'rm -f \"$STAGE\" \"$RUNNER\" \"$ANSWERS\"' EXIT",
        `awk '${DTV_AWK_STAGE2}' "$DTV_SCRIPT" > "$STAGE"`,
        'grep -q "コンテナ名を入力" "$STAGE" || { echo "ERROR: $DTV_SCRIPT からコンテナ作成部分を抽出できませんでした"; exit 1; }',
        // セクション1 (ドライバ) の見出しが残っていたら分割失敗。
        // 文字列 px4_drv 自体では判定しない (cachyos 版の先頭コメントに由来が書かれているため)。
        'if grep -q "# 1. チューナードライバのインストール" "$STAGE"; then echo "ERROR: $DTV_SCRIPT の分割に失敗しました"; exit 1; fi',
        `echo ${DTV_RUNNER_B64} | base64 -d > "$RUNNER"`,
        '{',
        '  printf \'%s\\n\' "$DTV_NAME"',
        '  printf \'%s\\n\' "$DTV_USEKEY"',
        '  if [ "$DTV_USEKEY" = "y" ]; then printf \'%s\\n\' "$DTV_AUTHKEY"; fi',
        '  printf \'%s\\n\' "$DTV_SNAPTS" "$DTV_USB" "$DTV_SNAPTUNER" n',
        '} > "$ANSWERS"',
        'echo "--- コンテナ作成・マウント・Tailscale・スナップショット設定 ---"',
        'DTV_ANSWERS="$ANSWERS" DTV_STAGE="$STAGE" bash "$RUNNER" < /dev/null',
        // LXD の raw.idmap "both 1000 1000" によりホスト側 root (UID 0) が
        // コンテナ内 nobody にマッピングされ、バックアップ先に書き込めなくなる。
        // tuner-lxd.sh が作成する /opt/lxd-data/konomitv-backup の権限を緩和する。
        'chmod 777 /opt/lxd-data/konomitv-backup 2>/dev/null || true',
        'echo "コンテナ作成ステップが完了しました"'
      ].join('\n');
      await run('bash', ['-c', script], 3600000, streamToLog(msg => send('log', { message: msg }), ''), {
        DTV_NAME: name,
        DTV_USEKEY: useAuthkey ? 'y' : 'n',
        DTV_AUTHKEY: authkey,
        DTV_SNAPTS: snapTs,
        DTV_USB: usbPass,
        DTV_SNAPTUNER: snapTuner
      });
      try {
        send('log', { message: 'タイムゾーンを JST (Asia/Tokyo) に設定中...' });
        await lxcExec(name, 'sudo timedatectl set-timezone Asia/Tokyo', 60000, streamToLog(msg => send('log', { message: msg }), ''));
        send('log', { message: 'タイムゾーン設定完了' });
      } catch (e) {
        send('log', { message: `WARNING: タイムゾーン設定に失敗しました（作成は継続します）: ${e.message}` });
      }
      const st = readDtvState(); st.container = name; writeDtvState(st);
      send('done', { message: `コンテナ '${name}' の作成完了 — 続いて「アプリインストール」を実行してください` });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    return;
  }

  // 「DTV管理」ボタン: コンテナ内で dtv-manage ダッシュボードのインストーラを実行する。
  if (pathname === '/api/dtv/manage/stream' && req.method === 'POST') {
    const send = sseStart(res);
    try {
      const body = await parseBody(req);
      const st = readDtvState();
      const container = String(body.container || st.container || '').trim();
      if (!container) throw new Error('対象コンテナが不明です。先に「コンテナ作成」を実行してください。');
      const inst = await getInstance(container);
      if (inst.status !== 'Running') throw new Error(`コンテナ ${container} が停止しています`);
      send('log', { message: `=== KonomiTV セットアップ (4/4): ${container} に DTV管理ダッシュボードをインストール ===` });
      const cmd = `bash <(curl -fsSL ${DTV_MANAGE_URL})`;
      send('log', { message: `$ lxc exec ${container} -- bash -c "${cmd}"` });
      await lxcExec(container, cmd, 1800000, streamToLog(msg => send('log', { message: msg })));
      send('done', { message: `DTV管理ダッシュボードのインストール完了 — 「DTV管理」ボタンが http://${container}/ へのリンクに変わりました` });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    return;
  }

  // 「バックアップをインポート」: DTV管理ダッシュボードがエクスポートした
  // konomitv-backup-日付.tar.gz を /opt/lxd-data/konomitv-backup へ展開する。
  // 既存バックアップは上書き（置き換え）する。
  if (pathname === '/api/dtv/backup/import' && req.method === 'POST') {
    const send = sseStart(res);
    // 大容量でもメモリに載せないよう /tmp の一時ファイルへストリーミング受信する。
    const tmpPath = path.join('/tmp', `konomitv-backup-import-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tar.gz`);
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        req.on('data', c => out.write(c));
        req.on('end', () => out.end(resolve));
        req.on('error', reject);
        out.on('error', reject);
      });
      send('log', { message: '=== KonomiTV バックアップをインポート ===' });
      send('log', { message: 'アップロードを受信しました。展開を開始します...' });
      const script = [
        'set -euo pipefail',
        `TMP=${JSON.stringify(tmpPath)}`,
        'STAGE=$(mktemp -d /tmp/konomitv-stage.XXXXXXXX)',
        'trap \'rm -rf "$STAGE" "$TMP"\' EXIT',
        // gzip の tar であることと読み取り可能性を先に検証する。
        'tar -tzf "$TMP" >/dev/null',
        // パストラバーサル（絶対パス / 親ディレクトリ参照）をはじく。
        'if tar -tzf "$TMP" | grep -qE "(^/|(^|/)\\.\\.(/|$))"; then echo "ERROR: 不正なパスが含まれているため中止します"; exit 1; fi',
        'tar -xzf "$TMP" -C "$STAGE"',
        'if [ -z "$(ls -A "$STAGE")" ]; then echo "ERROR: バックアップデータが含まれていません"; exit 1; fi',
        // アーカイブが konomitv-backup/ ディレクトリを直接含む形式にも対応する。
        'if [ -d "$STAGE/konomitv-backup" ] && [ "$(ls -A "$STAGE" | wc -l)" = 1 ]; then SRC="$STAGE/konomitv-backup"; else SRC="$STAGE"; fi',
        'echo "既存の /opt/lxd-data/konomitv-backup を上書きします..."',
        'rm -rf /opt/lxd-data/konomitv-backup',
        'mkdir -p /opt/lxd-data/konomitv-backup',
        'cp -a "$SRC"/. /opt/lxd-data/konomitv-backup/',
        // コンテナ内から書き込めるよう作成時と同じ権限に揃える。
        // LXD の非特権コンテナではコンテナ内 root がホスト上 1000000 と表示されるため、
        // バックアップをコンテナが作成した場合と同じ所有権 (1000000:1000000) に合わせる。
        'chmod 777 /opt/lxd-data/konomitv-backup',
        'chown -R 1000000:1000000 /opt/lxd-data/konomitv-backup',
        'echo "インポート完了: /opt/lxd-data/konomitv-backup"'
      ].join('\n');
      await run('bash', ['-c', script], 1800000, streamToLog(msg => send('log', { message: msg })));
      send('done', { message: 'バックアップのインポートが完了しました' });
    } catch (e) {
      send('error', { error: e.message });
    } finally {
      try { out.destroy(); } catch (_) {}
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      res.end();
    }
    return;
  }
  const SECURITY_KEYS = { nesting: 'security.nesting', privileged: 'security.privileged' };
  const securityMatch = pathname.match(/^\/api\/instances\/([^/]+)\/security$/);
  if (securityMatch && req.method === 'POST') {
    const [, name] = securityMatch;
    try {
      const body = await parseBody(req);
      const lxdKey = SECURITY_KEYS[body.key];
      if (!lxdKey) return json(res, 400, { error: 'key must be one of: nesting, privileged' });
      if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
      // 特権設定は次回起動時から反映されるため、起動中の場合は再起動を促すメッセージを返す。
      let wasRunning = false;
      try { const { stdout } = await lxc('info', name); wasRunning = /Status:\s*RUNNING/.test(stdout); } catch (e) {}
      if (body.enabled) await lxc('config', 'set', name, lxdKey, 'true');
      else await lxc('config', 'unset', name, lxdKey);
      return json(res, 200, { ok: true, message: `${lxdKey} ${body.enabled ? 'allowed' : 'denied'} for ${name}`, running: wasRunning });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const SETUP_SCRIPT_URL = 'https://raw.githubusercontent.com/hirogura/easylxd/main/lxd-setup.sh';
  const APP_TARBALL_URL = 'https://github.com/hirogura/easylxd/archive/refs/heads/main.tar.gz';

  if (pathname === '/api/server/update/stream' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n');
    const send = (evt, data) => { try { res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
    // 一時ファイル名は mktemp でランダム生成し、多重実行やシンボリックリンク攻撃を防ぐ。
    // snap 版 lxc が /snap/bin にある環境 (Ubuntu) 向けに PATH を通す
    // (存在しない環境では無害。systemd 経由起動時に snap コマンドが
    // PATH 外になるケースがあるための措置)。
    const script = [
      'set -euo pipefail',
      '[ -d /snap/bin ] && export PATH="/snap/bin:$PATH"',
      'TMP=$(mktemp /tmp/lxd-setup.XXXXXXXX.sh)',
      'APP=$(mktemp /tmp/easylxd-app.XXXXXXXX.tar.gz)',
      'trap \'rm -f "$TMP" "$APP"\' EXIT',
      `curl -fsSL -o "$TMP" ${SETUP_SCRIPT_URL}`,
      'chmod +x "$TMP"',
      // --skip-pool: サーバアップデート時はプール関連の処理をスキップする。
      // default プールが /opt/lxd-pool 以外の環境でスクリプトを再実行すると
      // 既存プールの削除・再作成が走ってエラーになるため（初回インストール時のみ変更する）。
      // lxd-setup.sh 自体が OS 判別 (snap / pacman) を行うため、ここでの分岐は不要。
      '"$TMP" --skip-pool',
      `echo "EasyLXD 本体を最新版に更新中... (${APP_TARBALL_URL})"`,
      `curl -fsSL -o "$APP" ${APP_TARBALL_URL}`,
      // tarball が正規のアプリ内容か検証してから展開する
      // (リポジトリ未push時などの不完全な tarball による破壊を防ぐ)。
      'tar -tzf "$APP" | grep -q "server.js" || { echo "ERROR: tarball に server.js が含まれていません。リポジトリの push 状態を確認してください"; exit 1; }',
      // インストーラと同じく tarball を展開して上書きする。
      // 実行中の server.js はメモリ上で動き続けるため差し替えは安全。
      `tar -xzf "$APP" --strip-components=1 -C '${__dirname}'`,
      // npm 12+ では install scripts がブロックされるため承認を維持する。
      // (古い npm では install-scripts コマンドが無いため失敗しても無視する)
      `cd '${__dirname}' && npm install-scripts approve node-pty >/dev/null 2>&1 || true`,
      // 依存が変わっていない場合は即終了する。node-pty の再ビルドも不要。
      `cd '${__dirname}' && npm install --omit=dev --no-audit --no-fund`
    ].join('\n');
    try {
      send('log', { message: `最新のセットアップスクリプトをダウンロード中... (${SETUP_SCRIPT_URL})` });
      await run('bash', ['-c', script], 1800000, streamToLog(msg => send('log', { message: msg }), ''));
      send('done', { message: 'アップデート完了 — EasyLXD サービスを再起動します' });
    } catch (e) {
      send('error', { error: e.message });
    }
    res.end();
    // SSE 応答をクライアントへ返しきってから再起動する（再起動ボタンと同じ detached 手順）。
    setTimeout(() => {
      try { const c = spawn('systemctl', ['restart', 'easy-lxd'], { stdio: 'ignore', detached: true }); c.unref(); } catch (e) {}
    }, 2000);
    return;
  }

  if (pathname === '/api/server/reboot' && req.method === 'POST') {
    setTimeout(() => {
      try { const c = spawn('systemctl', ['restart', 'easy-lxd'], { stdio: 'ignore', detached: true }); c.unref(); } catch (e) {}
    }, 500);
    return json(res, 200, { ok: true, message: 'EasyLXD service restart scheduled' });
  }

  const termResetMatch = pathname.match(/^\/api\/terminal\/reset\/(.+)$/);
  if (termResetMatch && req.method === 'POST') {
    let instName = termResetMatch[1];
    try { instName = decodeURIComponent(instName); } catch (e) {}
    // 通常セッション (キー = インスタンス名) に加え、スクリプト実行セッション
    // (キー = "<name>::run:<hash>") も対象にする。run 付きで開いたターミナルは
    // 従来の完全一致では見つからずリセットできなかった。
    const keys = [...activeTerminals.keys()].filter(k => k === instName || k.startsWith(`${instName}::run:`));
    for (const k of keys) {
      const session = activeTerminals.get(k);
      if (!session) continue;
      for (const c of session.clients) {
        try { c.send(JSON.stringify({ type: 'exit' })); } catch (e) {}
      }
      killSession(session, k);
    }
    if (keys.length) {
      return json(res, 200, { ok: true, message: `Terminal session for ${instName} has been reset` });
    }
    return json(res, 200, { ok: true, message: `No active session for ${instName}` });
  }

  // --- アクティブなターミナルセッション一覧 ---
  // ターミナルは共有セッション（replay buffer 付き・最終切断後も SESSION_GRACE_MS 保持）のため、
  // 別 PC からでも同じキーで接続し直せばバッファ再生つきで合流できる。
  // tail にバッファ末尾を含めることで、接続せずとも進行状況を覗き見できるようにしている。
  if (pathname === '/api/terminals' && req.method === 'GET') {
    const sessions = [];
    for (const s of activeTerminals.values()) {
      sessions.push({
        instance: s.instanceName || null,
        runCmd: s.runCmd || null,
        clients: s.clients ? s.clients.size : 0,
        startedAt: s.startedAt || null,
        tail: s.buffer ? s.buffer.slice(-2000) : ''
      });
    }
    return json(res, 200, { sessions });
  }

  json(res, 404, { error: 'Not found' });
});

// --- WebSocket Terminal (shared sessions + replay buffer + session persistence) ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const instanceName = url.searchParams.get('instance');
  if (!instanceName) { ws.close(); return; }
  const cols = parseInt(url.searchParams.get('cols')) || 80;
  const rows = parseInt(url.searchParams.get('rows')) || 24;

  // run 指定時は通常シェルの代わりに指定コマンドをコンテナ内で実行する。
  // KonomiTV のインストールスクリプトのように B-CAS キー入力など対話操作が
  // 必要なスクリプト向け（通常のシェルセッションとは別キーで管理）。
  const runParam = url.searchParams.get('run');
  const runCmd = runParam ? Buffer.from(runParam, 'base64url').toString('utf-8') : null;
  const sessionKey = runCmd
    ? `${instanceName}::run:${crypto.createHash('sha256').update(runCmd).digest('hex').slice(0, 12)}`
    : instanceName;
  const ptyArgs = runCmd
    ? ['exec', instanceName, '--', 'bash', '-c', runCmd]
    : ['exec', instanceName, '--', '/bin/bash'];

  let session = activeTerminals.get(sessionKey);

  if (session) {
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null; }
    session.clients.add(ws);
    if (session.buffer) {
      ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
    }
    ws.send(JSON.stringify({ type: 'output', data: '\x1b[33m[セッションに再接続しました]\x1b[0m\r\n' }));
  } else {
    let term;
    try {
      term = pty.spawn('lxc', ptyArgs, {
        name: 'xterm-256color',
        cols, rows,
        cwd: process.env.HOME || '/root',
        env: { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' }
      });
    } catch (e) { ws.close(); return; }
    session = { term, clients: new Set([ws]), resizeTimeout: null, buffer: '', graceTimer: null, instanceName, runCmd, startedAt: Date.now() };
    activeTerminals.set(sessionKey, session);
    term.onData(data => {
      session.buffer += data;
      if (session.buffer.length > MAX_BUFFER) {
        session.buffer = session.buffer.slice(-MAX_BUFFER);
      }
      for (const c of session.clients) {
        try { c.send(JSON.stringify({ type: 'output', data })); } catch (e) {}
      }
    });
    term.onExit(() => {
      for (const c of session.clients) {
        try { c.send(JSON.stringify({ type: 'exit' })); } catch (e) {}
      }
      activeTerminals.delete(sessionKey);
    });
  }

  ws.on('message', msg => {
    try {
      const m = JSON.parse(msg);
      if (m.type === 'input' && session && session.term) session.term.write(m.data);
      if (m.type === 'resize' && m.cols && m.rows && session && session.term) {
        if (session.resizeTimeout) clearTimeout(session.resizeTimeout);
        session.resizeTimeout = setTimeout(() => {
          try { session.term.resize(m.cols, m.rows); } catch (e) {}
        }, 50);
      }
    } catch (e) {}
  });

  const removeClient = () => {
    if (!session) return;
    session.clients.delete(ws);
    if (session.clients.size === 0) {
      session.graceTimer = setTimeout(() => {
        if (session.clients.size === 0) killSession(session, sessionKey);
      }, SESSION_GRACE_MS);
    }
  };
  ws.on('close', removeClient);
  ws.on('error', removeClient);
});

server.listen(PORT, '127.0.0.1', () => { console.log(`Easy LXD UI running on http://127.0.0.1:${PORT} (Tailscale Serve経由でのみ外部公開)`); });
