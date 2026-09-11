'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNewsClient } = require('../lib/news');

function tmpMemoryDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-news-test-')); }

function makeClient(overrides = {}) {
  const memoryDir = overrides.memoryDir || tmpMemoryDir();
  const notified = [];
  const telegrams = [];
  const logs = [];
  const client = createNewsClient({
    memoryDir,
    notify: overrides.notify || (async (n) => { notified.push(n); return true; }),
    telegramSend: overrides.telegramSend || (async (text) => { telegrams.push(text); }),
    getSecret: overrides.getSecret || (() => null),
    fetchCareerOrgs: overrides.fetchCareerOrgs || (async () => []),
    fetchFn: overrides.fetchFn || (async () => ({ ok: true, json: async () => ({}), text: async () => '' })),
    auditLog: { log: (event, data) => logs.push({ event, data }) },
  });
  return { client, memoryDir, notified, telegrams, logs };
}

test('createNewsClient throws without notify', () => {
  assert.throws(() => createNewsClient({ memoryDir: tmpMemoryDir() }));
});

test('upsertCompetitor creates then updates a row in memory/news/competitors.tsv', () => {
  const { client, memoryDir } = makeClient();
  const created = client.upsertCompetitor({ venture: 'Viva Valentia', competitor: 'Acme Rival' });
  assert.equal(created.created, true);
  assert.equal(client.listCompetitors().length, 1);
  assert.ok(fs.existsSync(path.join(memoryDir, 'news', 'competitors.tsv')));

  const updated = client.upsertCompetitor({ id: created.id, note: 'watching closely' });
  assert.equal(updated.created, false);
  assert.equal(client.listCompetitors()[0].NOTE, 'watching closely');
  assert.equal(client.listCompetitors()[0].COMPETITOR, 'Acme Rival'); // untouched field survives a partial edit
});

test('upsertCompetitor requires a competitor name for a brand-new row', () => {
  const { client } = makeClient();
  assert.throws(() => client.upsertCompetitor({ venture: 'x' }));
});

test('deleteCompetitor removes the row', () => {
  const { client } = makeClient();
  const { id } = client.upsertCompetitor({ competitor: 'Acme Rival' });
  client.deleteCompetitor(id);
  assert.equal(client.listCompetitors().length, 0);
});

test('topics CRUD mirrors competitors CRUD', () => {
  const { client } = makeClient();
  const { id } = client.upsertTopic({ kind: 'location', term: 'Nairobi' });
  assert.equal(client.listTopics().length, 1);
  client.upsertTopic({ id, note: 'HQ region' });
  assert.equal(client.listTopics()[0].NOTE, 'HQ region');
  client.deleteTopic(id);
  assert.equal(client.listTopics().length, 0);
});

test('listQueryTerms merges active competitors + active topics + career orgs, dedupes, skips disabled/placeholder rows', async () => {
  const { client } = makeClient({
    fetchCareerOrgs: async () => [{ id: 'viva-valentia-dmcc', name: 'Viva Valentia Dmcc' }],
  });
  client.upsertCompetitor({ competitor: 'Acme Rival' });
  client.upsertCompetitor({ competitor: 'Disabled Co', status: 'disabled' });
  client.upsertTopic({ kind: 'topic', term: 'Acme Rival' }); // dupe of the competitor term, different kind
  client.upsertTopic({ kind: 'location', term: 'Nairobi' });

  const terms = await client.listQueryTerms();
  const words = terms.map(t => t.term);
  assert.ok(words.includes('Acme Rival'));
  assert.ok(words.includes('Nairobi'));
  assert.ok(words.includes('Viva Valentia Dmcc'));
  assert.ok(!words.includes('Disabled Co'));
  assert.equal(words.filter(w => w === 'Acme Rival').length, 1); // deduped across competitor+topic
});

test('queryAllSources merges and de-duplicates by URL across every source', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('newsapi.org')) {
      return { ok: true, json: async () => ({ articles: [{ title: 'A', url: 'https://x/1', source: { name: 'NewsAPI' }, publishedAt: '2026-09-10' }] }) };
    }
    if (String(url).includes('gnews.io')) {
      return { ok: true, json: async () => ({ articles: [{ title: 'A dupe', url: 'https://x/1', source: { name: 'GNews' } }] }) };
    }
    if (String(url).includes('newsdata.io')) {
      return { ok: true, json: async () => ({ results: [{ title: 'B', link: 'https://x/2', source_id: 'ND', pubDate: '2026-09-10' }] }) };
    }
    if (String(url).includes('news.google.com')) {
      return { ok: true, text: async () => '<rss><channel><item><title>C</title><link>https://x/3</link><pubDate>d</pubDate></item></channel></rss>' };
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  const { client } = makeClient({
    fetchFn,
    getSecret: (name) => ({ NEWSAPI_KEY: 'k1', GNEWS_KEY: 'k2', NEWSDATA_KEY: 'k3' }[name] || null),
  });
  const merged = await client.queryAllSources('Acme Rival');
  const urls = merged.map(a => a.url).sort();
  assert.deepEqual(urls, ['https://x/1', 'https://x/2', 'https://x/3']); // the gnews dupe of x/1 collapsed
});

test('runNewsSweep raises a notification + a Telegram push for each new match, and is silent when nothing is configured', async () => {
  const { client, notified, telegrams } = makeClient(); // no keys configured, no terms -> nothing to do
  const raised = await client.runNewsSweep();
  assert.equal(raised, 0);
  assert.equal(notified.length, 0);
  assert.equal(telegrams.length, 0);
});

test('runNewsSweep notifies + telegrams once per genuinely new article, and skips the Telegram push when notify() says it was already known', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('newsapi.org')) {
      return { ok: true, json: async () => ({ articles: [{ title: 'Acme launches X', url: 'https://x/1', source: { name: 'NewsAPI' }, publishedAt: '2026-09-10' }] }) };
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  let notifyReturn = true;
  const { client, notified, telegrams } = makeClient({
    fetchFn,
    getSecret: (name) => (name === 'NEWSAPI_KEY' ? 'k1' : null),
    notify: async (n) => { notified.push(n); return notifyReturn; },
  });
  client.upsertCompetitor({ competitor: 'Acme Rival' });

  const raised1 = await client.runNewsSweep();
  assert.equal(raised1, 1);
  assert.equal(telegrams.length, 1);
  assert.match(telegrams[0], /Acme launches X/);

  notifyReturn = false; // simulate notify()'s own dedupe now recognizing this article
  const telegramsBefore = telegrams.length;
  const raised2 = await client.runNewsSweep();
  assert.equal(raised2, 0);
  assert.equal(telegrams.length, telegramsBefore); // no repeat Telegram push for an already-known match
});
