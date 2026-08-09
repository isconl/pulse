'use strict';
/**
 * End-to-end smoke tests: start pulse's real HTTP server and hit it with
 * real requests -- proves the lib/ modules are correctly wired together,
 * not just individually correct (same purpose as vault's own server.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpEnv() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-e2e-memory-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-e2e-logs-'));
  fs.mkdirSync(path.join(memoryDir, 'finance'), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'notifications.tsv'),
    'ID\tTS\tSOURCE\tKIND\tSEVERITY\tTITLE\tBODY\tVIEW\tREF\tSTATUS\tDEDUPE_KEY\tSEEN_AT\n');
  fs.writeFileSync(path.join(memoryDir, 'scope', 'dates.tsv'),
    'ID\tTITLE\tDATE\tKIND\tWHO\tRECURS\tCOLOR\tNOTE\n');
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'),
    'ID\tTITLE\tSTATUS\tPRIORITY\tDUE_DATE\tTAG\tCREATED_AT\tORIGIN\tWHY\tRESOLUTION\n');
  fs.writeFileSync(path.join(memoryDir, 'finance', 'ventures.tsv'),
    'ID\tNAME\tRENDER_URL\tANALYTICS_URL\tAUTH_SECRET\tSTATUS\tNOTE\n');
  fs.writeFileSync(path.join(memoryDir, 'finance', 'accounts.tsv'),
    'ID\tNAME\tTYPE\tBALANCE\tCURRENCY\tASOF\n');
  fs.writeFileSync(path.join(memoryDir, 'finance', 'transactions.tsv'),
    'ID\tDATE\tTYPE\tAMOUNT\tCATEGORY\tDESCRIPTION\tACCOUNT_ID\tNECESSITY\n');
  fs.writeFileSync(path.join(memoryDir, 'finance', 'incomes.tsv'),
    'ID\tNAME\tAMOUNT\tRECURS\tDAY\tMATCH\tSTATUS\tSTARTS\n');
  return { memoryDir, logsDir };
}

async function startServer(envOverrides = {}) {
  const { memoryDir, logsDir } = tmpEnv();
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    PULSE_PORT: '0',
    PULSE_BIND: '127.0.0.1',
    PULSE_MEMORY_DIR: memoryDir,
    PULSE_LOGS_DIR: logsDir,
    PULSE_EVENTS_FILE: path.join(memoryDir, 'scope', 'calendar_events.json'),
    PULSE_RHYTHM_FILE: path.join(memoryDir, 'personal', 'rhythm.json'),
    PULSE_REMINDED_FILE: path.join(memoryDir, 'reminded.json'),
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
  };
  return { ...handle, cleanup };
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
  const { server, port, cleanup, store } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    store.append('scope/tasks.tsv', { ID: 'T1', TITLE: 'Old task', STATUS: 'open', DUE_DATE: '2020-01-01' });
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
  const { server, port, cleanup, store } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    store.append('finance/ventures.tsv', { ID: 'V1', NAME: 'WellPath', RENDER_URL: '-' });
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
