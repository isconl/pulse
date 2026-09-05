'use strict';
/**
 * End-to-end smoke tests: start pulse's real HTTP server, backed by a real
 * (fake, in-process) vault HTTP server for TSV data -- same shape as the
 * real GET/POST/PUT /vault/:collection contract, so this exercises the
 * actual remote-store wire format, not a shortcut.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startFakeVault(seed = {}, rawSeed = {}) {
  const data = { ...seed };
  const raw = { ...rawSeed };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        // Raw (non-TSV) collections -- same GET/PUT shape as /vault/:collection,
        // for JSON/YAML state served as text rather than TSV rows.
        if (url.pathname.startsWith('/vault-raw/')) {
          const collection = decodeURIComponent(url.pathname.slice('/vault-raw/'.length));
          if (req.method === 'GET') {
            res.writeHead(200);
            return res.end(JSON.stringify({ collection, text: raw[collection] || '' }));
          }
          if (req.method === 'PUT') {
            let text = '';
            try { text = JSON.parse(body || '{}').text || ''; } catch { /* ignore */ }
            raw[collection] = text;
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, collection, bytes: text.length }));
          }
          res.writeHead(404);
          return res.end(JSON.stringify({ error: 'Not Found' }));
        }

        const collection = decodeURIComponent(url.pathname.slice('/vault/'.length));
        if (req.method === 'GET') {
          res.writeHead(200);
          return res.end(JSON.stringify({ collection, rows: data[collection] || [] }));
        }
        if (req.method === 'POST') {
          let row = {};
          try { row = JSON.parse(body || '{}'); } catch { /* ignore */ }
          (data[collection] = data[collection] || []).push(row);
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection }));
        }
        if (req.method === 'PUT') {
          let rows = [];
          try { rows = JSON.parse(body || '{}').rows || []; } catch { /* ignore */ }
          const before = (data[collection] || []).length;
          data[collection] = rows;
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection, count: rows.length, removed: before - rows.length }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, data, raw, port: server.address().port }));
  });
}

function tmpEnv() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-e2e-logs-'));
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-e2e-local-'));
  return { logsDir, localDir };
}

async function startServer(envOverrides = {}, vaultSeed = {}) {
  const { logsDir, localDir } = tmpEnv();
  const vault = await startFakeVault({
    'notifications.tsv': [], 'scope/dates.tsv': [], 'scope/tasks.tsv': [], 'scope/inbox.tsv': [],
    'finance/ventures.tsv': [], 'finance/accounts.tsv': [], 'finance/transactions.tsv': [], 'finance/incomes.tsv': [], 'finance/networth.tsv': [], 'finance/goals.tsv': [],
    'learning/resume.tsv': [], 'spark/journal.tsv': [],
    ...vaultSeed,
  });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    PULSE_PORT: '0',
    PULSE_BIND: '127.0.0.1',
    VAULT_URL: `http://127.0.0.1:${vault.port}`, VAULT_TOKEN: 'vault-test-token',
    PULSE_LOGS_DIR: logsDir,
    PULSE_REMINDED_FILE: path.join(localDir, 'reminded.json'),
    PULSE_TOKEN: 'test-static-token',
    BWS_ACCESS_TOKEN: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
    vault.server.close();
  };
  return { ...handle, vault, cleanup };
}

test('GET /health responds without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.engine, 'pulse');
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists pulse\'s capabilities without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    assert.equal(body.engine, 'pulse');
    assert.ok(body.capabilities.some(c => c.name === 'finance.summary'));
  } finally { server.close(); cleanup(); }
});

test('a protected route with no credential fails closed (silent 404, not 401)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/finance/summary`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

// BS26090501: dev-only auth bypass, loopback-gated. Confirms the flag actually
// bypasses (else the escape hatch is useless) AND that leaving it unset keeps
// the fail-closed behavior above -- a future refactor can't silently invert this.
test('ISCONL_DEV_NO_AUTH=1 bypasses auth on loopback', async () => {
  const { server, port, cleanup } = await startServer({ ISCONL_DEV_NO_AUTH: '1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/finance/summary`);
    assert.notEqual(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('ISCONL_DEV_NO_AUTH unset still fails closed with no credential', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/finance/summary`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('finance: add a transaction then read it back in the summary', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/finance/accounts`, { method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'KCB', type: 'bank', balance: 1000, currency: 'KES' }) });
    const res = await fetch(`http://127.0.0.1:${port}/finance/summary`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.netWorth.assets, 1000);
  } finally { server.close(); cleanup(); }
});

test('dates: add a date then see it in the list', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`http://127.0.0.1:${port}/dates`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'Birthday', date: '1990-01-01', kind: 'birthday' }) });
    assert.equal(add.status, 200);
    const list = await fetch(`http://127.0.0.1:${port}/dates`, { headers: auth });
    const body = await list.json();
    assert.equal(body.dates.length, 1);
    assert.equal(body.dates[0].TITLE, 'Birthday');
  } finally { server.close(); cleanup(); }
});

test('calendar: adding an event raises a notification, visible via /notifications', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`http://127.0.0.1:${port}/calendar/events`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'Team sync', date: '2026-09-01' }) });
    assert.equal(add.status, 200);

    const events = await fetch(`http://127.0.0.1:${port}/calendar/events`, { headers: auth });
    const eventsBody = await events.json();
    assert.equal(eventsBody.events.length, 1);

    const notifs = await fetch(`http://127.0.0.1:${port}/notifications`, { headers: auth });
    const notifsBody = await notifs.json();
    assert.equal(notifsBody.notifications.some(n => n.SOURCE === 'calendar'), true);
  } finally { server.close(); cleanup(); }
});

test('calendar event with makeTask:true creates a linked task in scope/tasks.tsv', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`http://127.0.0.1:${port}/calendar/events`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'Launch', date: '2026-09-01', category: 'deadline', makeTask: true }) });
    const body = await add.json();
    assert.ok(body.task);
    assert.equal(body.task.PRIORITY, 'high');
  } finally { server.close(); cleanup(); }
});

test('notifications sweep (shallow) picks up an overdue task written directly to the vault', async () => {
  const { server, port, cleanup, vault } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    vault.data['scope/tasks.tsv'].push({ ID: 'T1', TITLE: 'Old task', STATUS: 'open', DUE_DATE: '2020-01-01' });
    const sweep = await fetch(`http://127.0.0.1:${port}/notifications/sweep?deep=false`, { method: 'POST', headers: auth });
    const body = await sweep.json();
    assert.equal(body.success, true);
    assert.ok(body.raised >= 1);
  } finally { server.close(); cleanup(); }
});

test('data health: GET /health/data reports healthy on a clean vault', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/data`, { headers: auth });
    const body = await res.json();
    assert.equal(body.healthy, true);
  } finally { server.close(); cleanup(); }
});

test('rhythm: GET seeds defaults, POST toggles a habit and it round-trips', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const get1 = await fetch(`http://127.0.0.1:${port}/rhythm`, { headers: auth });
    const body1 = await get1.json();
    assert.ok(body1.habits.length > 0);

    await fetch(`http://127.0.0.1:${port}/rhythm`, { method: 'POST', headers: auth,
      body: JSON.stringify({ toggleHabit: { date: '2026-08-09', habitId: 'h-exercise', done: true } }) });

    const get2 = await fetch(`http://127.0.0.1:${port}/rhythm`, { headers: auth });
    const body2 = await get2.json();
    assert.equal(body2.logs['2026-08-09']['h-exercise'], true);
  } finally { server.close(); cleanup(); }
});

test('projects: GET lists ventures, POST /projects/url updates one', async () => {
  const { server, port, cleanup, vault } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    vault.data['finance/ventures.tsv'].push({ ID: 'V1', NAME: 'WellPath', RENDER_URL: '-' });
    const set = await fetch(`http://127.0.0.1:${port}/projects/url`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id: 'V1', url: 'https://wellpath.onrender.com' }) });
    assert.equal(set.status, 200);

    const list = await fetch(`http://127.0.0.1:${port}/projects`, { headers: auth });
    const body = await list.json();
    assert.equal(body.projects[0].RENDER_URL, 'https://wellpath.onrender.com');
  } finally { server.close(); cleanup(); }
});

test('the audit log recorded requests made during this test run', async () => {
  const { server, port, auditLog, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/dates`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: 'x', date: '2026-01-01' }) });
    const chain = auditLog.verifyChain();
    assert.equal(chain.ok, true);
  } finally { server.close(); cleanup(); }
});
