'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRhythmClient, AUTO_HABITS } = require('../lib/rhythm');

function makeReadTSV(seed) {
  return async (rel) => (seed[rel] || []).slice();
}

test('createRhythmClient throws without readTSV', () => {
  assert.throws(() => createRhythmClient({}));
});

test('FI26091507: an empty store seeds only the auto-detected habits, and says they are seeded', async () => {
  const client = createRhythmClient({ readTSV: makeReadTSV({}) });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.deepEqual(r.habits.map(h => h.id), ['h-gh', 'h-learn', 'h-journal', 'h-tasks']);
  assert.ok(r.habits.every(h => h.seeded === true),
    'a habit the user never created must say so, or the grid claims to be their list');
});

test('FI26091507: no invented personal habit is ever served', async () => {
  const client = createRhythmClient({ readTSV: makeReadTSV({}) });
  const r = await client.getRhythm(new Date('2026-08-09'));
  const titles = r.habits.map(h => h.title);
  for (const invented of ['Workout / Exercise', 'Deep Reading', 'Meditation & Focus']) {
    assert.ok(!titles.includes(invented), `${invented} was never the user's habit`);
  }
  // Every seeded habit must be backed by an auto-detection this engine really
  // performs -- otherwise it is content again, just a shorter list of it.
  assert.ok(r.habits.every(h => h.auto), 'a seeded habit with no auto source is invented content');
});

test('a stored habit list is served as-is, never merged with the seeds', async () => {
  const mine = [{ id: 'h-swim', title: 'Swim', auto: null, icon: '🏊' }];
  const client = createRhythmClient({
    readTSV: makeReadTSV({}),
    readState: async () => ({ habits: mine, logs: {} }),
  });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.deepEqual(r.habits, mine);
});

test('getRhythm auto-detects a journal entry written today from spark/journal.tsv (the bug fix)', async () => {
  const client = createRhythmClient({
    readTSV: makeReadTSV({ 'spark/journal.tsv': [{ DATE: '2026-08-09' }] }),
  });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.equal(r.logs['2026-08-09']['h-journal'], true);
});

test('getRhythm does NOT read the old bugged journal.tsv path', async () => {
  const client = createRhythmClient({
    readTSV: makeReadTSV({ 'journal.tsv': [{ DATE: '2026-08-09' }] }),
  });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.equal(r.logs['2026-08-09']['h-journal'], undefined);
});

test('getRhythm auto-detects a completed task and a learning update today', async () => {
  const client = createRhythmClient({
    readTSV: makeReadTSV({
      'scope/tasks.tsv': [{ STATUS: 'done', UPDATED_AT: '2026-08-09' }],
      'learning/resume.tsv': [{ UPDATED_AT: '2026-08-09' }],
    }),
  });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.equal(r.logs['2026-08-09']['h-tasks'], true);
  assert.equal(r.logs['2026-08-09']['h-learn'], true);
});

test('getRhythm returns a 365-day days array ending today', async () => {
  const client = createRhythmClient({ readTSV: makeReadTSV({}) });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.equal(r.days.length, 365);
  assert.equal(r.days[r.days.length - 1].date, '2026-08-09');
});

test('updateRhythm toggles a habit for a given date and persists via writeState', async () => {
  let saved = null;
  const client = createRhythmClient({
    readTSV: makeReadTSV({}),
    readState: async () => ({ habits: AUTO_HABITS, logs: {} }),
    writeState: async (s) => { saved = s; },
  });
  const r = await client.updateRhythm({ toggleHabit: { date: '2026-08-09', habitId: 'h-exercise', done: true } });
  assert.equal(r.rhythm.logs['2026-08-09']['h-exercise'], true);
  assert.equal(saved.logs['2026-08-09']['h-exercise'], true);
});

test('getInsights serves only what the override store holds', async () => {
  const client = createRhythmClient({
    readTSV: makeReadTSV({}),
    readInsightsOverride: async () => ({ finance: { title: 'Custom', category: 'x', text: 'y', tone: 'gold' } }),
  });
  const r = await client.getInsights();
  assert.equal(r.insights.finance.title, 'Custom');
  assert.equal(r.available, true);
  assert.deepEqual(Object.keys(r.insights), ['finance'],
    'an unset category must stay unset rather than being filled with writing nobody asked for');
});

test('FI26091507: with no override store wired -- which is production today -- insights are empty and say so', async () => {
  const client = createRhythmClient({ readTSV: makeReadTSV({}) });
  const r = await client.getInsights();
  assert.deepEqual(r.insights, {});
  assert.equal(r.available, false,
    'a consumer must be able to show an empty state instead of fabricated analysis');
});
