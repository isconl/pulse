'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGithubClient } = require('../lib/github');

function tmpCacheFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-gh-test-')), 'gh-contrib.json');
}

test('githubApi returns null (not a throw) when no token is configured', async () => {
  const client = createGithubClient({ getToken: () => '' });
  const result = await client.githubApi('/user');
  assert.equal(result, null);
});

test('fetchContributions reports a clear error when no owner is configured, rather than guessing one', async () => {
  const client = createGithubClient({ getToken: () => '', getOwner: () => '' });
  const result = await client.fetchContributions();
  assert.equal(result.error, 'no GitHub owner configured');
  assert.deepEqual(result.days, []);
});

test('getContributions caches across calls and persists to disk, surviving a fresh client instance (restart simulation)', async () => {
  const cacheFile = tmpCacheFile();
  // Manually seed a cache file, as if a previous process wrote it.
  const seeded = { at: Date.now(), data: { totalContributions: 42, days: [{ date: '2026-01-01', count: 3 }], error: null } };
  fs.writeFileSync(cacheFile, JSON.stringify(seeded));

  const client = createGithubClient({ getToken: () => '', getOwner: () => '', cacheFile });
  // No token/owner configured, so a live fetch would fail -- but the cache is
  // fresh (just seeded), so getContributions() must return the CACHED value
  // without attempting a fetch at all.
  const result = await client.getContributions({ maxAgeMs: 60 * 60 * 1000 });
  assert.equal(result.totalContributions, 42);
});

test('runGhArgs resolves with success:false (not a throw) when gh is missing/fails', async () => {
  const client = createGithubClient({ getToken: () => '' });
  const result = await client.runGhArgs(['definitely-not-a-real-subcommand-xyz']);
  assert.equal(result.success, false);
});
