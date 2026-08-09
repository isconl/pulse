'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationsClient } = require('../lib/notifications');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
  };
}

function makeClient(overrides = {}) {
  const store = makeStore(overrides.seed);
  const logs = [];
  const client = createNotificationsClient({
    readTSV: store.readTSV,
    appendTSV: store.appendTSV,
    auditLog: { log: (event, data) => logs.push({ event, data }) },
    ...overrides,
  });
  return { client, store, logs };
}

test('createNotificationsClient throws without readTSV/appendTSV', () => {
  assert.throws(() => createNotificationsClient({}));
});

test('notify() appends a new row and returns true', () => {
  const { client, store } = makeClient();
  const ok = client.notify({ source: 'tasks', kind: 'due-today', title: 'Ship the thing' });
  assert.equal(ok, true);
  assert.equal(store.data['notifications.tsv'].length, 1);
  assert.equal(store.data['notifications.tsv'][0].STATUS, 'new');
});

test('notify() is deduped by DEDUPE_KEY -- a repeat notice is dropped, not appended twice', () => {
  const { client, store } = makeClient();
  client.notify({ source: 'tasks', kind: 'due-today', title: 'Ship the thing', dedupeKey: 'task-due:T1:2026-08-09' });
  const second = client.notify({ source: 'tasks', kind: 'due-today', title: 'Ship the thing', dedupeKey: 'task-due:T1:2026-08-09' });
  assert.equal(second, false);
  assert.equal(store.data['notifications.tsv'].length, 1);
});

test('notify() falls back to source:kind:title as the dedupe key when none is given', () => {
  const { client, store } = makeClient();
  client.notify({ source: 'x', kind: 'y', title: 'z' });
  client.notify({ source: 'x', kind: 'y', title: 'z' });
  assert.equal(store.data['notifications.tsv'].length, 1);
});

test('notificationSweep raises an overdue-task notice read directly from scope/tasks.tsv', async () => {
  const { client, store } = makeClient({
    seed: { 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'Renew SSH keys', STATUS: 'open', DUE_DATE: '2020-01-01', PRIORITY: 'high' }] },
  });
  const raised = await client.notificationSweep();
  assert.equal(raised, 1);
  assert.equal(store.data['notifications.tsv'][0].SOURCE, 'tasks');
  assert.equal(store.data['notifications.tsv'][0].KIND, 'overdue');
});

test('notificationSweep skips a done task and a task with no due date', async () => {
  const { client } = makeClient({
    seed: { 'scope/tasks.tsv': [
      { ID: 'T1', TITLE: 'a', STATUS: 'done', DUE_DATE: '2020-01-01' },
      { ID: 'T2', TITLE: 'b', STATUS: 'open', DUE_DATE: '-' },
    ] },
  });
  const raised = await client.notificationSweep();
  assert.equal(raised, 0);
});

test('notificationSweep raises income-late from pulse\'s own finance ledgers, keyed off DAY vs today', async () => {
  const future = new Date(); future.setDate(1); // day 1 of the month -- any DAY < today's date qualifies as late
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth < 2) return; // test only meaningful past the 1st
  const { client, store } = makeClient({
    seed: {
      'finance/incomes.tsv': [{ ID: 'I1', NAME: 'Salary', STATUS: 'active', RECURS: 'monthly', DAY: '1', MATCH: 'salary' }],
      'finance/transactions.tsv': [],
    },
  });
  const raised = await client.notificationSweep();
  assert.equal(raised, 1);
  assert.equal(store.data['notifications.tsv'][0].SOURCE, 'finance');
  assert.equal(store.data['notifications.tsv'][0].KIND, 'income-late');
});

test('notificationSweep does not raise income-late once a matching transaction has landed', async () => {
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth < 2) return;
  const month = new Date().toISOString().slice(0, 7);
  const { client } = makeClient({
    seed: {
      'finance/incomes.tsv': [{ ID: 'I1', NAME: 'Salary', STATUS: 'active', RECURS: 'monthly', DAY: '1', MATCH: 'salary' }],
      'finance/transactions.tsv': [{ TYPE: 'income', DATE: `${month}-05`, DESCRIPTION: 'Salary payment', CATEGORY: 'salary' }],
    },
  });
  const raised = await client.notificationSweep();
  assert.equal(raised, 0);
});

test('notificationSweep raises a vault sync-failing notice from an injected fetchVaultStatus', async () => {
  const { client, store } = makeClient({
    fetchVaultStatus: async () => ({ status: 'offline', error: 'network unreachable' }),
  });
  const raised = await client.notificationSweep();
  assert.equal(raised, 1);
  assert.equal(store.data['notifications.tsv'][0].SOURCE, 'vault');
});

test('notificationSweep skips jira and github sources when deep is false', async () => {
  let jiraCalled = false, githubCalled = false;
  const { client } = makeClient({
    fetchJiraIssues: async () => { jiraCalled = true; return [{ key: 'X-1', status: 'open' }]; },
    githubApi: async () => { githubCalled = true; return []; },
  });
  await client.notificationSweep({ deep: false });
  assert.equal(jiraCalled, false);
  assert.equal(githubCalled, false);
});

test('notificationSweep raises jira status and overdue notices only when deep is true', async () => {
  const { client, store } = makeClient({
    fetchJiraIssues: async () => [{ key: 'X-1', status: 'In Progress', summary: 'thing', duedate: '2020-01-01' }],
  });
  const raised = await client.notificationSweep({ deep: true });
  assert.equal(raised, 2);
  const kinds = store.data['notifications.tsv'].map(r => r.KIND).sort();
  assert.deepEqual(kinds, ['overdue', 'status']);
});

test('notificationSweep pulls github notifications only when deep and a githubApi is configured', async () => {
  const { client, store } = makeClient({
    githubApi: async (path) => {
      assert.match(path, /\/notifications/);
      return [{ id: '1', reason: 'mention', subject: { title: 'PR mentioned you' }, repository: { full_name: 'a/b' }, updated_at: '2026-01-01' }];
    },
  });
  const raised = await client.notificationSweep({ deep: true });
  assert.equal(raised, 1);
  assert.equal(store.data['notifications.tsv'][0].SOURCE, 'github');
});

test('notificationSweep skips wellspring entirely when wellspringRepo is not configured (no hardcoded default)', async () => {
  let calls = 0;
  const { client } = makeClient({
    githubApi: async () => { calls++; return []; },
  });
  await client.notificationSweep({ deep: true });
  // Only the plain /notifications call should fire, not the wellspring commits/PRs calls.
  assert.equal(calls, 1);
});

test('notificationSweep raises wellspring commit/PR notices, marking the operator\'s own commits lower severity', async () => {
  const { client, store } = makeClient({
    wellspringRepo: 'preipocapital/wellspring',
    wellspringSelf: 'architect',
    githubApi: async (path) => {
      if (path.includes('/notifications')) return [];
      if (path.includes('/commits')) return [{ sha: 'abc123def', author: { login: 'architect' }, commit: { message: 'fix build\n', author: { date: '2026-08-01' } } }];
      if (path.includes('/pulls')) return [{ number: 5, state: 'open', title: 'add feature', user: { login: 'taylor' }, head: { ref: 'feat' }, base: { ref: 'main' }, updated_at: '2026-08-02' }];
      return [];
    },
  });
  const raised = await client.notificationSweep({ deep: true });
  assert.equal(raised, 2);
  const commitRow = store.data['notifications.tsv'].find(r => r.KIND === 'commit-own');
  assert.equal(commitRow.SEVERITY, 'info');
  const prRow = store.data['notifications.tsv'].find(r => r.KIND === 'pr-open');
  assert.equal(prRow.SEVERITY, 'high');
});

test('a repeat sweep raises nothing new -- dedupe holds across separate sweep calls', async () => {
  const { client } = makeClient({
    seed: { 'scope/tasks.tsv': [{ ID: 'T1', TITLE: 'x', STATUS: 'open', DUE_DATE: '2020-01-01' }] },
  });
  const first = await client.notificationSweep();
  const second = await client.notificationSweep();
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test('listNotifications returns newest first and respects limit', () => {
  const { client } = makeClient();
  client.notify({ source: 'a', kind: 'k', title: '1', dedupeKey: '1' });
  client.notify({ source: 'a', kind: 'k', title: '2', dedupeKey: '2' });
  client.notify({ source: 'a', kind: 'k', title: '3', dedupeKey: '3' });
  const list = client.listNotifications({ limit: 2 });
  assert.equal(list.length, 2);
  assert.equal(list[0].TITLE, '3');
});

test('markSeen updates matching rows by id and stamps SEEN_AT', () => {
  const { client, store } = makeClient();
  client.notify({ source: 'a', kind: 'k', title: 'one', dedupeKey: '1' });
  const id = store.data['notifications.tsv'][0].ID;
  const { count } = client.markSeen({ ids: [id] });
  assert.equal(count, 1);
  assert.equal(store.data['notifications.tsv'][0].STATUS, 'seen');
  assert.notEqual(store.data['notifications.tsv'][0].SEEN_AT, '-');
});

test('markSeen with all:true marks every row regardless of id', () => {
  const { client, store } = makeClient();
  client.notify({ source: 'a', kind: 'k', title: 'one', dedupeKey: '1' });
  client.notify({ source: 'a', kind: 'k', title: 'two', dedupeKey: '2' });
  const { count } = client.markSeen({ all: true });
  assert.equal(count, 2);
  assert.ok(store.data['notifications.tsv'].every(r => r.STATUS === 'seen'));
});
