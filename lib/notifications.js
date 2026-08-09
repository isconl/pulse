'use strict';
/**
 * Notification centre. Ported from isconl-agent's server.js notify()/
 * notificationSweep() (~1478-1675). The /api/notifications* routes
 * (~12949-13130) become pulse's HTTP wrapper later, not part of this module.
 *
 * Three rules from the original that still hold:
 *  1. APPEND-ONLY, NEVER PRUNED -- a row survives being read.
 *  2. DEDUPED BY THE UNDERLYING FACT -- a DEDUPE_KEY built from the thing
 *     itself, so a sweep can run every 10 minutes and never repeat itself.
 *  3. NEVER INVENTS -- states what a source said, no inference.
 *
 * CROSS-ENGINE SOURCES (this resolves the open judgment call flagged in the
 * refactor canvas under `pulse`): vault is genuinely shared storage every
 * engine reads/writes through -- readTSV/appendTSV already ARE the wire
 * boundary to `vault` (an HTTP call in production, an injected function
 * here), so Tasks (scope/tasks.tsv) are read the same way the original did,
 * with no extra indirection. What has NO backing vault file still needs a
 * real injected fetcher: Jira issues (a live Jira API call scope owns) and
 * vault-sync status (in-memory state on the vault process, not a file) --
 * both are polls, not shared closures, and default to contributing nothing
 * when unset, so this module runs standalone today.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim(); }

function createNotificationsClient(opts) {
  const {
    readTSV, appendTSV,
    auditLog = { log: () => {} },
    notifFile = 'notifications.tsv',
    githubApi = null,
    wellspringRepo = '',
    wellspringSelf = '',
    fetchVaultStatus = async () => null,
    fetchJiraIssues = async () => [],
    // calendar/dates now exist as pulse's own lib/calendar.js and lib/dates.js
    // (same repo) -- still passed in rather than require()'d directly, so the
    // HTTP service wrapper (the composition root) decides how they're wired,
    // and this module stays testable without constructing real instances.
    fetchCalendarEvents = async () => [],
    fetchDates = async () => [],
  } = opts;
  if (!readTSV || !appendTSV) throw new Error('createNotificationsClient requires readTSV/appendTSV');

  /** Notice one fact. Returns true when it was new, false when already known. */
  function notify({ source, kind, title, body = '', view = '', ref = '', severity = 'info', dedupeKey }) {
    try {
      const key = String(dedupeKey || `${source}:${kind}:${title}`).replace(/[\t\r\n]+/g, ' ').slice(0, 160);
      const rows = readTSV(notifFile);
      if (rows.some(r => r.DEDUPE_KEY === key)) return false;
      appendTSV(notifFile, {
        ID: `N${Date.now()}${Math.floor(rows.length % 1000)}`,
        TS: new Date().toISOString(),
        SOURCE: clean(source), KIND: clean(kind), SEVERITY: clean(severity),
        TITLE: clean(title).slice(0, 160), BODY: clean(body).slice(0, 400),
        VIEW: clean(view), REF: clean(ref), STATUS: 'new', DEDUPE_KEY: key, SEEN_AT: '-',
      });
      auditLog.log('notification_raised', { source, kind, severity });
      return true;
    } catch (e) {
      auditLog.log('notification_failed', { error: String(e.message || e).slice(0, 120) });
      return false;
    }
  }

  /**
   * Look at every source and notice what changed. Cheap and local by
   * default; network-backed sources only run when `deep` is true, so this
   * can run on a timer safely.
   */
  async function notificationSweep({ deep = false } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    let raised = 0;
    const add = (n) => { if (notify(n)) raised++; };

    // -- TASKS (scope/tasks.tsv, via the shared vault store): overdue, and due today --
    try {
      for (const t of readTSV('scope/tasks.tsv') || []) {
        if (t.STATUS === 'done' || !t.DUE_DATE || t.DUE_DATE === '-') continue;
        if (t.DUE_DATE < today) {
          add({ source: 'tasks', kind: 'overdue', severity: 'high',
            title: `Overdue: ${t.TITLE}`, body: `Was due ${t.DUE_DATE}. Priority ${t.PRIORITY || 'medium'}.`,
            view: 'task', ref: t.ID, dedupeKey: `task-overdue:${t.ID}:${t.DUE_DATE}` });
        } else if (t.DUE_DATE === today) {
          add({ source: 'tasks', kind: 'due-today', severity: 'medium',
            title: `Due today: ${t.TITLE}`, body: `Priority ${t.PRIORITY || 'medium'}.`,
            view: 'task', ref: t.ID, dedupeKey: `task-due:${t.ID}:${t.DUE_DATE}` });
        }
      }
    } catch {}

    // -- CALENDAR (pulse's own lib/calendar.js, wired in by the caller): today/tomorrow --
    try {
      for (const e of (await fetchCalendarEvents()) || []) {
        if (e.date !== today && e.date !== tomorrow) continue;
        add({ source: 'calendar', kind: e.date === today ? 'today' : 'tomorrow',
          severity: e.date === today ? 'medium' : 'info',
          title: `${e.date === today ? 'Today' : 'Tomorrow'}: ${e.title}`,
          body: [e.time, e.category, e.location].filter(x => x && x !== '-').join(' · '),
          view: 'calendar', ref: String(e.id || ''),
          dedupeKey: `event:${e.id || e.title}:${e.date}` });
      }
    } catch {}

    // -- IMPORTANT DATES (pulse's own lib/dates.js, wired in by the caller): a week's warning --
    try {
      for (const d of (await fetchDates()) || []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.DATE || '')) continue;
        const src = new Date(d.DATE);
        const next = new Date(new Date().getFullYear(), src.getMonth(), src.getDate());
        if (next < new Date(today)) next.setFullYear(next.getFullYear() + 1);
        const days = Math.round((next - new Date(today)) / 864e5);
        if (days > 7 || days < 0) continue;
        add({ source: 'dates', kind: 'approaching', severity: days <= 1 ? 'medium' : 'info',
          title: `${d.TITLE} - ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
          body: `${d.KIND || 'date'}${d.WHO && d.WHO !== '-' ? ` · ${d.WHO}` : ''}`,
          view: 'calendar', ref: d.ID,
          dedupeKey: `date:${d.ID}:${next.toISOString().slice(0, 10)}` });
      }
    } catch {}

    // -- MONEY (pulse's own finance ledgers): an expected stream that has not landed --
    try {
      const dayOfMonth = new Date().getDate();
      const month = today.slice(0, 7);
      const txs = readTSV('finance/transactions.tsv');
      for (const s of readTSV('finance/incomes.tsv')) {
        if ((s.STATUS || 'active') !== 'active' || (s.RECURS || '') !== 'monthly') continue;
        const dueDay = parseInt(s.DAY, 10);
        if (!dueDay || dayOfMonth <= dueDay) continue;
        const word = (s.MATCH && s.MATCH !== '-' ? s.MATCH : (s.NAME || '')).toLowerCase();
        const landed = txs.some(t => t.TYPE === 'income' && (t.DATE || '').startsWith(month)
          && `${t.DESCRIPTION} ${t.CATEGORY}`.toLowerCase().includes(word));
        if (!landed) {
          add({ source: 'finance', kind: 'income-late', severity: 'high',
            title: `${s.NAME} has not landed`, body: `Expected by the ${dueDay}th. Chase it while it is only days late - politely, in writing.`,
            view: 'finance', ref: s.ID, dedupeKey: `income-late:${s.ID}:${month}` });
        }
      }
    } catch {}

    // -- VAULT (vault engine, injected): the persistence layer failing is the loudest thing there is --
    try {
      const status = await fetchVaultStatus();
      if (status && (status.status === 'offline' || status.error)) {
        add({ source: 'vault', kind: 'sync-failing', severity: 'high',
          title: 'OneDrive sync is failing', body: String(status.error || 'The vault could not reach OneDrive - data is only on this machine.'),
          view: 'settings', dedupeKey: `vault-sync:${today}:${String(status.error || 'offline').slice(0, 40)}` });
      }
    } catch {}

    // -- JIRA (scope, injected): the board moving without him --
    if (deep) {
      try {
        for (const i of (await fetchJiraIssues()) || []) {
          add({ source: 'jira', kind: 'status', severity: 'info',
            title: `${i.key} is ${i.status}`, body: i.summary || '',
            view: 'jira', ref: i.key, dedupeKey: `jira:${i.key}:${i.status}` });
          if (i.duedate && i.duedate < today && !/done|closed|resolved/i.test(i.status || '')) {
            add({ source: 'jira', kind: 'overdue', severity: 'high',
              title: `${i.key} is past its due date`, body: `${i.summary || ''} - due ${i.duedate}`,
              view: 'jira', ref: i.key, dedupeKey: `jira-overdue:${i.key}:${i.duedate}` });
          }
        }
      } catch {}
    }

    // -- GITHUB: notifications, pulled so he never opens the site for them --
    if (deep && githubApi) {
      try {
        const list = await githubApi('/notifications?per_page=20');
        for (const n of (Array.isArray(list) ? list : [])) {
          add({ source: 'github', kind: n.reason || 'notification', severity: 'info',
            title: n.subject?.title || 'GitHub notification',
            body: `${n.repository?.full_name || ''}${n.reason ? ` · ${n.reason}` : ''}`,
            view: 'github', ref: n.id || '', dedupeKey: `gh:${n.id}:${n.updated_at}` });
        }
      } catch {}
    }

    // -- WELLSPRING: everything that happens in a watched content pipeline --
    //
    // Polled directly rather than read off the GitHub notifications feed
    // above, because that feed only carries repos you are actively
    // subscribed to -- an unwatched repo, or a lapsed subscription, and the
    // work is invisible. No hardcoded repo (see genericization notes on the
    // original) -- silently skipped when wellspringRepo isn't configured.
    if (deep && githubApi && wellspringRepo) {
      const shortRepo = wellspringRepo.split('/').pop();
      const me = wellspringSelf ? new RegExp(`^${wellspringSelf}$`, 'i') : null;
      try {
        const commits = await githubApi(`/repos/${wellspringRepo}/commits?per_page=15`);
        for (const c of (Array.isArray(commits) ? commits : [])) {
          if (!c || !c.sha) continue;
          const who = c.author?.login || c.commit?.author?.name || 'unknown';
          const subject = String(c.commit?.message || '').split('\n')[0];
          const mine = me ? me.test(who) : false;
          add({ source: 'wellspring', kind: mine ? 'commit-own' : 'commit',
            severity: mine ? 'info' : 'medium',
            title: `${shortRepo}: ${subject}`,
            body: `${who} · ${String(c.commit?.author?.date || '').slice(0, 10)} · ${String(c.sha).slice(0, 9)}`,
            view: 'github', ref: c.sha, dedupeKey: `ws:commit:${c.sha}` });
        }
      } catch {}
      try {
        const prs = await githubApi(`/repos/${wellspringRepo}/pulls?state=all&per_page=10&sort=updated&direction=desc`);
        for (const p of (Array.isArray(prs) ? prs : [])) {
          if (!p || !p.number) continue;
          const who = p.user?.login || 'unknown';
          const open = p.state === 'open';
          add({ source: 'wellspring', kind: `pr-${p.state}`,
            severity: open ? 'high' : 'info',
            title: `PR #${p.number} ${open ? 'open' : p.state}: ${p.title || ''}`,
            body: `${who} · ${p.head?.ref || '?'} into ${p.base?.ref || '?'} · updated ${String(p.updated_at || '').slice(0, 10)}`,
            view: 'github', ref: String(p.number),
            dedupeKey: `ws:pr:${p.number}:${p.updated_at}` });
        }
      } catch {}
    }

    if (raised) auditLog.log('notification_sweep', { raised, deep });
    return raised;
  }

  function listNotifications({ limit = 100 } = {}) {
    return readTSV(notifFile).reverse().slice(0, limit);
  }

  function markSeen({ ids = [], all = false, status = 'seen' } = {}) {
    const idSet = new Set(ids);
    const rows = readTSV(notifFile);
    let count = 0;
    for (const r of rows) {
      if (all || idSet.has(r.ID)) { r.STATUS = status; r.SEEN_AT = new Date().toISOString(); count++; }
    }
    auditLog.log('notifications_marked', { count: all ? 'all' : count, status });
    return { count, rows };
  }

  return { notify, notificationSweep, listNotifications, markSeen };
}

module.exports = { createNotificationsClient };
