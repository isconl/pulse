'use strict';
// One-off/re-runnable: seed a recurring "Rotate isconl secrets" calendar
// event every 4 weeks (BI26082401, resolved from PI26082010). Same
// mechanism as BT26082401's standup seeding -- no recurrence field exists
// on calendar.js's events yet, so this pre-generates dated events instead.
// Manual checklist, not automation: every secret has live dependents, so
// rotation itself stays a human action -- this only reminds and lists.
//
// The checklist is pulled live from `bws secret list` (key-only, per the
// standing key-only-secrets rule -- values are never read or printed) at
// seed time, not hardcoded, so it tracks the project's real secret set as
// it changes. NON_ROTATABLE below is an editorial classification (plain
// config/identifiers that don't need rotating, e.g. a tenant ID or a
// client ID) -- maintain this list as new non-secret keys get added.
//
// Usage: node scripts/seed-secret-rotation-reminder.js [occurrences]  (default 6, ~6 months)

const { execFileSync } = require('child_process');
const secretStore = require('../lib/secrets');
const { createStore } = require('../lib/store');
const { createCalendarClient } = require('../lib/calendar');
const { createAuditLog } = require('../lib/audit');

const NON_ROTATABLE = new Set([
  'JIRA_EMAIL', 'JIRA_HOST', 'JIRA_PROJECT', 'GITHUB_OWNER',
  'ISCONL_TELEGRAM_CHAT_ID', 'MSGRAPH_TENANT_ID',
  // BI26083005: VAULT_SYNC_INTERVAL_MS renamed VAULT_BACKUP_INTERVAL_MS
  // (OneDrive is backup-only now). Kept both here -- the old Bitwarden
  // secret is left in place, not deleted (config value, not a real
  // secret; harmless orphan) -- until a deliberate cleanup pass removes it.
  'VAULT_SYNC_INTERVAL_MS', 'VAULT_BACKUP_INTERVAL_MS',
  'MSGRAPH_CLIENT_ID', 'GOOGLE_CLIENT_ID',
]);

function liveSecretKeys() {
  const raw = execFileSync('bws', ['secret', 'list'], { encoding: 'utf8' });
  return JSON.parse(raw).map((s) => s.key).sort();
}

function every4Weeks(count) {
  const dates = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    dates.push(new Date(d.getTime() + i * 28 * 864e5).toISOString().slice(0, 10));
  }
  return dates;
}

async function main() {
  const occurrences = parseInt(process.argv[2], 10) || 6;
  await secretStore.init();

  const VAULT_URL = process.env.VAULT_URL || '';
  if (!VAULT_URL) {
    console.error('VAULT_URL is not configured -- pulse has no data store without it.');
    process.exit(1);
  }
  const auditLog = createAuditLog({ logsDir: require('path').join(__dirname, '..', 'runtime', 'logs') });
  const store = createStore({
    baseUrl: VAULT_URL,
    getToken: () => process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    auditLog,
  });
  const readRawJson = async (collection, fallback) => {
    try { const text = await store.rawRead(collection); return text ? JSON.parse(text) : fallback; }
    catch { return fallback; }
  };
  const writeRawJson = (collection, data) => store.rawWrite(collection, JSON.stringify(data, null, 2));

  const calendar = createCalendarClient({
    readEvents: () => readRawJson('scope/calendar_events.json', []),
    writeEvents: (e) => writeRawJson('scope/calendar_events.json', e),
    auditLog,
  });

  const allKeys = liveSecretKeys();
  const rotatable = allKeys.filter((k) => !NON_ROTATABLE.has(k));
  const checklist = rotatable.map((k) => `- [ ] ${k}`).join('\n');
  const body = `Rotate these ${rotatable.length} Bitwarden secrets (isconl project). Update in Bitwarden, then any live consumer that caches the old value (restart affected engines).\n\n${checklist}`;

  const existing = await calendar.listEvents();
  const seen = new Set(existing.filter(e => e.title === 'Rotate isconl secrets').map(e => e.date));

  let added = 0, skipped = 0;
  for (const date of every4Weeks(occurrences)) {
    if (seen.has(date)) { skipped++; continue; }
    await calendar.addEvent({
      title: 'Rotate isconl secrets', date, time: '09:00', category: 'work',
      body, tag: 'security', origin: 'secret-rotation-reminder',
    });
    added++;
  }
  console.log(`Seeded ${added} rotation reminder(s), skipped ${skipped} already on the calendar. Checklist has ${rotatable.length} rotatable key(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
