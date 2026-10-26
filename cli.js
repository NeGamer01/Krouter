#!/usr/bin/env node
'use strict';
// krouter CLI — manage a local or remote krouter server.
// zero dependencies. Node >= 18. Windows/Linux/macOS.
//
// usage: krouter <command> [args] [flags]
//   krouter status                       server health, providers, keys
//   krouter start [--port 20128]         start server (detached)
//   krouter stop                         stop server
//   krouter provider ls                  list providers
//   krouter provider add --name X --alias x --base https://... --keys k1,k2,k3
//   krouter provider rm <id|alias>
//   krouter provider test <id|alias>
//   krouter keys add <id|alias> k1 k2 k3     bulk add api keys
//   krouter keys ls <id|alias>
//   krouter models ls                     all models (per provider)
//   krouter models refresh <id|alias>     re-fetch upstream model list
//   krouter inject ls / add / rm / toggle
//   krouter usage                         usage stats
//   krouter logs [20]                     recent request log
//   krouter tunnel start [--domain api.example.com]
//   krouter tunnel stop
//   krouter tunnel status
//   krouter config set --url http://... --key ...
//   krouter --help
//
// flags (any command): --url <url> --key <apiKey>   (one-off; overrides saved config)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');

const CLI_VERSION = '1.0.0';
const HOME_DIR = os.homedir();
const KROUTER_HOME = path.join(HOME_DIR, '.krouter');
const CLI_CONFIG = path.join(KROUTER_HOME, 'config.json');
const TUNNELS_FILE = path.join(KROUTER_HOME, 'tunnels.json');
const BIN_DIR = path.join(KROUTER_HOME, 'bin');
const SERVER_DIR = __dirname;

// ─── helpers ─────────────────────────────────────────────────────────────
function out(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }
function die(s, code) { err(s); process.exit(code || 1); }
function ok(s) { out('✓ ' + s); }
function warn(s) { out('! ' + s); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// strip invisible characters (same logic as server's cleanApiKey)
function cleanApiKey(s) {
  return String(s || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u00AD\uFEFF\u00A0\r]/g, '')
    .replace(/^[\s\u201c\u201d'"`]+|[\s\u201c\u201d'"`]+$/g, '')
    .trim()
    .replace(/[^\x20-\x7E]/g, '');
}

// ─── server connection ───────────────────────────────────────────────────
function loadCliConfig() {
  return readJson(CLI_CONFIG, { url: 'http://127.0.0.1:20128', key: '' });
}
function saveCliConfig(cfg) {
  writeJson(CLI_CONFIG, cfg);
}

function resolveTarget(flags) {
  // --url/--key win; otherwise saved config; otherwise default localhost
  const saved = loadCliConfig();
  const url = (flags && flags.url) || saved.url || 'http://127.0.0.1:20128';
  const key = (flags && flags.key) || saved.key || '';
  return { url: url.replace(/\/+$/, ''), key };
}

function apiCall(url, key, method, path, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url + path); } catch (e) { return reject(new Error('bad url: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function call(target, method, path, body) {
  let r;
  try { r = await apiCall(target.url, target.key, method, path, body); }
  catch (e) { die('cannot reach krouter at ' + target.url + ' — ' + e.message + '\n  is the server running? try: krouter start'); }
  if (r.status === 401) die('unauthorized — wrong api key. set with: krouter config set --key <key>');
  return r;
}

// ─── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

// ─── server process management ────────────────────────────────────────────
function serverEntry() { return path.join(SERVER_DIR, 'server.js'); }

function findServerPid() {
  // returns pid listening on configured port, or null
  const target = loadCliConfig();
  const port = (() => { try { return new URL(target.url).port; } catch { return ''; } })();
  if (!port) return null;
  try {
    if (process.platform === 'win32') {
      const r = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`, { encoding: 'utf8' });
      const pid = parseInt(r.trim(), 10);
      return pid > 0 ? pid : null;
    }
    const r = execSync(`ss -ltnp 2>/dev/null | grep ':${port}' || true`, { encoding: 'utf8' });
    const m = r.match(/pid=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function cmdStart(flags) {
  const existing = findServerPid();
  if (existing) { ok('krouter already running (pid ' + existing + ')'); return; }
  const port = String(flags.port || process.env.KROUTER_PORT || '20128');
  const logFile = path.join(SERVER_DIR, 'debug.log');
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  const detached = !flags.fg;
  const child = spawn(process.execPath, [serverEntry()], {
    cwd: SERVER_DIR,
    detached,
    stdio: detached ? 'ignore' : 'inherit',
    env: { ...process.env, KROUTER_PORT: port },
  });
  if (detached) child.unref();
  saveCliConfig({ ...loadCliConfig(), url: 'http://127.0.0.1:' + port });
  out('starting krouter on port ' + port + ' (pid ' + child.pid + ')…');
  if (detached) {
    // wait up to 8s for health
    const target = { url: 'http://127.0.0.1:' + port, key: loadCliConfig().key };
    (async () => {
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await apiCall(target.url, target.key, 'GET', '/health');
          if (r.status === 200) { ok('krouter up at ' + target.url); return; }
        } catch { /* retry */ }
      }
      warn('server still starting — check ' + logFile);
    })();
  }
}

function cmdStop(flags) {
  const pid = findServerPid();
  if (!pid) { warn('no krouter server found on configured port'); return; }
  try {
    process.kill(pid, 'SIGTERM');
    ok('krouter stopped (pid ' + pid + ')');
  } catch (e) { die('failed to stop pid ' + pid + ': ' + e.message); }
}

async function cmdStatus(flags) {
  const target = resolveTarget(flags);
  const r = await call(target, 'GET', '/health');
  if (r.status !== 200) die('server unhealthy: http ' + r.status);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const provs = s.providers || [];
  out('krouter ' + (s.version || '?') + ' · up ' + Math.round(s.uptime || 0) + 's · port ' + (s.port || '?'));
  out('endpoint: ' + target.url + '/v1   key: ' + (target.key ? target.key.slice(0, 6) + '…' : '(none)'));
  out('providers: ' + provs.length + '   models: ' + provs.reduce((a, p) => a + ((p.models || []).length), 0));
  for (const p of provs) {
    const live = (p.keys || []).filter((k) => k.enabled !== false && !k.cooldownUntil).length;
    const dead = (p.keys || []).filter((k) => k.enabled === false).length;
    out('  ' + (p.name || p.id) + ' [' + (p.alias || p.id) + '] ' + (p.kind || 'openai') + ' · ' +
      (p.models || []).length + ' models · keys: ' + live + ' live' + (dead ? ' / ' + dead + ' disabled' : '') +
      (p.enabled === false ? ' · DISABLED' : ''));
  }
  if (s.logsEnabled === false) out('  note: request logging is off (krouter logs won\'t show)');
}

async function cmdProviderLs(flags) {
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const provs = s.providers || [];
  if (!provs.length) { out('no providers yet. add one: krouter provider add --name X --alias x --base https://... --keys k1'); return; }
  for (const p of provs) {
    out(p.id + '  ' + (p.name || '') + '  [' + (p.alias || '') + ']  ' + (p.kind || '') + '/' + (p.tier || '') +
      '  models:' + (p.models || []).length + '  keys:' + (p.keys || []).filter((k) => k.enabled !== false).length +
      (p.enabled === false ? '  DISABLED' : ''));
  }
}

async function cmdProviderAdd(flags) {
  const target = resolveTarget(flags);
  if (!flags.name) die('provider needs --name');
  if (!flags.base) die('provider needs --base (baseUrl, e.g. https://api.example.com/v1)');
  const keys = String(flags.keys || '')
    .split(/[,\s]+/)
    .map(cleanApiKey)
    .filter(Boolean);
  const models = String(flags.models || '').split(',').map((m) => m.trim()).filter(Boolean);
  const body = {
    name: flags.name,
    alias: flags.alias || flags.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    kind: flags.kind || 'openai',
    tier: flags.tier || 'cheap',
    baseUrl: flags.base,
    apiKeys: keys,
    models,
  };
  const r = await call(target, 'POST', '/api/providers', body);
  if (r.status !== 200) die('add failed: ' + r.text.slice(0, 200));
  const p = r.json;
  ok('provider added: ' + p.id + ' [' + p.alias + '] keys:' + (p.apiKeys || []).length);
  if (!models.length) out('  fetch models with: krouter models refresh ' + p.alias);
}

async function providerBy(flags, idOrAlias) {
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const p = (s.providers || []).find((x) => x.id === idOrAlias || x.alias === idOrAlias || x.name === idOrAlias);
  if (!p) die('provider not found: ' + idOrAlias);
  return { target, p };
}

async function cmdProviderRm(flags) {
  const id = flags.pos ? flags.pos[0] : die('usage: krouter provider rm <id|alias>');
  const { target, p } = await providerBy(flags, id);
  const r = await call(target, 'POST', '/api/providers/delete', { id: p.id });
  if (r.status !== 200) die('delete failed: ' + r.text.slice(0, 200));
  ok('provider removed: ' + p.name);
}

async function cmdProviderTest(flags) {
  const id = flags.pos ? flags.pos[0] : die('usage: krouter provider test <id|alias>');
  const { target, p } = await providerBy(flags, id);
  // server falls back to the provider's live key pool when pid is given
  const r = await call(target, 'POST', '/api/providers/test', { baseUrl: p.baseUrl, pid: p.id });
  if (r.json && r.json.ok) ok('connection ok — ' + ((r.json.models || []).length) + ' models');
  else warn('connection failed: ' + (r.json && r.json.error ? r.json.error : 'http ' + r.status));
}

async function cmdKeysAdd(flags) {
  const id = flags.pos && flags.pos[0] ? flags.pos[0] : die('usage: krouter keys add <id|alias> k1 k2 k3 …');
  const { target, p } = await providerBy(flags, id);
  const keys = flags.pos.slice(1).map(cleanApiKey).filter(Boolean);
  if (!keys.length) die('no keys given — usage: krouter keys add <id|alias> k1 k2 k3');
  const r = await call(target, 'POST', '/api/providers/' + p.id + '/keys', { keys });
  if (r.status !== 200) die('add keys failed: ' + r.text.slice(0, 200));
  ok('+' + r.json.added + ' keys → ' + p.name + ' (total ' + r.json.total + ')');
}

async function cmdKeysLs(flags) {
  const id = flags.pos && flags.pos[0] ? flags.pos[0] : die('usage: krouter keys ls <id|alias>');
  const { p } = await providerBy(flags, id);
  for (const k of p.keys || []) {
    out((k.id || '?') + '  ' + (k.preview || '') + '  ' + (k.enabled === false ? 'DISABLED' : 'live') +
      '  uses:' + (k.uses || 0) + '  ' + (k.lastError ? 'err: ' + k.lastError.slice(0, 60) : ''));
  }
  if (!(p.keys || []).length) out('no keys — add with: krouter keys add ' + (p.alias || p.id) + ' k1 k2');
}

async function cmdModelsLs(flags) {
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  for (const p of s.providers || []) {
    out('[' + (p.alias || p.id) + '] ' + (p.name || ''));
    for (const m of p.models || []) out('  ' + (p.alias || p.id) + '/' + m);
    if (!(p.models || []).length) out('  (no models — refresh: krouter models refresh ' + (p.alias || p.id) + ')');
  }
}

async function cmdModelsRefresh(flags) {
  const id = flags.pos && flags.pos[0] ? flags.pos[0] : die('usage: krouter models refresh <id|alias>');
  const { target, p } = await providerBy(flags, id);
  const r = await call(target, 'POST', '/api/fetch-models', { id: p.id });
  if (r.json && r.json.models) ok('fetched ' + r.json.models.length + ' models for ' + p.name);
  else warn('fetch failed: ' + (r.json && r.json.error ? r.json.error : 'http ' + r.status));
}

async function cmdInjectLs(flags) {
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const rules = s.injections || [];
  if (!rules.length) { out('no injection rules'); return; }
  for (const r of rules) {
    out((r.id || '?') + '  ' + (r.pattern || '') + '  ' + (r.transform ? 'tx:' + r.transform : (r.prompt || '').slice(0, 50)) +
      '  ' + (r.enabled === false ? 'OFF' : 'on'));
  }
}

async function cmdInjectAdd(flags) {
  const target = resolveTarget(flags);
  if (!flags.pattern) die('inject needs --pattern (e.g. mb/* or *)');
  if (!flags.prompt && !flags.transform) die('inject needs --prompt or --transform');
  const body = { pattern: flags.pattern, enabled: true };
  if (flags.prompt) body.prompt = flags.prompt;
  if (flags.transform) body.transform = flags.transform;
  body.position = flags.position || 'prepend';
  const r = await call(target, 'POST', '/api/injections', body);
  if (r.status !== 200) die('add failed: ' + r.text.slice(0, 200));
  ok('injection added: ' + r.json.id + ' (' + flags.pattern + ')');
}

async function cmdInjectRm(flags) {
  const id = flags.pos && flags.pos[0] ? flags.pos[0] : die('usage: krouter inject rm <id>');
  const target = resolveTarget(flags);
  const r = await call(target, 'POST', '/api/injections/delete', { id });
  if (r.status !== 200) die('delete failed: ' + r.text.slice(0, 200));
  ok('injection removed: ' + id);
}

async function cmdInjectToggle(flags) {
  const id = flags.pos && flags.pos[0] ? flags.pos[0] : die('usage: krouter inject toggle <id>');
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const r0 = (s.injections || []).find((x) => x.id === id);
  if (!r0) die('injection not found: ' + id);
  await call(target, 'POST', '/api/injections/' + id, { enabled: r0.enabled === false });
  ok('injection ' + id + ' → ' + (r0.enabled === false ? 'on' : 'off'));
}

async function cmdUsage(flags) {
  const target = resolveTarget(flags);
  const s = (await call(target, 'GET', '/api/state')).json || {};
  const usage = s.usage || {};
  for (const [pid, u] of Object.entries(usage)) {
    const p = (s.providers || []).find((x) => x.id === pid);
    out((p ? p.name : pid) + '  req:' + (u.requests || 0) + '  in:' + fmtN(u.tokensIn) + '  out:' + fmtN(u.tokensOut));
  }
  if (!Object.keys(usage).length) out('no usage recorded yet');
}
function fmtN(n) { return (n || 0).toLocaleString(); }

async function cmdLogs(flags) {
  const target = resolveTarget(flags);
  const n = (flags.pos && flags.pos[0] ? parseInt(flags.pos[0], 10) : 20) || 20;
  const r = await call(target, 'GET', '/api/logs');
  const logs = (r.json && r.json.logs) || [];
  for (const l of logs.slice(0, n)) {
    out(new Date(l.ts).toLocaleTimeString() + '  ' + (l.ok ? '●' : '○') + '  ' + (l.model || '?') + '  → ' + (l.provider || '?') +
      (l.tokensIn ? '  in:' + l.tokensIn : '') + (l.error ? '  err: ' + l.error.slice(0, 60) : ''));
  }
  if (!logs.length) out('no requests logged');
}

function cmdConfigSet(flags) {
  const cfg = loadCliConfig();
  if (flags.url) cfg.url = String(flags.url).replace(/\/+$/, '');
  if (flags.key) cfg.key = flags.key;
  if (flags.url === '') delete cfg.url;
  if (flags.key === '') delete cfg.key;
  saveCliConfig(cfg);
  ok('cli config saved → ' + (cfg.url || '(default)') + (cfg.key ? ' key:' + cfg.key.slice(0, 6) + '…' : ' no key'));
}

// ─── cloudflared tunneling ───────────────────────────────────────────────
function binName() { return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'; }

function cloudflaredPath() {
  const local = path.join(BIN_DIR, binName());
  if (fs.existsSync(local)) return local;
  // PATH lookup
  try {
    const where = process.platform === 'win32'
      ? execSync('where cloudflared', { encoding: 'utf8' })
      : execSync('command -v cloudflared', { encoding: 'utf8' });
    const p = where.split('\n').map((x) => x.trim()).filter(Boolean)[0];
    if (p && fs.existsSync(p)) return p;
  } catch { /* not in PATH */ }
  return null;
}

function downloadCloudflared() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const plat = process.platform;
  const arch = process.arch; // x64 / arm64
  const osPart = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux';
  const archPart = arch === 'arm64' ? 'arm64' : 'amd64';
  const ext = plat === 'win32' ? '.exe' : '';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${osPart}-${archPart}${ext}`;
  const dest = path.join(BIN_DIR, binName());
  out('downloading cloudflared (' + osPart + '/' + archPart + ')…');
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const follow = (u, depth) => {
      if (depth > 5) return reject(new Error('too many redirects'));
      lib.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('download http ' + res.statusCode)); }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try { fs.chmodSync(dest, 0o755); } catch { /* windows */ }
          resolve(dest);
        }));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

function loadTunnels() { return readJson(TUNNELS_FILE, { tunnels: [] }); }
function saveTunnels(t) { writeJson(TUNNELS_FILE, t); }

async function ensureCloudflared() {
  const existing = cloudflaredPath();
  if (existing) return existing;
  warn('cloudflared not found — downloading to ' + BIN_DIR);
  try { return await downloadCloudflared(); }
  catch (e) { die('could not install cloudflared: ' + e.message + '\n  install manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/'); }
}

function spawnTunnel(bin, port, domain) {
  // quick tunnel when no domain; named tunnel + dns route when domain given
  const args = domain
    ? ['tunnel', '--no-autoupdate', 'run', '--url', 'http://127.0.0.1:' + port, domain]
    : ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port];
  const logFile = path.join(KROUTER_HOME, 'tunnel.log');
  const out2 = fs.openSync(logFile, 'a');
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', out2, out2] });
  child.unref();
  return { pid: child.pid, logFile };
}

function parseQuickUrl(line) {
  // cloudflared prints: "|  https://xxx-yyy.trycloudflare.com  |"
  const m = line && line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

async function cmdTunnelStart(flags) {
  const tcfg = loadCliConfig();
  let port;
  try { port = new URL(tcfg.url).port || '20128'; } catch { port = '20128'; }
  const bin = await ensureCloudflared();
  const domain = flags.domain || null;
  const tunnels = loadTunnels();
  const running = tunnels.tunnels.find((x) => x.pid && !x.exited);
  if (running) { warn('tunnel already running (pid ' + running.pid + ')'); return; }
  const { pid, logFile } = spawnTunnel(bin, port, domain);
  ok('tunnel started (pid ' + pid + (domain ? ' domain ' + domain : ' quick') + ')  log: ' + logFile);
  tunnels.tunnels.push({ pid, domain: domain || null, startedAt: Date.now(), exited: false });
  saveTunnels(tunnels);
  // try to read quick url from log
  if (!domain) {
    out('waiting for public url…');
    let url = null;
    for (let i = 0; i < 24 && !url; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const log = fs.readFileSync(logFile, 'utf8');
        const lines = log.split('\n');
        for (let j = lines.length - 1; j >= 0 && !url; j--) url = parseQuickUrl(lines[j]);
      } catch { /* log not ready */ }
    }
    if (url) {
      ok('public url: ' + url);
      const t2 = loadTunnels();
      const rec = t2.tunnels.find((x) => x.pid === pid);
      if (rec) { rec.url = url; saveTunnels(t2); }
    } else warn('url not up yet — check ' + logFile);
  }
}

function cmdTunnelStop(flags) {
  const tunnels = loadTunnels();
  let stopped = 0;
  for (const t of tunnels.tunnels) {
    if (t.pid && !t.exited) {
      try { process.kill(t.pid, 'SIGTERM'); stopped++; } catch { t.exited = true; }
      t.exited = true;
    }
  }
  saveTunnels(tunnels);
  if (stopped) ok(stopped + ' tunnel(s) stopped');
  else warn('no running tunnel found');
}

function cmdTunnelStatus(flags) {
  const tunnels = loadTunnels();
  const bin = cloudflaredPath();
  out('cloudflared: ' + (bin ? 'installed (' + bin + ')' : 'not installed'));
  let any = false;
  for (const t of tunnels.tunnels || []) {
    const alive = t.pid && !t.exited && (() => { try { process.kill(t.pid, 0); return true; } catch { return false; } })();
    if (!t.exited) any = true;
    out('  pid ' + t.pid + '  ' + (alive ? 'RUNNING' : 'stopped') + '  ' +
      (t.url || t.domain || (t.domain ? '' : 'quick')) + '  started ' + new Date(t.startedAt).toLocaleString());
  }
  if (!any) out('no tunnels on record');
}

// ─── main ──────────────────────────────────────────────────────────────
function help() {
  out(`
krouter cli ${CLI_VERSION}

server:
  krouter status                      health, providers, keys
  krouter start [--port 20128]        start server detached
  krouter stop                        stop server

providers & keys:
  krouter provider ls
  krouter provider add --name X --alias x --base https://api.x.com/v1 [--keys k1,k2] [--models m1,m2] [--kind openai] [--tier cheap]
  krouter provider rm <id|alias>
  krouter provider test <id|alias>
  krouter keys add <id|alias> k1 k2 k3     (bulk, keys sanitized)
  krouter keys ls <id|alias>

models & injections:
  krouter models ls
  krouter models refresh <id|alias>
  krouter inject ls
  krouter inject add --pattern 'mb/*' --prompt '…'
  krouter inject add --pattern 'mb/*' --transform fiction-deep
  krouter inject rm <id>
  krouter inject toggle <id>

usage & logs:
  krouter usage
  krouter logs [20]

tunneling (cloudflare, works anywhere):
  krouter tunnel start [--domain api.example.com]   quick tunnel or named tunnel w/ your domain
  krouter tunnel stop
  krouter tunnel status

config:
  krouter config set --url http://127.0.0.1:20128 --key <routerApiKey>
  krouter config set --key ''  (clear key)

flags (all commands): --url <url> --key <apiKey>  (override saved config)
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { help(); return; }

  // two-word commands: "provider add", "keys add", "tunnel start"…
  const TWO = ['provider', 'keys', 'models', 'inject', 'tunnel', 'config'];
  let cmd = argv[0];
  let rest = argv.slice(1);
  if (TWO.includes(cmd) && argv.length > 1 && !argv[1].startsWith('--')) {
    cmd = cmd + ' ' + argv[1];
    rest = argv.slice(2);
  }
  const { pos, flags } = parseArgs(rest);
  flags.pos = pos;

  switch (cmd) {
    case 'status': return cmdStatus(flags);
    case 'start': return cmdStart(flags);
    case 'stop': return cmdStop(flags);
    case 'provider ls': return cmdProviderLs(flags);
    case 'provider add': return cmdProviderAdd(flags);
    case 'provider rm': return cmdProviderRm(flags);
    case 'provider test': return cmdProviderTest(flags);
    case 'keys add': return cmdKeysAdd(flags);
    case 'keys ls': return cmdKeysLs(flags);
    case 'models ls': return cmdModelsLs(flags);
    case 'models refresh': return cmdModelsRefresh(flags);
    case 'inject ls': return cmdInjectLs(flags);
    case 'inject add': return cmdInjectAdd(flags);
    case 'inject rm': return cmdInjectRm(flags);
    case 'inject toggle': return cmdInjectToggle(flags);
    case 'usage': return cmdUsage(flags);
    case 'logs': return cmdLogs(flags);
    case 'tunnel start': return cmdTunnelStart(flags);
    case 'tunnel stop': return cmdTunnelStop(flags);
    case 'tunnel status': return cmdTunnelStatus(flags);
    case 'config set': return cmdConfigSet(flags);
    case 'version': return out('krouter cli ' + CLI_VERSION);
    default:
      err('unknown command: ' + cmd);
      help();
      process.exit(1);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
