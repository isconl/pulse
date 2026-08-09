'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRhythmClient, DEFAULT_HABITS, DEFAULT_INSIGHTS } = require('../lib/rhythm');

function makeReadTSV(seed) {
  return (rel) => (seed[rel] || []).slice();
}

test('createRhythmClient throws without readTSV', () => {
  assert.throws(() => createRhythmClient({}));
});

test('getRhythm seeds the default habit list when no state exists yet', async () => {
  const client = createRhythmClient({ readTSV: makeReadTSV({}) });
  const r = await client.getRhythm(new Date('2026-08-09'));
  assert.deepEqual(r.habits, DEFAULT_HABITS);
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
    readState: async () => ({ habits: DEFAULT_HABITS, logs: {} }),
    writeState: async (s) => { saved = s; },
  });
  const r = await client.updateRhythm({ toggleHabit: { date: '2026-08-09', habitId: 'h-exercise', done: true } });
  assert.equal(r.rhythm.logs['2026-08-09']['h-exercise'], true);
  assert.equal(saved.logs['2026-08-09']['h-exercise'], true);
});

test('getInsights merges an override on top of the defaults, keeping unset categories', async () => {
  const client = createRhythmClient({
    readTSV: makeReadTSV({}),
    readInsightsOverride: async () => ({ finance: { title: 'Custom', category: 'x', text: 'y', tone: 'gold' } }),
  });
  const r = await client.getInsights();
  assert.equal(r.insights.finance.title, 'Custom');
  assert.deepEqual(r.insights.rhythm, DEFAULT_INSIGHTS.rhythm);
});
