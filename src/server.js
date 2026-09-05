#!/usr/bin/env node
'use strict';
/**
 * pulse engine -- HTTP entry point.
 *
 * Boot sequence (matches vault's own): secrets -> local store (shares
 * vault's memory/ directory on this host, see lib/store.js's doc comment
 * for the known same-host limitation) -> capability clients wired to
 * resolved config -> bind. Deliberately zero-framework, matching the style
 * of every engine extracted so far.
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createStore } = require('../lib/store');
const { createGithubClient } = require('../lib/github');
const { createTelegramBot } = require('../lib/telegram');
const { createBufferClient } = require('../lib/buffer');
const { createFinanceClient } = require('../lib/finance');
const { createNotificationsClient } = require('../lib/notifications');
const { createDatesClient } = require('../lib/dates');
const { createCalendarClient } = require('../lib/calendar');
const { createDataHealthClient } = require('../lib/data-health');
const { createRhythmClient } = require('../lib/rhythm');
const { createProjectsClient } = require('../lib/projects');
const { createGraphClient } = require('../lib/graph');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.PULSE_PORT || process.env.PORT || '8082', 10);
const BIND = process.env.PULSE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const LOGS_DIR = process.env.PULSE_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
// Reminded-state is pulse's own ephemeral bookkeeping (which reminders it has
// already sent), not vault-owned data -- stays local. Calendar events and
// rhythm state used to be plain local JSON files too (a known gap: broke the
// moment pulse ran on a different host than vault), now go through vault's
// /vault-raw/:collection, same as TSV data goes through /vault/:collection.
const REMINDED_FILE = process.env.PULSE_REMINDED_FILE || path.join(__dirname, '..', 'runtime', 'reminded.json');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readJsonFile(fp, fallback) {
  const fs = require('fs');
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
async function writeJsonFile(fp, data) {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

/** Static-token check only -- pulse defers real login (TOTP/PIN/session) to vault; this just gates who may call pulse directly (hub, or a developer) with a shared credential. */
let _devAuthBypassLog = null; // set once main() creates auditLog; used by ISCONL_DEV_NO_AUTH (BS26090501)

function checkAuth(req) {
  // BS26090501: dev-only, loopback-gated (enforced at boot below), env-only -- never request-derived.
  if (process.env.ISCONL_DEV_NO_AUTH === '1') {
    if (_devAuthBypassLog) _devAuthBypassLog.log('dev_auth_bypass', { engine: 'pulse', path: req.url });
    return true;
  }
  const token = process.env.PULSE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('PULSE_TOKEN') || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

async function main() {
  // -- 1. Secrets -------------------------------------------------------------
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  // -- 2. Audit log -------------------------------------------------------------
  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  _devAuthBypassLog = auditLog;

  // -- 3. Remote store (HTTP client against vault) -----------------------------
  if (!VAULT_URL) {
    console.error('  REFUSING TO START: VAULT_URL is not configured -- pulse has no data store without it.');
    process.exit(1);
  }
  const store = createStore({
    baseUrl: VAULT_URL,
    getToken: () => process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    auditLog,
  });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  // JSON state read/write through vault's raw store, replacing the old
  // local-file readEvents/writeEvents/readState/writeState below.
  async function readRawJson(collection, fallback) {
    try {
      const text = await store.rawRead(collection);
      return text ? JSON.parse(text) : fallback;
    } catch { return fallback; }
  }
  const writeRawJson = (collection, data) => store.rawWrite(collection, JSON.stringify(data, null, 2));

  // -- 4. Capability clients ---------------------------------------------------
  const github = createGithubClient({
    getToken: () => secretStore.get('GITHUB_TOKEN') || '',
    getOwner: () => process.env.GITHUB_OWNER || secretStore.get('GITHUB_OWNER') || '',
    auditLog,
    cacheFile: path.join(__dirname, '..', 'runtime', 'gh-contributions-cache.json'),
  });

  const telegram = createTelegramBot({
    getBotToken: () => secretStore.get('TELEGRAM_BOT_TOKEN') || '',
    getChatId: () => secretStore.get('TELEGRAM_CHAT_ID') || '',
    auditLog,
  });

  const buffer = createBufferClient({
    getAccessToken: () => secretStore.get('BUFFER_ACCESS_TOKEN') || '',
    auditLog,
  });

  const finance = createFinanceClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    getSecret: (name) => secretStore.get(name) || null,
    driveDir: process.env.FINANCE_DRIVE_DIR || '',
    defaultCurrency: process.env.FINANCE_DEFAULT_CURRENCY || '-',
  });

  const dates = createDatesClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    sendReminder: (msg) => telegram.send(msg),
    readReminded: () => readJsonFile(REMINDED_FILE, {}),
    writeReminded: (l) => writeJsonFile(REMINDED_FILE, l),
  });

  // Microsoft Graph client, so calendar.listEvents() can actually merge in
  // live Microsoft 365 events instead of only ever returning the local
  // scope/calendar_events.json snapshot (found 17 Aug: createCalendarClient
  // was wired with no graphRequest at all, so its M365 branch never ran --
  // the calendar view had been stuck on whatever was last hand-imported,
  // 2026-08-07, with nothing after that ever appearing. See task-backlog.md).
  // Same credential-resolution pattern as vault/src/server.js's own Graph
  // client -- MSGRAPH_* secrets are shared across the fleet in Bitwarden,
  // each engine reads them independently, same as github.js's GITHUB_TOKEN.
  let graphConfig = {
    clientId: process.env.MSGRAPH_CLIENT_ID || secretStore.get('MSGRAPH_CLIENT_ID') || '',
    clientSecret: process.env.MSGRAPH_CLIENT_SECRET || secretStore.get('MSGRAPH_CLIENT_SECRET') || '',
    accessToken: process.env.MSGRAPH_ACCESS_TOKEN || '',
    refreshToken: secretStore.get('MSGRAPH_REFRESH_TOKEN') || '',
    tenantId: process.env.MSGRAPH_TENANT_ID || secretStore.get('MSGRAPH_TENANT_ID') || '',
  };
  const graph = createGraphClient({
    getConfig: () => graphConfig,
    setConfig: (patch) => { graphConfig = { ...graphConfig, ...patch }; },
    onTokenRefreshed: async (accessToken, refreshToken) => {
      await secretStore.persistSecret('MSGRAPH_REFRESH_TOKEN', refreshToken, 'Rotated by pulse on token refresh');
    },
    auditLog,
  });

  // calendar.notify and notifications.fetchCalendarEvents/fetchDates each need
  // the OTHER module, which doesn't exist yet at this point -- broken via a
  // closure indirection assigned below, since each factory closes over its
  // `notify` param at construction time (reassigning a property on the
  // returned object afterwards would NOT reach the closure that actually uses it).
  // BG26082005: one raw HTTP call to vault's own /google/calendar per
  // connected account label -- same GOOGLE_ACCOUNTS env var vault itself
  // reads, so a label only needs registering once, not twice. Fails soft
  // per-account (a not-yet-signed-in label 401s, skipped, not thrown) and
  // overall (a vault outage degrades to no Google events, same as
  // graphRequest's own try/catch above), never blocks the local-events
  // merge listEvents() already guarantees.
  const GOOGLE_CALENDAR_ACCOUNTS = (process.env.GOOGLE_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  async function fetchOneGoogleCalendar(account) {
    return new Promise((resolve) => {
      const url = new URL(`/google/calendar?account=${encodeURIComponent(account)}`, VAULT_URL);
      const lib = url.protocol === 'https:' ? require('https') : http;
      const req = lib.request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || ''}` },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed.ok ? parsed.events : []);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.end();
    });
  }
  async function fetchGoogleCalendarEvents() {
    if (!GOOGLE_CALENDAR_ACCOUNTS.length) return [];
    const results = await Promise.all(GOOGLE_CALENDAR_ACCOUNTS.map(fetchOneGoogleCalendar));
    return results.flat();
  }

  let notifyFn = null;
  const calendar = createCalendarClient({
    readEvents: () => readRawJson('scope/calendar_events.json', []),
    writeEvents: (e) => writeRawJson('scope/calendar_events.json', e),
    auditLog,
    graphRequest: graph.graphRequest,
    addTask: async (task) => appendTSV('scope/tasks.tsv', task),
    notify: (n) => notifyFn ? notifyFn(n) : false,
    readDates: () => readTSV('scope/dates.tsv'),
    googleCalendarFetch: fetchGoogleCalendarEvents,
  });

  const notifications = createNotificationsClient({
    readTSV, appendTSV, rewriteTSV, auditLog,
    githubApi: github.githubApi,
    wellspringRepo: process.env.ISCONL_WELLSPRING_REPO || '',
    wellspringSelf: process.env.ISCONL_WELLSPRING_SELF || '',
    fetchCalendarEvents: () => calendar.listEvents(),
    fetchDates: async () => dates.computeDates(),
  });
  notifyFn = notifications.notify;

  const dataHealth = createDataHealthClient({ readTSV });

  const rhythm = createRhythmClient({
    readTSV,
    readState: () => readRawJson('personal/rhythm.json', { habits: [], logs: {} }),
    writeState: (s) => writeRawJson('personal/rhythm.json', s),
  });

  const projects = createProjectsClient({ readTSV, rewriteTSV, auditLog });

  // -- 5. FAIL CLOSED bind guard (same rule as vault) --------------------------
  const tokenConfigured = !!(process.env.PULSE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('PULSE_TOKEN'));
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (process.env.ISCONL_DEV_NO_AUTH === '1' && !isLoopback) {
    console.error('  REFUSING TO BIND: ISCONL_DEV_NO_AUTH is set but BIND is not loopback -- dev auth bypass is loopback-only.');
    process.exit(1);
  }
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no PULSE_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  // -- 6. Routes ----------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'pulse', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/finance/summary' && req.method === 'GET') {
        return sendJson(res, 200, await finance.summary());
      }
      if (pathname === '/finance/accounts' && req.method === 'POST') {
        return sendJson(res, 200, await finance.upsertAccount(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/finance/transactions' && req.method === 'POST') {
        return sendJson(res, 200, await finance.addTransaction(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/finance/incomes' && req.method === 'POST') {
        return sendJson(res, 200, await finance.upsertIncome(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/finance/ventures' && req.method === 'POST') {
        return sendJson(res, 200, await finance.upsertVenture(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/notifications' && req.method === 'GET') {
        return sendJson(res, 200, { notifications: await notifications.listNotifications({ limit: parseInt(url.searchParams.get('limit') || '100', 10) }) });
      }
      if (pathname === '/notifications/sweep' && req.method === 'POST') {
        const raised = await notifications.notificationSweep({ deep: url.searchParams.get('deep') !== 'false' });
        return sendJson(res, 200, { success: true, raised });
      }
      if (pathname === '/notifications/seen' && req.method === 'POST') {
        return sendJson(res, 200, { success: true, ...(await notifications.markSeen(JSON.parse(await readBody(req) || '{}'))) });
      }

      if (pathname === '/dates' && req.method === 'GET') {
        return sendJson(res, 200, await dates.listDates());
      }
      if (pathname === '/dates' && req.method === 'POST') {
        return sendJson(res, 200, await dates.addDate(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/dates/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await dates.deleteDate(p.id));
      }
      if (pathname === '/dates/remind' && req.method === 'POST') {
        return sendJson(res, 200, await dates.sendDueReminders());
      }

      if (pathname === '/calendar/events' && req.method === 'GET') {
        return sendJson(res, 200, { events: await calendar.listEvents() });
      }
      if (pathname === '/calendar/events' && req.method === 'POST') {
        return sendJson(res, 200, await calendar.addEvent(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/calendar/events/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await calendar.deleteEvent(p.id));
      }
      if (pathname === '/calendar/import' && req.method === 'POST') {
        return sendJson(res, 200, await calendar.importEvents(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/calendar/export' && req.method === 'GET') {
        // JSON-wrapped raw text (not a text/calendar response) -- same
        // pattern the Writer download flow already uses (base64 JSON,
        // client builds the Blob) rather than introducing a second
        // response shape into this engine.
        return sendJson(res, 200, { ok: true, ics: await calendar.exportIcs() });
      }

      if (pathname === '/health/data' && req.method === 'GET') {
        return sendJson(res, 200, await dataHealth.checkDataHealth());
      }

      if (pathname === '/rhythm' && req.method === 'GET') {
        return sendJson(res, 200, await rhythm.getRhythm());
      }
      if (pathname === '/rhythm' && req.method === 'POST') {
        return sendJson(res, 200, await rhythm.updateRhythm(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/insights' && req.method === 'GET') {
        return sendJson(res, 200, await rhythm.getInsights());
      }

      // BA26090501: Sconl's own CV/resume/portfolio links, phase 1 (simple
      // curated list) -- same readRawJson/writeRawJson('personal/*.json')
      // pattern as rhythm above, no dedicated lib module needed for a plain
      // list. Phase 2 (a real "live portfolio" product) is a future,
      // separate build, not scoped here.
      if (pathname === '/portfolio' && req.method === 'GET') {
        return sendJson(res, 200, await readRawJson('personal/portfolio.json', { items: [] }));
      }
      if (pathname === '/portfolio' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const items = Array.isArray(body.items) ? body.items.map(it => ({
          title: String(it.title || '').trim(),
          url: String(it.url || '').trim(),
          note: String(it.note || '').trim(),
        })).filter(it => it.title && it.url) : [];
        await writeRawJson('personal/portfolio.json', { items });
        return sendJson(res, 200, { ok: true, items });
      }

      if (pathname === '/projects' && req.method === 'GET') {
        return sendJson(res, 200, { projects: await projects.listProjects() });
      }
      if (pathname === '/projects/url' && req.method === 'POST') {
        return sendJson(res, 200, await projects.setProjectUrl(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/github/contributions' && req.method === 'GET') {
        return sendJson(res, 200, await github.getContributions({ force: url.searchParams.get('force') === 'true' }));
      }
      if (pathname === '/github/snapshot' && req.method === 'GET') {
        return sendJson(res, 200, await github.getSnapshot());
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  pulse listening on ${BIND}:${actualPort}`);
      resolve({ server, store, github, telegram, buffer, finance, notifications, dates, calendar, dataHealth, rhythm, projects, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('pulse failed to start:', e); process.exit(1); });
}

module.exports = { main };
