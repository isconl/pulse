'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectsClient } = require('../lib/projects');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return (data[rel] || []).length; },
  };
}

test('createProjectsClient throws without readTSV/rewriteTSV', () => {
  assert.throws(() => createProjectsClient({}));
});

test('listProjects returns live:null for ventures with no RENDER_URL', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'V1', NAME: 'X', RENDER_URL: '-' }] });
  const client = createProjectsClient({ ...store });
  const result = await client.listProjects();
  assert.equal(result[0].live, null);
});

test('listProjects pings a configured URL and reports up on a 2xx/3xx/4xx response', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'V1', NAME: 'X', RENDER_URL: 'https://example.onrender.com' }] });
  const client = createProjectsClient({ ...store, fetchFn: async () => ({ status: 200 }) });
  const result = await client.listProjects();
  assert.equal(result[0].live.up, true);
  assert.equal(result[0].live.status, 200);
});

test('listProjects reports down when the ping throws (timeout/network error)', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'V1', NAME: 'X', RENDER_URL: 'https://example.onrender.com' }] });
  const client = createProjectsClient({ ...store, fetchFn: async () => { throw new Error('timeout'); } });
  const result = await client.listProjects();
  assert.equal(result[0].live.up, false);
  assert.equal(result[0].live.status, 0);
});

test('setProjectUrl rejects a non-https URL', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'V1', NAME: 'X', RENDER_URL: '-' }] });
  const client = createProjectsClient({ ...store });
  await assert.rejects(() => client.setProjectUrl({ id: 'V1', url: 'http://insecure.com' }));
});

test('setProjectUrl updates the matching venture row', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [{ ID: 'V1', NAME: 'X', RENDER_URL: '-' }] });
  const client = createProjectsClient({ ...store });
  const r = await client.setProjectUrl({ id: 'V1', url: 'https://example.onrender.com' });
  assert.equal(r.success, true);
  assert.equal(store.data['finance/ventures.tsv'][0].RENDER_URL, 'https://example.onrender.com');
});

test('setProjectUrl throws for an unknown venture id', async () => {
  const store = makeStore({ 'finance/ventures.tsv': [] });
  const client = createProjectsClient({ ...store });
  await assert.rejects(() => client.setProjectUrl({ id: 'nope', url: '' }));
});
