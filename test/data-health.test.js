'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataHealthClient } = require('../lib/data-health');

function makeReadTSV(seed) {
  return (rel) => (seed[rel] || []).slice();
}

test('createDataHealthClient throws without readTSV', () => {
  assert.throws(() => createDataHealthClient({}));
});

test('checkDataHealth flags a task with no WHY', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [{ ID: 'T1', WHY: '-', STATUS: 'next' }], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  assert.equal(r.issues.some(i => i.area === 'tasks' && i.text.includes('no explanation')), true);
});

test('checkDataHealth flags a done task missing RESOLUTION', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [{ ID: 'T1', WHY: 'x', STATUS: 'done', RESOLUTION: '-' }], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  assert.equal(r.issues.some(i => i.text.includes('not say why')), true);
});

test('checkDataHealth flags an overdue open task as info severity (not critical for healthy:)', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [{ ID: 'T1', WHY: 'x', STATUS: 'next', DUE_DATE: '2020-01-01' }], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  const issue = r.issues.find(i => i.area === 'tasks' && i.text.includes('past due'));
  assert.equal(issue.severity, 'info');
  assert.equal(r.healthy, true); // only info-severity issues -> still "healthy"
});

test('checkDataHealth flags a stale account balance older than a week', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [], 'finance/accounts.tsv': [{ NAME: 'KCB', ASOF: '2026-07-01' }], 'scope/inbox.tsv': [] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  assert.equal(r.issues.some(i => i.area === 'finance'), true);
});

test('checkDataHealth flags an unread inbox message older than 3 days', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [{ STATUS: 'new', CAPTURED_AT: '2026-08-01' }] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  assert.equal(r.issues.some(i => i.area === 'inbox'), true);
});

test('checkDataHealth reports healthy:true and no issues on a clean vault', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  assert.equal(r.healthy, true);
  assert.deepEqual(r.issues, []);
});

test('checkDataHealth detects an HTML error page masquerading as vault data (corruption)', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
    listVaultFiles: async () => ['circle/people.tsv'],
    readVaultFileRaw: async () => '<!DOCTYPE html><html>Sign in to SharePoint</html>',
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  const issue = r.issues.find(i => i.area === 'corruption');
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.equal(r.healthy, false);
});

test('checkDataHealth detects schema drift (a file missing an expected column)', async () => {
  const client = createDataHealthClient({
    readTSV: makeReadTSV({ 'scope/tasks.tsv': [], 'finance/accounts.tsv': [], 'scope/inbox.tsv': [] }),
    vaultSchema: { 'circle/people.tsv': 'ID\tNAME\tCIRCLE' },
    readVaultFileRaw: async () => 'ID\tNAME\n',
  });
  const r = await client.checkDataHealth(new Date('2026-08-09'));
  const issue = r.issues.find(i => i.area === 'schema');
  assert.ok(issue);
  assert.match(issue.text, /CIRCLE/);
});
