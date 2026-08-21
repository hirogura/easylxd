const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const pty = require('node-pty');

const PORT = 3329;

function run(cmd, args = [], timeout = 120000, onData = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'pipe'] });
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function getInstances() {
  const { stdout } = await lxc('list', '--format', 'json');
  return JSON.parse(stdout).map(c => ({
    name: c.name, status: c.status, ephemeral: c.ephemeral, type: c.type,
    architecture: c.architecture, created_at: c.created_at, profiles: c.profiles,
    devices: c.devices || {},
    state: c.state ? { status: c.state.status, pid: c.state.pid, memory: c.state.memory, disk: c.state.disk, cpu: c.state.cpu, network: c.state.network } : null,
    snapshots: c.snapshots || []
  }));
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

async function lxcExec(name, script, timeout = 300000, onData = null) {
  return run('lxc', ['exec', name, '--', 'bash', '-euo', 'pipefail', '-c', script], timeout, onData);
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
  return UBUNTU_VERSIONS.map(ver => ({ alias: `ubuntu:${ver}`, description: `Ubuntu ${ver} LTS` }));
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

async function createInstance(opts, progress) {
  const { name, image, update: doUpdate, tailscale, docker, mount } = opts;
  const isUbuntu = image.startsWith('ubuntu:');
  const log = progress || (() => {});

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
  }
  if (isUbuntu && tailscale) {
    try {
      log('Tailscale インストール中...');
      await lxcExec(name, 'curl -fsSL https://tailscale.com/install.sh | sh -s -- --no-autostart', 300000, streamToLog(log));
      log('Tailscale インストール完了');
    } catch (e) {
      log(`WARNING: Tailscale インストールに失敗しました（作成は継続します）: ${e.message}`);
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
  const features = []; if (isUbuntu && doUpdate) features.push('update'); if (isUbuntu && tailscale) features.push('tailscale');
  if (isUbuntu && docker) features.push('docker'); if (isUbuntu && mount) features.push('mount');
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
  if (instMatch) {
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
      return json(res, 200, { ok: true, message: await createInstance({ name: body.name, image: body.image, update: !!body.update, tailscale: !!body.tailscale, docker: !!body.docker, mount: !!body.mount }) });
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
        { name: body.name, image: body.image, update: !!body.update, tailscale: !!body.tailscale, docker: !!body.docker, mount: !!body.mount },
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
      const body = await parseBody(req); if (!body.newName) return json(res, 400, { error: 'newName is required' });
      await lxc('copy', srcName, body.newName, '--stateless');
      await lxc('config', 'set', body.newName, 'raw.idmap', 'both 1000 1000'); await lxc('start', body.newName);
      return json(res, 200, { ok: true, message: `Cloned ${srcName} to ${body.newName}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  const snapListMatch = pathname.match(/^\/api\/instances\/([^/]+)\/snapshots$/);
  if (snapListMatch && req.method === 'GET') {
    try { return json(res, 200, await getSnapshots(snapListMatch[1])); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (snapListMatch && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const snap = `snap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${body.comment ? '-' + body.comment.replace(/\s+/g, '-') : ''}`;
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

  const termResetMatch = pathname.match(/^\/api\/terminal\/reset\/(.+)$/);
  if (termResetMatch && req.method === 'POST') {
    const instName = termResetMatch[1];
    const session = activeTerminals.get(instName);
    if (session) {
      for (const c of session.clients) {
        try { c.send(JSON.stringify({ type: 'exit' })); } catch (e) {}
      }
      killSession(session, instName);
      return json(res, 200, { ok: true, message: `Terminal session for ${instName} has been reset` });
    }
    return json(res, 200, { ok: true, message: `No active session for ${instName}` });
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

  let session = activeTerminals.get(instanceName);

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
      term = pty.spawn('lxc', ['exec', instanceName, '--', '/bin/bash'], {
        name: 'xterm-256color',
        cols, rows,
        cwd: process.env.HOME || '/root',
        env: { ...process.env, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' }
      });
    } catch (e) { ws.close(); return; }
    session = { term, clients: new Set([ws]), resizeTimeout: null, buffer: '', graceTimer: null };
    activeTerminals.set(instanceName, session);
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
      activeTerminals.delete(instanceName);
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
        if (session.clients.size === 0) killSession(session, instanceName);
      }, SESSION_GRACE_MS);
    }
  };
  ws.on('close', removeClient);
  ws.on('error', removeClient);
});

server.listen(PORT, '127.0.0.1', () => { console.log(`Easy LXD UI running on http://127.0.0.1:${PORT} (Tailscale Serve経由でのみ外部公開)`); });
