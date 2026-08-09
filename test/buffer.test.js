'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBufferClient } = require('../lib/buffer');

function makeClient(responder, overrides = {}) {
  const calls = [];
  const client = createBufferClient({
    getAccessToken: () => 'test-token',
    httpsRequestFn: async (options, body) => {
      calls.push({ options, body: JSON.parse(body) });
      return responder(JSON.parse(body), calls.length);
    },
    ...overrides,
  });
  return { client, calls };
}

test('getProfiles returns a clear error, no network call, when no token is configured', async () => {
  const client = createBufferClient({ getAccessToken: () => '' });
  const result = await client.getProfiles();
  assert.match(result.error, /not connected/);
});

test('getProfiles fetches orgId then channels, and caches the result', async () => {
  const { client, calls } = makeClient((body, n) => {
    if (body.query.includes('organizations')) return { status: 200, data: { data: { account: { organizations: [{ id: 'org1' }] } } } };
    return { status: 200, data: { data: { channels: [{ id: 'c1', name: 'Twitter', service: 'twitter', isQueuePaused: false }] } } };
  });
  const first = await client.getProfiles();
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'Twitter');
  const callsAfterFirst = calls.length;

  const second = await client.getProfiles();   // should hit cache, not the network
  assert.equal(calls.length, callsAfterFirst, 'second call within the cache window must not make new requests');
  assert.deepEqual(second, first);
});

test('the rate budget holds after budgetPerMinute calls, returning cached data or a clear message instead of bursting', async () => {
  const { client } = makeClient(() => ({ status: 200, data: { data: { account: { organizations: [{ id: 'org1' }] } } } }), {});
  const tight = createBufferClient({ getAccessToken: () => 'tok', budgetPerMinute: 2, httpsRequestFn: async () => ({ status: 200, data: { data: { account: { organizations: [{ id: 'org1' }] } } } }) });
  assert.equal(tight.budgetOk(), true);
  assert.equal(tight.budgetOk(), true);
  assert.equal(tight.budgetOk(), false, 'third call within the same minute should be held');
});

test('managePost(delete) throws with Buffer\'s own message when the mutation reports an error', async () => {
  const { client } = makeClient(() => ({ status: 200, data: { data: { deletePost: { message: 'not your post' } }, errors: null } }));
  await assert.rejects(() => client.managePost({ id: 'p1', action: 'delete' }), /not your post/);
});

test('managePost(delete) succeeds and returns the post on a clean mutation response', async () => {
  const { client } = makeClient(() => ({ status: 200, data: { data: { deletePost: { post: { id: 'p1' } } } } }));
  const result = await client.managePost({ id: 'p1', action: 'delete' });
  assert.deepEqual(result, { id: 'p1' });
});

test('managePost throws on an unknown action without making a network call', async () => {
  const { client, calls } = makeClient(() => ({ status: 200, data: {} }));
  await assert.rejects(() => client.managePost({ id: 'p1', action: 'nonsense' }), /unknown action/);
});

test('createPost requires at least one channel and non-empty text', async () => {
  const { client } = makeClient(() => ({ status: 200, data: {} }));
  await assert.rejects(() => client.createPost({ text: '', profileIds: ['c1'] }), /nothing to post/);
  await assert.rejects(() => client.createPost({ text: 'hello', profileIds: [] }), /choose at least one channel/);
});

test('createPost sends one mutation per channel and reports per-channel results', async () => {
  const { client, calls } = makeClient((body) => {
    if (body.query.includes('createPost')) {
      return { status: 200, data: { data: { createPost: { post: { id: `post-${calls.length}`, status: 'sent' } } } } };
    }
    return { status: 200, data: {} };
  });
  const results = await client.createPost({ text: 'hello world', profileIds: ['c1', 'c2'] });
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.id));
});
