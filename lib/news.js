'use strict';
/**
 * News / breaking-updates engine (BI26091022): competitor-move tracking +
 * corporate-engagement mentions, pulled from every viable free-tier news
 * source and pushed through the existing notify()/telegram channels.
 *
 * Two real, local sources of query terms (never invented here):
 *  1. `pulse/memory/news/competitors.tsv` (this repo, new -- venture/org ->
 *     competitor company name). Seeded as a step of this same build from
 *     the prose competitor list at
 *     `vault/memory/learning/viva-model/03-the-nine-competitors.md` --
 *     except that file was NOT present on this machine's local checkout
 *     when this was built (vault/memory sync gap, confirmed missing), so
 *     the seed is a single clearly-marked, STATUS=disabled placeholder row
 *     instead of guessed company names. See that row's own NOTE column.
 *  2. `circle/memory/career/_active.yaml`'s org list, via circle's own
 *     `GET /career?all=1` HTTP route (circle owns that file/YAML read --
 *     see circle/src/server.js's own comment on that route) -- injected as
 *     `fetchCareerOrgs`, never read off disk directly, same cross-engine
 *     discipline notifications.js already uses for Jira/vault-status.
 *
 * A third, freeform CRUD list -- `pulse/memory/news/topics.tsv` -- covers
 * any other location/topic term Sconl wants tracked that isn't a
 * competitor or an org name.
 *
 * Four free-tier sources are queried per term: NewsAPI.org and GNews.io
 * (both need a Bitwarden-provisioned key -- NEWSAPI_KEY/GNEWS_KEY, read
 * through secrets.js's get() exactly like every other engine key) plus
 * NewsData.io (NEWSDATA_KEY, same pattern) and Google News RSS (no key
 * needed at all). A term with no configured key for a given source just
 * contributes nothing from that source -- same fail-soft default pattern
 * as notifications.js's fetchJiraIssues/fetchVaultStatus.
 *
 * `runNewsSweep()` is the single callable entry point a future scheduler
 * (cron/systemd timer on the OCI VM) calls -- deliberately NOT wired up to
 * run automatically by this build (that's a separate, not-yet-resolved
 * deploy-target question per this row's own scope). Same
 * `({ deep }) -> raised count` shape as notifications.js's
 * notificationSweep, for whatever eventually schedules both.
 */

const path = require('path');
const { readTSV, appendTSV, rewriteTSV } = require('./tsv');

const COMPETITORS_FILE = 'news/competitors.tsv';
const TOPICS_FILE = 'news/topics.tsv';
const COMPETITORS_HEADER = 'ID\tVENTURE\tCOMPETITOR\tSTATUS\tNOTE';
const TOPICS_HEADER = 'ID\tKIND\tTERM\tSTATUS\tNOTE';

function clean(s) { return String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }
function slug(s, fallback) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || fallback;
}
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * @param {object} opts
 * @param {(n:object) => Promise<boolean>} opts.notify - pulse/lib/notifications.js's notify({source,kind,title,body,severity,dedupeKey})
 * @param {(text:string, extra?:object) => Promise<any>} [opts.telegramSend] - pulse/lib/telegram.js's send()
 * @param {(name:string) => string|null} [opts.getSecret] - resolves NEWSAPI_KEY/GNEWS_KEY/NEWSDATA_KEY
 * @param {() => Promise<Array<{id?:string,name?:string}>>} [opts.fetchCareerOrgs] - circle's career org list, injected
 * @param {typeof fetch} [opts.fetchFn] - injectable for testing
 * @param {{log:Function}} [opts.auditLog]
 * @param {string} [opts.memoryDir] - defaults to this repo's own memory/ dir; overridable for tests
 */
function createNewsClient(opts = {}) {
  const {
    memoryDir = path.join(__dirname, '..', 'memory'),
    notify,
    telegramSend = async () => null,
    getSecret = () => null,
    fetchCareerOrgs = async () => [],
    fetchFn = fetch,
    auditLog = { log: () => {} },
  } = opts;
  if (!notify) throw new Error('createNewsClient requires notify (pulse/lib/notifications.js\'s notify())');

  // -- competitors.tsv CRUD ----------------------------------------------------
  function listCompetitors() { return readTSV(memoryDir, COMPETITORS_FILE); }

  function upsertCompetitor(p = {}) {
    const rows = readTSV(memoryDir, COMPETITORS_FILE);
    const id = p.id || `comp-${slug(p.competitor, Date.now())}`;
    const existing = rows.find(r => r.ID === id);
    if (!existing && !clean(p.competitor)) throw new Error('competitor name required');
    const row = {
      ID: id,
      VENTURE: p.venture !== undefined ? (clean(p.venture) || '-') : (existing?.VENTURE || '-'),
      COMPETITOR: p.competitor !== undefined ? clean(p.competitor) : existing?.COMPETITOR,
      STATUS: p.status || existing?.STATUS || 'active',
      NOTE: p.note !== undefined ? (clean(p.note) || '-') : (existing?.NOTE || '-'),
    };
    if (existing) rewriteTSV(memoryDir, COMPETITORS_FILE, rows2 => rows2.map(r => (r.ID === id ? row : r)), { auditLog });
    else appendTSV(memoryDir, COMPETITORS_FILE, row, { headerIfMissing: COMPETITORS_HEADER, auditLog });
    auditLog.log('news_competitor_upserted', { id, created: !existing });
    return { success: true, id, created: !existing, row };
  }

  function deleteCompetitor(id) {
    if (!id) throw new Error('which competitor');
    rewriteTSV(memoryDir, COMPETITORS_FILE, rows => rows.filter(r => r.ID !== id), { auditLog, force: true });
    auditLog.log('news_competitor_deleted', { id });
    return { success: true, id };
  }

  // -- topics.tsv (freeform location/topic list) CRUD -------------------------
  function listTopics() { return readTSV(memoryDir, TOPICS_FILE); }

  function upsertTopic(p = {}) {
    const rows = readTSV(memoryDir, TOPICS_FILE);
    const id = p.id || `topic-${slug(p.term, Date.now())}`;
    const existing = rows.find(r => r.ID === id);
    if (!existing && !clean(p.term)) throw new Error('term required');
    const row = {
      ID: id,
      KIND: (p.kind !== undefined ? clean(p.kind) : existing?.KIND) || 'topic',
      TERM: p.term !== undefined ? clean(p.term) : existing?.TERM,
      STATUS: p.status || existing?.STATUS || 'active',
      NOTE: p.note !== undefined ? (clean(p.note) || '-') : (existing?.NOTE || '-'),
    };
    if (existing) rewriteTSV(memoryDir, TOPICS_FILE, rows2 => rows2.map(r => (r.ID === id ? row : r)), { auditLog });
    else appendTSV(memoryDir, TOPICS_FILE, row, { headerIfMissing: TOPICS_HEADER, auditLog });
    auditLog.log('news_topic_upserted', { id, created: !existing });
    return { success: true, id, created: !existing, row };
  }

  function deleteTopic(id) {
    if (!id) throw new Error('which topic');
    rewriteTSV(memoryDir, TOPICS_FILE, rows => rows.filter(r => r.ID !== id), { auditLog, force: true });
    auditLog.log('news_topic_deleted', { id });
    return { success: true, id };
  }

  // -- query terms, merged from all sources, active only, deduped -------------
  async function listQueryTerms() {
    const terms = [];
    for (const c of listCompetitors()) {
      if ((c.STATUS || 'active') !== 'active' || !c.COMPETITOR) continue;
      terms.push({ term: c.COMPETITOR, kind: 'competitor', ref: c.ID, venture: c.VENTURE });
    }
    for (const t of listTopics()) {
      if ((t.STATUS || 'active') !== 'active' || !t.TERM) continue;
      terms.push({ term: t.TERM, kind: t.KIND || 'topic', ref: t.ID });
    }
    try {
      for (const org of (await fetchCareerOrgs()) || []) {
        const name = clean(org.name || org.NAME || (typeof org === 'string' ? org : ''));
        if (name) terms.push({ term: name, kind: 'corporate-engagement', ref: org.id || org.ID || name });
      }
    } catch (e) {
      auditLog.log('news_career_orgs_failed', { error: String(e.message || e).slice(0, 120) });
    }
    const seen = new Set();
    return terms.filter((t) => {
      if (!t.term) return false;
      const key = t.term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // -- sources ------------------------------------------------------------------
  async function fetchJson(url) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetchFn(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  /** NewsAPI.org -- free tier, needs NEWSAPI_KEY. */
  async function queryNewsApi(term) {
    const key = getSecret('NEWSAPI_KEY');
    if (!key) return [];
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(term)}&sortBy=publishedAt&pageSize=10&apiKey=${encodeURIComponent(key)}`;
    const data = await fetchJson(url);
    return (data?.articles || []).map(a => ({
      title: a.title, url: a.url, source: a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt || '', description: a.description || '',
    }));
  }

  /** GNews.io -- free tier, needs GNEWS_KEY. */
  async function queryGNews(term) {
    const key = getSecret('GNEWS_KEY');
    if (!key) return [];
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(term)}&max=10&apikey=${encodeURIComponent(key)}`;
    const data = await fetchJson(url);
    return (data?.articles || []).map(a => ({
      title: a.title, url: a.url, source: a.source?.name || 'GNews',
      publishedAt: a.publishedAt || '', description: a.description || '',
    }));
  }

  /** NewsData.io -- free tier, needs NEWSDATA_KEY. */
  async function queryNewsData(term) {
    const key = getSecret('NEWSDATA_KEY');
    if (!key) return [];
    const url = `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(key)}&q=${encodeURIComponent(term)}&language=en`;
    const data = await fetchJson(url);
    return (data?.results || []).map(a => ({
      title: a.title, url: a.link, source: a.source_id || 'NewsData',
      publishedAt: a.pubDate || '', description: a.description || '',
    }));
  }

  /** Google News RSS -- no key needed. XML, so parsed with a small regex pass rather than pulling in a parser dependency for one feed. */
  async function queryGoogleNewsRss(term) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=en-US&gl=US&ceid=US:en`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetchFn(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return [];
      const xml = await r.text();
      const items = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) && items.length < 10) {
        const block = m[1];
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || 'Google News';
        const t = decodeXml(title), u = decodeXml(link);
        if (t && u) items.push({ title: t, url: u, source: decodeXml(source), publishedAt: pubDate, description: '' });
      }
      return items;
    } catch { return []; }
  }

  /** Every source for one query term, merged and de-duplicated by URL. */
  async function queryAllSources(term) {
    const results = await Promise.all([
      queryNewsApi(term).catch(() => []),
      queryGNews(term).catch(() => []),
      queryNewsData(term).catch(() => []),
      queryGoogleNewsRss(term).catch(() => []),
    ]);
    const seen = new Set();
    const merged = [];
    for (const list of results) {
      for (const a of (list || [])) {
        if (!a || !a.url || !a.title || seen.has(a.url)) continue;
        seen.add(a.url);
        merged.push(a);
      }
    }
    return merged;
  }

  /**
   * The single callable sweep a future scheduler calls. Queries every
   * active term against every source, and for each genuinely new match
   * (notify()'s own dedupe, keyed by term+article URL, decides "new") both
   * raises an in-app Alert via notify() and pushes a Telegram message via
   * telegramSend() -- same "one fact, two channels" shape the row asked
   * for. `deep` is accepted for signature symmetry with
   * notifications.js's notificationSweep({deep}); every call here is
   * already network-bound so it has no cheap/local branch to gate.
   */
  async function runNewsSweep({ deep = true } = {}) {
    let raised = 0;
    const terms = await listQueryTerms();
    for (const t of terms) {
      let articles = [];
      try {
        articles = await queryAllSources(t.term);
      } catch (e) {
        auditLog.log('news_query_failed', { term: t.term, error: String(e.message || e).slice(0, 120) });
        continue;
      }
      for (const a of articles) {
        const dedupeKey = `news:${t.kind}:${t.ref}:${a.url}`.slice(0, 160);
        const label = t.kind === 'competitor' ? 'Competitor move'
          : t.kind === 'corporate-engagement' ? 'Mention' : 'News';
        const title = `${label}: ${a.title}`.slice(0, 160);
        const body = [t.term, a.source, String(a.publishedAt || '').slice(0, 10), a.description]
          .filter(Boolean).join(' - ').slice(0, 400);
        let isNew = false;
        try {
          isNew = await notify({
            source: 'news', kind: 'breaking', title, body,
            severity: t.kind === 'competitor' ? 'high' : 'medium',
            view: 'news', ref: a.url, dedupeKey,
          });
        } catch (e) {
          auditLog.log('news_notify_failed', { term: t.term, error: String(e.message || e).slice(0, 120) });
          continue;
        }
        if (isNew) {
          raised++;
          try { await telegramSend(`*${title}*\n${a.url}`); }
          catch (e) { auditLog.log('news_telegram_failed', { error: String(e.message || e).slice(0, 120) }); }
        }
      }
    }
    if (raised) auditLog.log('news_sweep', { raised, terms: terms.length, deep });
    return raised;
  }

  return {
    listCompetitors, upsertCompetitor, deleteCompetitor,
    listTopics, upsertTopic, deleteTopic,
    listQueryTerms, queryAllSources, runNewsSweep,
  };
}

module.exports = { createNewsClient };
