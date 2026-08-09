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
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.PULSE_PORT || process.env.PORT || '8082', 10);
const BIND = process.env.PULSE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const LOGS_DIR = process.env.PULSE_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
// Calendar events and rhythm state are still plain JSON files on pulse's own
// disk, not vault-owned TSV rows -- only TSV data moved to the remote store.
const LOCAL_DIR = process.env.PULSE_LOCAL_DIR || path.join(__dirname, '..', 'memory');
const EVENTS_FILE = process.env.PULSE_EVENTS_FILE || path.join(LOCAL_DIR, 'scope', 'calendar_events.json');
const RHYTHM_FILE = process.env.PULSE_RHYTHM_FILE || path.join(LOCAL_DIR, 'personal', 'rhythm.json');
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
function checkAuth(req) {
  const token = process.env.PULSE_TOKEN || process.env.ISCONL_TOKEN || '';
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

  // calendar.notify and notifications.fetchCalendarEvents/fetchDates each need
  // the OTHER module, which doesn't exist yet at this point -- broken via a
  // closure indirection assigned below, since each factory closes over its
  // `notify` param at construction time (reassigning a property on the
  // returned object afterwards would NOT reach the closure that actually uses it).
  let notifyFn = null;
  const calendar = createCalendarClient({
    readEvents: () => readJsonFile(EVENTS_FILE, []),
    writeEvents: (e) => writeJsonFile(EVENTS_FILE, e),
    auditLog,
    addTask: async (task) => appendTSV('scope/tasks.tsv', task),
    notify: (n) => notifyFn ? notifyFn(n) : false,
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
    readState: () => readJsonFile(RHYTHM_FILE, { habits: [], logs: {} }),
    writeState: (s) => writeJsonFile(RHYTHM_FILE, s),
  });

  const projects = createProjectsClient({ readTSV, rewriteTSV, auditLog });

  // -- 5. FAIL CLOSED bind guard (same rule as vault) --------------------------
  const tokenConfigured = !!(process.env.PULSE_TOKEN || process.env.ISCONL_TOKEN);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
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

      if (pathname === '/projects' && req.method === 'GET') {
        return sendJson(res, 200, { projects: await projects.listProjects() });
      }
      if (pathname === '/projects/url' && req.method === 'POST') {
        return sendJson(res, 200, await projects.setProjectUrl(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/github/contributions' && req.method === 'GET') {
        return sendJson(res, 200, await github.getContributions({ force: url.searchParams.get('force') === 'true' }));
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
