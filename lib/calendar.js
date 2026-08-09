'use strict';
/**
 * Calendar: local events, Microsoft 365 / .ics import, and the day view.
 * Ported from isconl-agent's server.js (~13024-13170).
 *
 * Local events persist as JSON (not a TSV -- an event's shape varies more
 * than a ledger row's), via injected readEvents/writeEvents so a real
 * service can back it with a file while tests use memory.
 *
 * CROSS-ENGINE (same reasoning as notifications.js): creating a task from an
 * event is a `scope` capability, and raising a notification is `notify()`
 * from this repo's own notifications.js -- both are injected so calendar.js
 * doesn't hard-depend on either. Left unset, both are silently skipped.
 */

function createCalendarClient(opts) {
  const {
    readEvents, writeEvents,
    auditLog = { log: () => {} },
    graphRequest = null,
    addTask = null,     // async (task) => void -- scope engine, injected
    notify = null,       // (n) => boolean -- this repo's notifications.js, injected
    nextTaskId = null,   // async () => string -- scope owns ID sequencing; falls back to a local counter if unset
  } = opts;
  if (!readEvents || !writeEvents) throw new Error('createCalendarClient requires readEvents/writeEvents');

  async function addEvent(incoming) {
    const events = (await readEvents()) || [];
    const newEvent = { ...incoming, id: Date.now().toString(), source: 'local', created: new Date().toISOString() };
    delete newEvent.makeTask;
    events.push(newEvent);
    await writeEvents(events);
    auditLog.log('calendar_event_created', { title: newEvent.title, date: newEvent.date });

    if (notify) {
      notify({ source: 'calendar', kind: 'scheduled', severity: 'info',
        title: `Scheduled: ${newEvent.title}`,
        body: [newEvent.date, newEvent.time, newEvent.category].filter(x => x && x !== '-').join(' · '),
        view: 'calendar', ref: newEvent.id, dedupeKey: `event-created:${newEvent.id}` });
    }

    let task = null;
    if (incoming.makeTask && addTask) {
      const id = nextTaskId ? await nextTaskId() : `T${Date.now()}`;
      task = {
        ID: id, TITLE: `Prepare for: ${newEvent.title}`,
        STATUS: 'next', PRIORITY: newEvent.category === 'deadline' ? 'high' : 'medium',
        DUE_DATE: newEvent.date || '-', TAG: newEvent.tag || '-',
        CREATED_AT: new Date().toISOString().slice(0, 10),
        ORIGIN: `calendar:${newEvent.id}`,
        WHY: `Committed to by scheduling "${newEvent.title}" on ${newEvent.date}.`,
      };
      await addTask(task);
      auditLog.log('task_from_event', { taskId: id, eventId: newEvent.id });
      if (notify) {
        notify({ source: 'tasks', kind: 'created', severity: 'info',
          title: `Task added: ${task.TITLE}`, body: `Due ${task.DUE_DATE} - from the calendar.`,
          view: 'task', ref: id, dedupeKey: `task-created:${id}` });
      }
    }
    return { success: true, event: newEvent, task };
  }

  /** Minimal, dependency-free ICS reader -- forgiving on purpose: a half-parsed export beats a refused one. */
  function parseIcs(text, label) {
    const found = [];
    const unfolded = String(text || '').replace(/\r\n[ \t]/g, '');
    if (!/BEGIN:VEVENT/i.test(unfolded)) throw new Error('That does not look like an .ics calendar export');
    for (const block of unfolded.split(/BEGIN:VEVENT/i).slice(1)) {
      const get = (k) => (block.match(new RegExp(`^${k}[^:\\r\\n]*:(.*)$`, 'im')) || [])[1]?.trim() || '';
      const dt = get('DTSTART');
      const d = dt.replace(/[^0-9T]/g, '');
      if (d.length < 8) continue;
      found.push({
        title: get('SUMMARY') || 'Untitled',
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        time: d.length >= 13 ? `${d.slice(9, 11)}:${d.slice(11, 13)}` : '',
        category: /deadline|due/i.test(get('SUMMARY')) ? 'deadline' : 'work',
        location: get('LOCATION'), importedFrom: label || 'ics',
      });
    }
    return found;
  }

  async function importEvents(p) {
    const existing = (await readEvents()) || [];
    const seen = new Set(existing.map(e => `${e.title}|${e.date}`));
    let found = [];

    if (p.source === 'microsoft') {
      if (!graphRequest) throw new Error('Microsoft 365 import requires a configured graph client');
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 90 * 864e5).toISOString();
      const r = await graphRequest(
        `/v1.0/me/calendarView?startDateTime=${from}&endDateTime=${to}&$select=subject,start,end,location,categories&$top=100`);
      if (!r.data?.value) throw new Error(r.data?.error?.message || 'Microsoft 365 returned no calendar');
      found = r.data.value.map(e => ({ title: e.subject || 'Untitled', date: (e.start?.dateTime || '').slice(0, 10),
        time: (e.start?.dateTime || '').slice(11, 16), category: 'work',
        location: e.location?.displayName || '', importedFrom: 'microsoft365' }));
    } else {
      found = parseIcs(p.ics, p.label);
    }

    const fresh = found.filter(e => e.date && !seen.has(`${e.title}|${e.date}`));
    let n = 0;
    for (const e of fresh) existing.push({ ...e, id: `${Date.now()}${n++}`, source: 'imported', created: new Date().toISOString() });
    await writeEvents(existing);
    auditLog.log('calendar_imported', { source: p.source || 'ics', found: found.length, added: fresh.length });
    if (fresh.length && notify) {
      notify({ source: 'calendar', kind: 'imported', severity: 'info',
        title: `${fresh.length} event${fresh.length === 1 ? '' : 's'} imported`,
        body: `From ${p.source === 'microsoft' ? 'Microsoft 365' : (p.label || 'an .ics export')}. ${found.length - fresh.length} already known.`,
        view: 'calendar', dedupeKey: `cal-import:${Date.now()}` });
    }
    return { success: true, found: found.length, added: fresh.length };
  }

  async function listEvents() {
    const events = (await readEvents()) || [];
    let msEvents = [];
    if (graphRequest) {
      try {
        const now = new Date().toISOString();
        const future = new Date(Date.now() + 30 * 864e5).toISOString();
        const r = await graphRequest(
          `/v1.0/me/calendarView?startDateTime=${now}&endDateTime=${future}&$select=subject,start,end,location&$top=20`);
        if (r.data?.value) {
          msEvents = r.data.value.map(e => ({ id: e.id, title: e.subject, date: e.start?.dateTime?.slice(0, 10),
            time: e.start?.dateTime?.slice(11, 16), source: 'microsoft365', location: e.location?.displayName || '' }));
        }
      } catch {}
    }
    return [...events, ...msEvents];
  }

  async function deleteEvent(id) {
    let events = (await readEvents()) || [];
    const before = events.length;
    events = events.filter(e => e.id !== id);
    await writeEvents(events);
    auditLog.log('calendar_event_deleted', { eventId: id });
    return { success: events.length < before };
  }

  return { addEvent, importEvents, listEvents, deleteEvent, parseIcs };
}

module.exports = { createCalendarClient };
