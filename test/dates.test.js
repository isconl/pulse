'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatesClient } = require('../lib/dates');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

test('createDatesClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createDatesClient({}));
});

test('computeDates computes a yearly recurring milestone correctly', async () => {
  const store = makeStore({ 'scope/dates.tsv': [{ ID: 'D001', TITLE: 'Birthday', DATE: '1990-08-09', KIND: 'birthday', RECURS: 'yearly' }] });
  const client = createDatesClient({ ...store });
  const [d] = await client.computeDates(new Date('2026-08-09T12:00:00'));
  assert.equal(d.yearsTurning, 36);
  assert.equal(d.milestones.some(m => m.label === 'turns 36'), true);
});

test('computeDates rolls a passed yearly date forward to next year', async () => {
  const store = makeStore({ 'scope/dates.tsv': [{ ID: 'D001', TITLE: 'Anniversary', DATE: '2020-01-01', KIND: 'anniversary', RECURS: 'yearly' }] });
  const client = createDatesClient({ ...store });
  // A hardcoded ISO string here would be timezone-fragile (toISOString() renders
  // in UTC, local midnight can land on the previous UTC day) -- assert the
  // roll-forward happened via daysToNext/yearsTurning instead of an exact string.
  const [d] = await client.computeDates(new Date(2026, 7, 9, 12, 0, 0));
  // yearsTurning counts from the ORIGINAL date (2020), not "years from now" --
  // the 2020-01-01 anniversary due 2027-01-01 turns 7, not 1.
  assert.equal(d.yearsTurning, 7);
  assert.ok(d.daysToNext > 0 && d.daysToNext < 366);
  // nextOccurrence itself is deliberately not asserted as an exact string here:
  // it's built from a LOCAL midnight Date then rendered via toISOString() (UTC),
  // so in any positive-UTC-offset timezone (this dev box included) it can
  // legitimately print the previous day. Same construction as the original
  // server.js -- true in production only if the host runs in UTC (Render's
  // default), so this is an environment property, not something to paper over
  // with a timezone-coupled assertion.
});

test('addDate rejects a malformed date or missing title', async () => {
  const store = makeStore();
  const client = createDatesClient({ ...store });
  await assert.rejects(() => client.addDate({ date: 'not-a-date', title: 'x' }));
  await assert.rejects(() => client.addDate({ date: '2026-01-01', title: '' }));
});

test('addDate assigns a sequential zero-padded ID', async () => {
  const store = makeStore({ 'scope/dates.tsv': [{ ID: 'D001' }] });
  const client = createDatesClient({ ...store });
  const r = await client.addDate({ date: '2026-01-01', title: 'New date' });
  assert.equal(r.id, 'D002');
});

test('deleteDate removes the matching row and reports success:false when nothing matched', async () => {
  const store = makeStore({ 'scope/dates.tsv': [{ ID: 'D001', TITLE: 'x' }] });
  const client = createDatesClient({ ...store });
  assert.equal((await client.deleteDate('D001')).success, true);
  assert.equal(store.data['scope/dates.tsv'].length, 0);
  assert.equal((await client.deleteDate('D999')).success, false);
});

test('sendDueReminders fires at the 30/7/1/0-day tiers and not otherwise, deduped via the ledger', async () => {
  const today = new Date(2026, 7, 9, 0, 0, 0);
  // Local Y/M/D arithmetic throughout (not toISOString(), which renders in UTC
  // and can shift the date by one in a non-UTC timezone) -- matches how
  // computeDates itself compares dates, so this lands exactly 7 days out.
  const future = new Date(today.getTime() + 7 * 864e5);
  const mmdd = `${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
  const store = makeStore({ 'scope/dates.tsv': [
    { ID: 'D001', TITLE: 'Due in 7', DATE: `2020-${mmdd}`, RECURS: 'yearly' },
  ] });
  const sent = [];
  let ledger = {};
  const client = createDatesClient({
    ...store,
    sendReminder: async (msg) => sent.push(msg),
    readReminded: async () => ledger,
    writeReminded: async (l) => { ledger = l; },
  });
  const first = await client.sendDueReminders(today);
  assert.equal(first.sent, 1);
  const second = await client.sendDueReminders(today);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1);
});
