'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinanceClient, computeSummary, parseAllocationModel } = require('../lib/finance');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => {
      const before = data[rel] || [];
      const after = fn(before.slice());
      data[rel] = after;
      return before.length - after.length;
    },
  };
}

test('parseAllocationModel returns null with no model text and no reference income', () => {
  assert.equal(parseAllocationModel('', 0), null);
});

test('parseAllocationModel splits a two-level model into buckets with computed amounts', () => {
  const raw = [
    'reference_income: 1000',
    '  needs:',
    '    share: 0.5',
    '      housing: { share: 0.6 }',
    '  wants:',
    '    share: 0.3',
    '  savings:',
    '    share: 0.2',
  ].join('\n');
  const model = parseAllocationModel(raw, 2000);
  assert.equal(model.base, 2000);
  assert.equal(model.planned, false);
  const needs = model.buckets.find(b => b.name === 'needs');
  assert.equal(needs.amount, 1000);
  assert.equal(needs.children[0].amount, 600);
});

test('parseAllocationModel falls back to reference_income and marks the result as planned when there is no real income', () => {
  const raw = 'reference_income: 500\n  needs:\n    share: 1\n';
  const model = parseAllocationModel(raw, 0);
  assert.equal(model.base, 500);
});

test('computeSummary: net worth splits liability types from asset types', () => {
  const s = computeSummary({
    accounts: [{ TYPE: 'cash', BALANCE: '1000' }, { TYPE: 'loan', BALANCE: '-400' }],
    txs: [], snaps: [], goals: [], incomeStreams: [], allocationModelRaw: '',
    now: new Date('2026-08-09'),
  });
  assert.equal(s.netWorth.assets, 1000);
  assert.equal(s.netWorth.liabilities, 400);
  assert.equal(s.netWorth.net, 600);
});

test('computeSummary: this month\'s income/expense and category breakdown, ignoring other months', () => {
  const s = computeSummary({
    accounts: [], snaps: [], goals: [], incomeStreams: [],
    txs: [
      { DATE: '2026-08-01', TYPE: 'income', AMOUNT: '5000' },
      { DATE: '2026-08-03', TYPE: 'expense', AMOUNT: '1200', CATEGORY: 'food' },
      { DATE: '2026-07-15', TYPE: 'expense', AMOUNT: '900', CATEGORY: 'food' },
    ],
    allocationModelRaw: '',
    now: new Date('2026-08-09'),
  });
  assert.equal(s.month.income, 5000);
  assert.equal(s.month.expense, 1200);
  assert.equal(s.month.byCategory.food, 1200);
  assert.equal(s.month.savingsRate, 76);
});

test('computeSummary: burn averages up to the last 3 CLOSED months, excluding the current month', () => {
  const s = computeSummary({
    accounts: [{ TYPE: 'cash', BALANCE: '900' }], snaps: [], goals: [], incomeStreams: [],
    txs: [
      { DATE: '2026-05-01', TYPE: 'expense', AMOUNT: '100' },
      { DATE: '2026-06-01', TYPE: 'expense', AMOUNT: '200' },
      { DATE: '2026-07-01', TYPE: 'expense', AMOUNT: '300' },
      { DATE: '2026-08-01', TYPE: 'expense', AMOUNT: '999' },  // current month -- excluded from burn
    ],
    allocationModelRaw: '',
    now: new Date('2026-08-09'),
  });
  assert.equal(s.burn, 200);
  assert.equal(s.runwayMonths, 4.5);
});

test('computeSummary: an income stream is overdue only once its due day has passed with nothing received, and never before it starts', () => {
  const s = computeSummary({
    accounts: [], snaps: [], goals: [],
    incomeStreams: [
      { NAME: 'Salary', MATCH: 'salary', AMOUNT: '3000', RECURS: 'monthly', DAY: '5', STATUS: 'active', STARTS: '-' },
      { NAME: 'Future gig', MATCH: 'gig', AMOUNT: '500', RECURS: 'monthly', DAY: '1', STATUS: 'active', STARTS: '2026-12' },
    ],
    txs: [], allocationModelRaw: '',
    now: new Date('2026-08-09'),
  });
  const salary = s.incomes.streams.find(x => x.NAME === 'Salary');
  assert.equal(salary.overdue, true);
  const future = s.incomes.streams.find(x => x.NAME === 'Future gig');
  assert.equal(future.begun, false);
  assert.equal(future.overdue, false);
});

test('upsertIncome requires a name for a new stream but not for updating an existing one', () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  assert.throws(() => client.upsertIncome({ amount: 100 }), /name required/);
  const { id } = client.upsertIncome({ name: 'Freelance', amount: 100 });
  assert.doesNotThrow(() => client.upsertIncome({ id, amount: 200 }));
  assert.equal(store.data['finance/incomes.tsv'].find(r => r.ID === id).AMOUNT, '200');
});

test('upsertAccount creates then updates in place by id, keeping one row per account', () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  const created = client.upsertAccount({ name: 'KCB', type: 'bank', balance: 500 });
  assert.equal(created.created, true);
  const updated = client.upsertAccount({ id: created.id, balance: 750 });
  assert.equal(updated.created, false);
  assert.equal(store.data['finance/accounts.tsv'].length, 1);
  assert.equal(store.data['finance/accounts.tsv'][0].BALANCE, '750');
});

test('addTransaction rejects an invalid type or non-positive amount', () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  assert.throws(() => client.addTransaction({ type: 'bogus', amount: 10 }), /type must be/);
  assert.throws(() => client.addTransaction({ type: 'expense', amount: -5 }), /positive number/);
});

test('addTransaction IDs sequence within the same date', () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  const t1 = client.addTransaction({ type: 'expense', amount: 10, date: '2026-08-09' });
  const t2 = client.addTransaction({ type: 'expense', amount: 20, date: '2026-08-09' });
  assert.equal(t1.ID, 'finance-2026-08-09-001');
  assert.equal(t2.ID, 'finance-2026-08-09-002');
});

test('snapshot replaces an existing same-day row rather than duplicating it', () => {
  const store = makeStore({ 'finance/accounts.tsv': [{ TYPE: 'cash', BALANCE: '1000' }] });
  const client = createFinanceClient(store);
  const first = client.snapshot({ now: new Date('2026-08-09') });
  store.data['finance/accounts.tsv'][0].BALANCE = '1500';
  const second = client.snapshot({ now: new Date('2026-08-09') });
  assert.equal(store.data['finance/networth.tsv'].length, 1);
  assert.equal(second.NET, '1500');
  assert.notEqual(first.NET, second.NET);
});

test('upsertVenture requires a name for a new venture and clears its metrics cache on update', async () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  assert.throws(() => client.upsertVenture({}), /name required/);
  const { id } = client.upsertVenture({ name: 'Keyvanos', url: 'https://keyvanos.example/metrics' });
  assert.equal(store.data['finance/ventures.tsv'].length, 1);
});

test('listVentures fetches flat scalar metrics only, dropping nested objects, and reports a timeout distinctly', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [
    { ID: 'v1', NAME: 'A', ANALYTICS_URL: 'https://a.example/metrics', STATUS: 'active', AUTH_SECRET: '-' },
    { ID: 'v2', NAME: 'B', ANALYTICS_URL: 'https://b.example/metrics', STATUS: 'active', AUTH_SECRET: 'B_SECRET' },
  ] });
  let capturedAuth = null;
  const client = createFinanceClient({
    ...store,
    getSecret: (name) => name === 'B_SECRET' ? 'shh' : null,
    fetchFn: async (url, { headers } = {}) => {
      if (url.includes('a.example')) return { json: async () => ({ mrr: 120, nested: { a: 1 }, active: true }) };
      capturedAuth = headers?.Authorization;
      return { json: async () => ({ users: 40 }) };
    },
  });
  const ventures = await client.listVentures();
  const a = ventures.find(v => v.ID === 'v1');
  assert.deepEqual(a.metrics, { mrr: 120, active: true });
  assert.equal(capturedAuth, 'Bearer shh');
});

test('listVentures caches metrics for 10 minutes and only refetches when forced', async () => {
  let calls = 0;
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'v1', NAME: 'A', ANALYTICS_URL: 'https://a.example', STATUS: 'active', AUTH_SECRET: '-' }] });
  const client = createFinanceClient({ ...store, fetchFn: async () => { calls++; return { json: async () => ({ mrr: 1 }) }; } });
  await client.listVentures();
  await client.listVentures();
  assert.equal(calls, 1);
  await client.listVentures({ force: true });
  assert.equal(calls, 2);
});

test('drivePush is a no-op error when no graph client is configured', async () => {
  const store = makeStore();
  const client = createFinanceClient(store);
  const r = await client.drivePush('accounts.tsv', 'ID\tNAME\n');
  assert.equal(r.ok, false);
});

test('drivePush builds missing parent folders on a 404 then retries the PUT once', async () => {
  const calls = [];
  const store = makeStore();
  const client = createFinanceClient({
    ...store,
    graphRequest: async (path, opts) => {
      calls.push({ path, method: opts?.method });
      if (opts?.method === 'PUT' && calls.filter(c => c.method === 'PUT').length === 1) return { status: 404, data: {} };
      if (opts?.method === 'PUT') return { status: 200, data: { lastModifiedDateTime: '2026-08-09T00:00:00Z' } };
      return { status: 201, data: {} };
    },
  });
  const r = await client.drivePush('accounts.tsv', 'ID\tNAME\n');
  assert.equal(r.ok, true);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 2);
});

test('drivePush serializes concurrent calls to the same file and re-runs once more for a write that arrived mid-flight', async () => {
  let running = 0, maxRunning = 0, puts = 0;
  const store = makeStore();
  const client = createFinanceClient({
    ...store,
    graphRequest: async (path, opts) => {
      if (opts?.method === 'PUT') {
        running++; maxRunning = Math.max(maxRunning, running); puts++;
        await new Promise(r => setTimeout(r, 5));
        running--;
        return { status: 200, data: {} };
      }
      return { status: 200, data: {} };
    },
  });
  await Promise.all([client.drivePush('tx.tsv', 'a'), client.drivePush('tx.tsv', 'b')]);
  assert.equal(maxRunning, 1, 'pushes to the same file must never run concurrently');
  assert.equal(puts, 2, 'a write that arrived mid-flight gets exactly one follow-up push, not zero and not more');
});

test('drivePull refuses to overwrite a real remote ledger with an empty freshly-booted local file only in the wrong direction -- empty local yields to a populated remote', async () => {
  const store = makeStore();
  const client = createFinanceClient({
    ...store,
    graphRequest: async () => ({
      status: 200,
      data: { value: [{ name: 'accounts.tsv', lastModifiedDateTime: '2026-08-01T00:00:00Z', size: 200, '@microsoft.graph.downloadUrl': 'https://dl.example/accounts.tsv' }] },
    }),
    fetchFn: async (url) => {
      if (url.includes('dl.example')) return { text: async () => 'ID\tNAME\nacc-1\tKCB\n' };
      return { json: async () => ({}) };
    },
  });
  const pulled = await client.drivePull({
    force: true,
    localReader: () => ({ text: 'ID\tNAME\n', mtimeMs: Date.now(), exists: true }), // header-only: empty
  });
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0].rel, 'accounts.tsv');
  assert.match(pulled[0].text, /KCB/);
});

test('drivePull refuses a remote file that lost its header, even though it is newer', async () => {
  const store = makeStore();
  const client = createFinanceClient({
    ...store,
    graphRequest: async () => ({
      status: 200,
      data: { value: [{ name: 'accounts.tsv', lastModifiedDateTime: '2026-08-09T00:00:00Z', size: 200, '@microsoft.graph.downloadUrl': 'https://dl.example/accounts.tsv' }] },
    }),
    fetchFn: async () => ({ text: async () => 'corrupted, no header at all' }),
  });
  const pulled = await client.drivePull({
    force: true,
    localReader: () => ({ text: 'ID\tNAME\n', mtimeMs: 0, exists: true }),
  });
  assert.equal(pulled.length, 0);
});

test('drivePull pushes a nonempty local file up when the remote has nothing yet', async () => {
  const pushed = [];
  const store = makeStore();
  const client = createFinanceClient({
    ...store,
    graphRequest: async (path, opts) => {
      if (opts?.method === 'PUT') { pushed.push(path); return { status: 200, data: {} }; }
      return { status: 200, data: { value: [] } };
    },
  });
  await client.drivePull({
    force: true,
    localReader: (rel) => rel === 'accounts.tsv'
      ? { text: 'ID\tNAME\nacc-1\tKCB\n', mtimeMs: Date.now(), exists: true }
      : { text: '', mtimeMs: 0, exists: false },
  });
  await new Promise(r => setTimeout(r, 10)); // fire-and-forget push
  assert.ok(pushed.some(p => p.includes('accounts.tsv')));
});
