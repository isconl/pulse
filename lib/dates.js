'use strict';
/**
 * Important Dates: anniversaries and day counts. Ported from isconl-agent's
 * server.js (~10480-10585).
 *
 * The arithmetic lives here so every surface (calendar, Telegram, reminders)
 * shows identical numbers. For a recurring date the counter runs since the
 * ORIGINAL date -- a birthday is "days lived", not "days since the last
 * party" -- and the next round-thousand is a milestone.
 */

function createDatesClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    sendReminder = async () => {},
    readReminded = async () => ({}),
    writeReminded = async () => {},
    datesFile = 'scope/dates.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createDatesClient requires readTSV/appendTSV/rewriteTSV');

  function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

  function computeDates(now = new Date()) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const DAY = 86400000;
    return readTSV(datesFile).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.DATE)).map(r => {
      const base = new Date(r.DATE + 'T00:00:00');
      const diff = Math.round((today - base) / DAY);
      const out = { ...r, daysSince: diff >= 0 ? diff : null, daysUntil: diff < 0 ? -diff : null, milestones: [] };

      if ((r.RECURS || '').toLowerCase() === 'yearly') {
        let next = new Date(today.getFullYear(), base.getMonth(), base.getDate());
        if (next < today) next = new Date(today.getFullYear() + 1, base.getMonth(), base.getDate());
        out.nextOccurrence = next.toISOString().slice(0, 10);
        out.daysToNext = Math.round((next - today) / DAY);
        out.yearsTurning = next.getFullYear() - base.getFullYear();
        const y = out.yearsTurning;
        out.milestones.push({
          label: (r.KIND || '').toLowerCase() === 'birthday' ? `turns ${y}` : `${y} year${y === 1 ? '' : 's'}`,
          date: out.nextOccurrence, days: out.daysToNext });
      }
      if (diff > 0) {
        const nextK = Math.ceil((diff + 1) / 1000) * 1000;
        const kDate = new Date(base.getTime() + nextK * DAY);
        out.milestones.push({ label: `day ${nextK.toLocaleString('en-KE')}`,
          date: kDate.toISOString().slice(0, 10), days: nextK - diff });
      }
      out.milestones.sort((a, b) => a.days - b.days);
      return out;
    }).sort((a, b) => (a.milestones[0]?.days ?? 9e9) - (b.milestones[0]?.days ?? 9e9));
  }

  function listDates(now = new Date()) {
    const dates = computeDates(now);
    const upcoming = dates.flatMap(d => d.milestones.map(m => ({ ...m, title: d.TITLE, id: d.ID })))
      .filter(m => m.days <= 45).sort((a, b) => a.days - b.days);
    return { dates, upcoming };
  }

  function addDate(p) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new Error('date must be YYYY-MM-DD');
    if (!String(p.title || '').trim()) throw new Error('title required');
    const rows = readTSV(datesFile);
    const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    const row = { ID: `D${String(n).padStart(3, '0')}`, TITLE: clean(p.title), DATE: p.date,
      KIND: clean(p.kind || 'anniversary'), WHO: clean(p.who), RECURS: p.recurs === false ? '-' : 'yearly',
      COLOR: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '-',
      NOTE: clean(p.note) };
    appendTSV(datesFile, row);
    auditLog.log('date_added', { id: row.ID, title: row.TITLE });
    return { success: true, id: row.ID };
  }

  function deleteDate(id) {
    const removed = rewriteTSV(datesFile, rows => rows.filter(r => r.ID !== id));
    auditLog.log('date_deleted', { id, removed });
    return { success: removed > 0 };
  }

  /** Milestone reminders at 30/7/1/0 days out, once each -- a sent-ledger prevents a restart from re-spamming. */
  async function sendDueReminders(now = new Date()) {
    const ledger = (await readReminded()) || {};
    const dates = computeDates(now);
    const sent = [];
    for (const d of dates) {
      for (const m of d.milestones) {
        const tier = [30, 7, 1, 0].find(t => m.days === t);
        if (tier === undefined) continue;
        const key = `${d.ID}:${m.label}:${m.date}:${tier}`;
        if (ledger[key]) continue;
        const msg = m.days === 0
          ? `Today: ${d.TITLE} - ${m.label}.`
          : `${m.days} day${m.days === 1 ? '' : 's'} to ${d.TITLE} - ${m.label} on ${m.date}.`;
        await sendReminder(`? ${msg}`);
        ledger[key] = new Date().toISOString();
        sent.push(key);
      }
    }
    if (sent.length) {
      await writeReminded(ledger);
      auditLog.log('date_reminders_sent', { count: sent.length });
    }
    return { success: true, sent: sent.length };
  }

  return { computeDates, listDates, addDate, deleteDate, sendDueReminders };
}

module.exports = { createDatesClient };
