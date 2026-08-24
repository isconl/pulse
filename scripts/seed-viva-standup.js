'use strict';
// One-off/re-runnable: seed 8 upcoming Monday-9am "Standup with Alex" events
// onto the calendar (BT26082401, split from PT26082107). No recurrence field
// exists on calendar.js's events yet, so this pre-generates dated events
// instead -- see PT26082107 for the deferred bigger recurrence-engine design.
// Safe to re-run: skips any Monday that already has a same-title/same-date
// event (checked via listEvents() with no graphRequest injected, so it only
// ever sees local events, never Microsoft 365's).
//
// Usage: node scripts/seed-viva-standup.js [occurrences]  (default 8)

const secretStore = require('../lib/secrets');
const { createStore } = require('../lib/store');
const { createCalendarClient } = require('../lib/calendar');
const { createAuditLog } = require('../lib/audit');

function nextMondays(count) {
  const dates = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const daysUntilMonday = (8 - d.getUTCDay()) % 7 || 7;   // always the NEXT Monday, never today even if today is one
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  for (let i = 0; i < count; i++) {
    dates.push(new Date(d.getTime() + i * 7 * 864e5).toISOString().slice(0, 10));
  }
  return dates;
}

async function main() {
  const occurrences = parseInt(process.argv[2], 10) || 8;
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

  const existing = await calendar.listEvents();   // no graphRequest injected -- local events only
  const seen = new Set(existing.filter(e => e.title === 'Standup with Alex').map(e => e.date));

  let added = 0, skipped = 0;
  for (const date of nextMondays(occurrences)) {
    if (seen.has(date)) { skipped++; continue; }
    await calendar.addEvent({
      title: 'Standup with Alex', date, time: '09:00', category: 'work',
      tag: 'viva', origin: 'corporate:viva',
    });
    added++;
  }
  console.log(`Seeded ${added} Standup with Alex event(s), skipped ${skipped} already on the calendar.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
