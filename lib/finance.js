'use strict';
/**
 * Personal finance ledger. Ported from isconl-agent's server.js (~7691-8206,
 * plus the allocation model at ~8016-8039).
 *
 * Deterministic throughout: every number here is arithmetic over the vault's
 * TSV ledgers, never a model's opinion -- money is the one domain where
 * "roughly right" is indistinguishable from wrong.
 *
 * OUT OF SCOPE for this module (deliberate, same reasoning as github.js
 * excluding APK-distribution and telegram.js excluding command dispatch):
 *  - Receipt/statement AI extraction (`/api/finance/receipt`) -- it calls
 *    Gemini/processAiChat, which is a `spark` capability finance would only
 *    be borrowing; the extracted fields still land through addTransaction()
 *    here, but the OCR/LLM step belongs to spark, wired up by hub.
 *  - The printable HTML/PDF finance report -- presentational, not a finance
 *    capability; a hub/UI concern to add later.
 */

const LIABILITY_TYPES = new Set(['debt', 'loan', 'payable', 'credit']);
const FINANCE_FILES = ['accounts.tsv', 'transactions.tsv', 'networth.tsv', 'goals.tsv', 'incomes.tsv', 'ventures.tsv'];

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
function clean(s) { return String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }
function slug(s, fallback) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || fallback;
}

/** The recursive 50-30-20 style model: parsed from a small two-level YAML-ish file, not a real YAML dependency, because the shape is fixed. */
function parseAllocationModel(raw, monthIncome) {
  if (!raw) return null;
  const ref = parseFloat((raw.match(/^reference_income:\s*([\d.]+)/m) || [])[1]) || 0;
  const base = monthIncome > 0 ? monthIncome : ref;
  if (!base) return null;
  const buckets = [];
  const sections = raw.split(/^\s{2}(?=[a-z-]+:)/m).slice(1);
  for (const sec of sections) {
    const name = (sec.match(/^([a-z-]+):/) || [])[1];
    const share = parseFloat((sec.match(/share:\s*([\d.]+)/) || [])[1]);
    if (!name || !share) continue;
    const kids = [];
    const kidRe = /^\s{6}([a-z-]+):\s*\{\s*share:\s*([\d.]+)(?:.*?route:\s*([a-z0-9-]+))?/gm;
    let m;
    while ((m = kidRe.exec(sec))) kids.push({ name: m[1], share: parseFloat(m[2]), route: m[3] || null });
    buckets.push({ name, share, amount: Math.round(base * share),
      children: kids.map(k => ({ ...k, amount: Math.round(base * share * k.share) })) });
  }
  return { base, planned: monthIncome <= 0, buckets };
}

/** Pure: everything the finance view needs, computed from already-read TSV rows. No I/O. */
function computeSummary({ accounts, txs, snaps, goals, incomeStreams, allocationModelRaw, now = new Date() }) {
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    const bal = num(a.BALANCE);
    if (LIABILITY_TYPES.has((a.TYPE || '').toLowerCase())) liabilities += Math.abs(bal);
    else assets += bal;
  }
  const net = assets - liabilities;

  const month = now.toISOString().slice(0, 7);
  const byCategory = {}; let inc = 0, exp = 0, lowNecessity = 0;
  const monthlyExpense = {};
  for (const t of txs) {
    const amt = num(t.AMOUNT);
    const m = String(t.DATE || '').slice(0, 7);
    if ((t.TYPE || '') === 'expense') monthlyExpense[m] = (monthlyExpense[m] || 0) + amt;
    if (m !== month) continue;
    if (t.TYPE === 'income') inc += amt;
    if (t.TYPE === 'expense') {
      exp += amt;
      const cat = t.CATEGORY || 'uncategorised';
      byCategory[cat] = (byCategory[cat] || 0) + amt;
      const nec = parseInt(t.NECESSITY, 10);
      if (Number.isFinite(nec) && nec <= 4) lowNecessity += amt;
    }
  }

  const closed = Object.keys(monthlyExpense).filter(m => m !== month).sort().slice(-3);
  const burn = closed.length
    ? closed.reduce((s, m) => s + monthlyExpense[m], 0) / closed.length
    : (exp || null);
  const runwayMonths = burn ? assets / burn : null;

  const todayD = now.getDate();
  const monthIncomeTx = txs.filter(t => t.TYPE === 'income' && String(t.DATE || '').slice(0, 7) === month);
  const streams = incomeStreams.filter(s => (s.STATUS || 'active') !== 'retired').map(s => {
    const matchWord = (s.MATCH && s.MATCH !== '-' ? s.MATCH : s.NAME).toLowerCase();
    const received = monthIncomeTx
      .filter(t => `${t.DESCRIPTION} ${t.CATEGORY}`.toLowerCase().includes(matchWord))
      .reduce((sum, t) => sum + num(t.AMOUNT), 0);
    const day = parseInt(s.DAY, 10);
    const monthly = (s.RECURS || '').toLowerCase() === 'monthly';
    const begun = !/^\d{4}-\d{2}$/.test(s.STARTS || '') || s.STARTS <= month;
    return { ...s, received, begun,
      expected: num(s.AMOUNT),
      dueDay: Number.isFinite(day) ? day : null,
      overdue: monthly && begun && (s.STATUS || 'active') === 'active'
               && Number.isFinite(day) && todayD > day && received <= 0 };
  });
  const expectedMonthly = streams
    .filter(s => (s.RECURS || '').toLowerCase() === 'monthly' && (s.STATUS || 'active') === 'active')
    .reduce((sum, s) => sum + s.expected, 0);

  const allocation = (() => {
    const a = parseAllocationModel(allocationModelRaw, inc > 0 ? inc : expectedMonthly);
    if (a) a.planned = inc <= 0;
    return a;
  })();

  return {
    currency: accounts.find(a => a.CURRENCY && a.CURRENCY !== '-')?.CURRENCY || 'KES',
    accounts, netWorth: { assets, liabilities, net },
    month: { month, income: inc, expense: exp, netFlow: inc - exp,
             savingsRate: inc > 0 ? Math.round(((inc - exp) / inc) * 100) : null,
             byCategory, lowNecessity },
    burn: burn ? Math.round(burn) : null,
    runwayMonths: runwayMonths ? Math.round(runwayMonths * 10) / 10 : null,
    trend: snaps.slice(-12),
    goals,
    incomes: { streams, expectedMonthly },
    txCount: txs.length,
    recent: txs.slice(-8).reverse(),
    allocation,
  };
}

/**
 * @param {object} opts
 * @param {(rel:string) => object[]} opts.readTSV
 * @param {(rel:string, row:object) => void} opts.appendTSV
 * @param {(rel:string, fn:(rows:object[]) => object[]) => number} opts.rewriteTSV
 * @param {() => string} [opts.readAllocationModel] - returns the raw model.yaml-shaped text, or ''
 * @param {(path:string, opts?:object) => Promise<{status:number,data:any}>} [opts.graphRequest] - MS Graph, for OneDrive push/pull
 * @param {(secretName:string) => string|null} [opts.getSecret] - for a venture's AUTH_SECRET
 * @param {typeof fetch} [opts.fetchFn]
 * @param {{log:Function}} [opts.auditLog]
 * @param {string} [opts.driveDir]
 * @param {number} [opts.pullIntervalMs]
 */
function createFinanceClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    readAllocationModel = () => '',
    graphRequest = null,
    getSecret = () => null,
    fetchFn = fetch,
    auditLog = { log: () => {} },
    // No hardcoded fallback: this used to assume every tenant's OneDrive
    // literally contains a folder named "Architect" laid out the same way his
    // does -- config-first genericization (Decision 002's pattern). Push/
    // pull are already no-ops without a configured graphRequest, so an
    // unset driveDir just means "not configured yet", not a crash.
    driveDir = '',
    pullIntervalMs = 5 * 60 * 1000,
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createFinanceClient requires readTSV/appendTSV/rewriteTSV');

  const sync = { lastPull: 0, status: 'not synced yet', error: null, at: null };
  const knownRemote = new Map(); // rel -> our own last-written remote mtime, so pull can tell our write from a foreign one
  const pushState = new Map();   // rel -> { running, again } -- serializes concurrent pushes per file

  /** Write-through push of one ledger file. Serialized per file with a trailing re-push, so a fast second write during an in-flight push is never lost to the first push's stale read. */
  async function drivePush(rel, content) {
    if (!graphRequest) return { ok: false, error: 'no graph client configured' };
    const q = pushState.get(rel) || { running: false, again: false };
    pushState.set(rel, q);
    if (q.running) { q.again = true; return { ok: true, queued: true }; }
    q.running = true;
    let last = null;
    try {
      do {
        q.again = false;
        const put = () => graphRequest(
          `/v1.0/me/drive/root:/${encodeURIComponent(driveDir)}/${encodeURIComponent(rel)}:/content`,
          { method: 'PUT', body: content, headers: { 'Content-Type': 'text/plain' } });
        let r = await put();
        if (r.status === 404 || r.status === 400) {
          let base = '';
          for (const seg of driveDir.split('/')) {
            await graphRequest(base ? `/v1.0/me/drive/root:/${encodeURIComponent(base)}:/children`
                                    : '/v1.0/me/drive/root/children',
              { method: 'POST', body: JSON.stringify({ name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }) });
            base = base ? `${base}/${seg}` : seg;
          }
          r = await put();
        }
        const ok = r.status >= 200 && r.status < 300;
        if (ok) knownRemote.set(rel, Date.parse(r.data?.lastModifiedDateTime || '') || Date.now());
        sync.status = ok ? 'synced' : 'push failed';
        sync.error = ok ? null : (r.data?.error?.message || `HTTP ${r.status}`);
        sync.at = new Date().toISOString();
        auditLog.log('finance_drive_push', { file: rel, ok, status: r.status });
        last = { ok, status: r.status };
      } while (q.again);
      return last;
    } finally { q.running = false; }
  }

  /**
   * Read-repair: pulls a newer remote copy over local, EXCEPT it refuses to
   * let a freshly-booted, still-empty local file (the ephemeral-host case --
   * a new container boots with header-only ledgers, seconds old, which would
   * otherwise look "newer" than an hours-old real remote and win by mistake)
   * overwrite real data, and refuses to accept a remote file that lost its
   * header (would silently wipe the ledger).
   */
  async function drivePull({ force = false, localReader } = {}) {
    if (!graphRequest) return;
    if (!force && Date.now() - sync.lastPull < pullIntervalMs) return;
    sync.lastPull = Date.now();
    const r = await graphRequest(`/v1.0/me/drive/root:/${encodeURIComponent(driveDir)}:/children`);
    if (r.status === 404) { sync.status = 'no remote yet'; return; }
    if (!(r.status >= 200 && r.status < 300)) {
      sync.status = 'offline'; sync.error = r.data?.error?.message || `HTTP ${r.status}`;
      return;
    }
    const remote = new Map((r.data?.value || []).map(i => [i.name, i]));
    const pulled = [];
    for (const rel of FINANCE_FILES) {
      const item = remote.get(rel);
      const local = localReader ? localReader(rel) : { text: '', mtimeMs: 0, exists: false };
      const remoteMtime = item ? Date.parse(item.lastModifiedDateTime) : 0;
      const own = Math.abs(remoteMtime - (knownRemote.get(rel) || 0)) < 1500;
      const localIsEmpty = local.text.trim().split(/\r?\n/).filter(l => l.trim()).length <= 1;
      const remoteHasRows = item && (item.size || 0) > 40;

      if (item && !own && item['@microsoft.graph.downloadUrl']
          && (remoteMtime > local.mtimeMs + 2000 || (localIsEmpty && remoteHasRows))) {
        try {
          const text = await (await fetchFn(item['@microsoft.graph.downloadUrl'])).text();
          if (text.startsWith('ID\t') || text.startsWith('DATE\t')) {
            pulled.push({ rel, text });
            auditLog.log('finance_drive_pulled', { file: rel });
          }
        } catch { /* keep local; next pull retries */ }
      } else if (!item && local.exists && !localIsEmpty) {
        drivePush(rel, local.text).catch(() => {});
      }
    }
    sync.status = 'synced'; sync.error = null; sync.at = new Date().toISOString();
    return pulled;   // caller writes these to disk -- this module has no filesystem access of its own
  }

  function summary({ now } = {}) {
    return computeSummary({
      accounts: readTSV('finance/accounts.tsv'),
      txs: readTSV('finance/transactions.tsv'),
      snaps: readTSV('finance/networth.tsv'),
      goals: readTSV('finance/goals.tsv'),
      incomeStreams: readTSV('finance/incomes.tsv'),
      allocationModelRaw: readAllocationModel(),
      now: now || new Date(),
    });
  }

  function upsertIncome(p) {
    const rows = readTSV('finance/incomes.tsv');
    const id = p.id || `inc-${slug(p.name, Date.now())}`;
    const existing = rows.find(r => r.ID === id);
    if (!existing && !String(p.name || '').trim()) throw new Error('name required for a new stream');
    const row = {
      ID: id,
      NAME: p.name !== undefined ? clean(p.name) : existing?.NAME,
      SOURCE: p.source !== undefined ? (clean(p.source) || '-') : (existing?.SOURCE || '-'),
      AMOUNT: p.amount !== undefined ? String(parseFloat(p.amount) || 0) : (existing?.AMOUNT || '0'),
      CURRENCY: (p.currency || existing?.CURRENCY || 'KES').toUpperCase(),
      RECURS: (p.recurs || existing?.RECURS || 'monthly').toLowerCase(),
      DAY: p.day !== undefined ? (clean(p.day) || '-') : (existing?.DAY || '-'),
      ACCOUNT_ID: p.account !== undefined ? (p.account || '-') : (existing?.ACCOUNT_ID || '-'),
      MATCH: p.match !== undefined ? (clean(p.match).toLowerCase() || '-') : (existing?.MATCH || '-'),
      STATUS: p.status || existing?.STATUS || 'active',
      STARTS: /^\d{4}-\d{2}$/.test(p.starts || '') ? p.starts : (existing?.STARTS || '-'),
      NOTE: p.note !== undefined ? (clean(p.note) || '-') : (existing?.NOTE || '-'),
    };
    if (existing) rewriteTSV('finance/incomes.tsv', rows2 => rows2.map(r => r.ID === id ? row : r));
    else appendTSV('finance/incomes.tsv', row);
    auditLog.log('finance_income_upserted', { id, created: !existing });
    return { id, created: !existing, row };
  }

  function upsertAccount(p) {
    const accounts = readTSV('finance/accounts.tsv');
    const id = p.id || `acc-${slug(p.name, 'account')}`;
    const existing = accounts.find(a => a.ID === id);
    if (!existing && !String(p.name || '').trim()) throw new Error('name required for a new account');
    const row = {
      ID: id,
      NAME: p.name !== undefined ? clean(p.name) : (existing?.NAME || id),
      TYPE: (p.type || existing?.TYPE || 'cash').toLowerCase(),
      INSTITUTION: p.institution !== undefined ? (p.institution || '-') : (existing?.INSTITUTION || '-'),
      CURRENCY: (p.currency || existing?.CURRENCY || 'KES').toUpperCase(),
      BALANCE: p.balance !== undefined ? String(parseFloat(p.balance) || 0) : (existing?.BALANCE || '0'),
      ASOF: new Date().toISOString().slice(0, 10),
      NOTE: p.note !== undefined ? (p.note || '-') : (existing?.NOTE || '-'),
    };
    if (existing) rewriteTSV('finance/accounts.tsv', rows => rows.map(r => r.ID === id ? row : r));
    else appendTSV('finance/accounts.tsv', row);
    auditLog.log('finance_account_upserted', { id, created: !existing });
    return { id, created: !existing, row };
  }

  /** ID follows the original May-2025 convention: finance-YYYY-MM-DD-NNN, sequenced within the day. */
  function addTransaction(p) {
    const amount = parseFloat(p.amount);
    if (!['expense', 'income', 'transfer'].includes(p.type)) throw new Error('type must be expense, income or transfer');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : new Date().toISOString().slice(0, 10);
    const seq = readTSV('finance/transactions.tsv').filter(t => t.DATE === date).length + 1;
    const row = {
      ID: `finance-${date}-${String(seq).padStart(3, '0')}`,
      DATE: date, TYPE: p.type, AMOUNT: String(amount),
      CURRENCY: (p.currency || 'KES').toUpperCase(),
      CATEGORY: (p.category || 'uncategorised').toLowerCase(),
      DESCRIPTION: clean(p.description) || '-',
      ACCOUNT_ID: p.account || '-',
      VENDOR: String(p.vendor || '').replace(/[\t\r\n]+/g, ' ') || '-',
      NECESSITY: /^([1-9]|10)$/.test(String(p.necessity)) ? String(p.necessity) : '-',
      SATISFACTION: /^([1-9]|10)$/.test(String(p.satisfaction)) ? String(p.satisfaction) : '-',
      TAGS: Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || '-'),
      NOTE: clean(p.note) || '-',
    };
    appendTSV('finance/transactions.tsv', row);
    auditLog.log('finance_tx_added', { id: row.ID, type: row.TYPE, category: row.CATEGORY });
    return row;
  }

  /** One row per date -- re-running today replaces rather than duplicating. */
  function snapshot({ now } = {}) {
    const accounts = readTSV('finance/accounts.tsv');
    let assets = 0, liabilities = 0;
    for (const a of accounts) {
      const bal = num(a.BALANCE);
      if (LIABILITY_TYPES.has((a.TYPE || '').toLowerCase())) liabilities += Math.abs(bal); else assets += bal;
    }
    const today = (now || new Date()).toISOString().slice(0, 10);
    const row = { DATE: today, ASSETS: String(assets), LIABILITIES: String(liabilities),
                  NET: String(assets - liabilities), NOTE: '-' };
    const replaced = rewriteTSV('finance/networth.tsv', rows => rows.filter(r => r.DATE !== today));
    appendTSV('finance/networth.tsv', row);
    auditLog.log('finance_snapshot', { date: today, net: row.NET, replaced: replaced > 0 });
    return row;
  }

  const venturesCache = new Map(); // id -> { at, metrics, error }

  /** Each venture exposes a metrics endpoint: GET the URL (optional bearer from a named secret) -> flat JSON. Only scalar top-level keys are trusted -- the agent never invents a metric it wasn't given. */
  async function listVentures({ force = false } = {}) {
    const rows = readTSV('finance/ventures.tsv');
    const out = [];
    for (const v of rows) {
      const entry = { ...v, metrics: null, error: null, fetchedAt: null };
      const cached = venturesCache.get(v.ID);
      if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) {
        Object.assign(entry, { metrics: cached.metrics, error: cached.error, fetchedAt: new Date(cached.at).toISOString() });
      } else if (v.ANALYTICS_URL && v.ANALYTICS_URL !== '-' && (v.STATUS || 'active') === 'active') {
        try {
          const headers = {};
          if (v.AUTH_SECRET && v.AUTH_SECRET !== '-') {
            const secretVal = getSecret(v.AUTH_SECRET);
            if (secretVal) headers.Authorization = `Bearer ${secretVal}`;
          }
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 6000);
          const r = await fetchFn(v.ANALYTICS_URL, { headers, signal: ctl.signal });
          clearTimeout(timer);
          const data = await r.json();
          const metrics = {};
          for (const [k, val] of Object.entries(data || {})) {
            if (['number', 'string', 'boolean'].includes(typeof val)) metrics[k] = val;
          }
          entry.metrics = metrics; entry.fetchedAt = new Date().toISOString();
          venturesCache.set(v.ID, { at: Date.now(), metrics, error: null });
        } catch (e) {
          entry.error = String(e.name === 'AbortError' ? 'timed out' : (e.message || e)).slice(0, 100);
          venturesCache.set(v.ID, { at: Date.now(), metrics: null, error: entry.error });
        }
      }
      out.push(entry);
    }
    return out;
  }

  function upsertVenture(p) {
    const rows = readTSV('finance/ventures.tsv');
    const id = p.id || `ven-${slug(p.name, Date.now())}`;
    const existing = rows.find(r => r.ID === id);
    if (!existing && !String(p.name || '').trim()) throw new Error('name required');
    const row = {
      ID: id,
      NAME: p.name !== undefined ? clean(p.name) : existing?.NAME,
      KIND: p.kind !== undefined ? (clean(p.kind) || 'saas') : (existing?.KIND || 'saas'),
      ANALYTICS_URL: p.url !== undefined ? (clean(p.url) || '-') : (existing?.ANALYTICS_URL || '-'),
      AUTH_SECRET: p.authSecret !== undefined ? (clean(p.authSecret) || '-') : (existing?.AUTH_SECRET || '-'),
      STATUS: p.status || existing?.STATUS || 'active',
      NOTE: p.note !== undefined ? (clean(p.note) || '-') : (existing?.NOTE || '-'),
    };
    if (existing) rewriteTSV('finance/ventures.tsv', rows2 => rows2.map(r => r.ID === id ? row : r));
    else appendTSV('finance/ventures.tsv', row);
    venturesCache.delete(id);
    auditLog.log('venture_upserted', { id, created: !existing });
    return { id, created: !existing, row };
  }

  return {
    summary, upsertIncome, upsertAccount, addTransaction, snapshot,
    listVentures, upsertVenture,
    drivePush, drivePull, sync,
  };
}

module.exports = { createFinanceClient, computeSummary, parseAllocationModel, LIABILITY_TYPES, FINANCE_FILES };
