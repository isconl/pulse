'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarClient } = require('../lib/calendar');

function makeEventStore(seed = []) {
  let events = seed.slice();
  return {
    get events() { return events; },
    readEvents: async () => events.slice(),
    writeEvents: async (e) => { events = e; },
  };
}

test('createCalendarClient throws without readEvents/writeEvents', () => {
  assert.throws(() => createCalendarClient({}));
});

test('addEvent stores a new local event and returns it with an id', async () => {
  const store = makeEventStore();
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const r = await client.addEvent({ title: 'Team sync', date: '2026-08-10' });
  assert.equal(r.success, true);
  assert.equal(r.event.title, 'Team sync');
  assert.equal(store.events.length, 1);
});

test('addEvent does not create a task when makeTask is unset or addTask is not injected', async () => {
  const store = makeEventStore();
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const r = await client.addEvent({ title: 'x', date: '2026-08-10', makeTask: true });
  assert.equal(r.task, null);
});

test('addEvent creates a linked task when makeTask is set and addTask is injected', async () => {
  const store = makeEventStore();
  const createdTasks = [];
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    addTask: async (t) => createdTasks.push(t),
    nextTaskId: async () => 'T101',
  });
  const r = await client.addEvent({ title: 'Launch', date: '2026-08-10', category: 'deadline', makeTask: true });
  assert.equal(r.task.ID, 'T101');
  assert.equal(r.task.PRIORITY, 'high');
  assert.equal(createdTasks.length, 1);
});

test('addEvent raises a notification when notify is injected', async () => {
  const store = makeEventStore();
  const raised = [];
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    notify: (n) => { raised.push(n); return true; },
  });
  await client.addEvent({ title: 'x', date: '2026-08-10' });
  assert.equal(raised[0].source, 'calendar');
});

test('parseIcs extracts title/date/time from a minimal VEVENT block', () => {
  const client = createCalendarClient({ readEvents: async () => [], writeEvents: async () => {} });
  const ics = 'BEGIN:VEVENT\nSUMMARY:Doctor appointment\nDTSTART:20260815T093000Z\nLOCATION:Clinic\nEND:VEVENT';
  const found = client.parseIcs(ics, 'test');
  assert.equal(found[0].title, 'Doctor appointment');
  assert.equal(found[0].date, '2026-08-15');
  assert.equal(found[0].time, '09:30');
});

test('parseIcs throws on text with no VEVENT block', () => {
  const client = createCalendarClient({ readEvents: async () => [], writeEvents: async () => {} });
  assert.throws(() => client.parseIcs('not an ics file', 'test'));
});

test('importEvents dedupes against existing events by title+date', async () => {
  const store = makeEventStore([{ title: 'Doctor appointment', date: '2026-08-15' }]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const ics = 'BEGIN:VEVENT\nSUMMARY:Doctor appointment\nDTSTART:20260815T093000Z\nEND:VEVENT';
  const r = await client.importEvents({ ics, label: 'test' });
  assert.equal(r.found, 1);
  assert.equal(r.added, 0);
});

test('importEvents throws for microsoft source with no graphRequest configured', async () => {
  const store = makeEventStore();
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  await assert.rejects(() => client.importEvents({ source: 'microsoft' }));
});

test('importEvents pulls from graphRequest for a microsoft source', async () => {
  const store = makeEventStore();
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    graphRequest: async () => ({ data: { value: [{ subject: 'Standup', start: { dateTime: '2026-08-10T09:00:00' } }] } }),
  });
  const r = await client.importEvents({ source: 'microsoft' });
  assert.equal(r.added, 1);
  assert.equal(store.events[0].title, 'Standup');
});

test('listEvents merges local events with a live microsoft calendarView when graphRequest is configured', async () => {
  const store = makeEventStore([{ id: '1', title: 'Local one', date: '2026-08-10' }]);
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    graphRequest: async () => ({ data: { value: [{ id: 'ms1', subject: 'MS event', start: { dateTime: '2026-08-11T10:00:00' } }] } }),
  });
  const events = await client.listEvents();
  assert.equal(events.length, 2);
  assert.equal(events[1].source, 'microsoft365');
});

test('listEvents swallows a graphRequest failure and returns local events only', async () => {
  const store = makeEventStore([{ id: '1', title: 'Local one', date: '2026-08-10' }]);
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    graphRequest: async () => { throw new Error('graph down'); },
  });
  const events = await client.listEvents();
  assert.equal(events.length, 1);
});

test('listEvents merges local events with googleCalendarFetch when configured', async () => {
  const store = makeEventStore([{ id: '1', title: 'Local one', date: '2026-08-10' }]);
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    googleCalendarFetch: async () => [{ id: 'g1', title: 'Google event', date: '2026-08-12', time: '09:00', source: 'google', location: '' }],
  });
  const events = await client.listEvents();
  assert.equal(events.length, 2);
  assert.equal(events[1].source, 'google');
});

test('listEvents merges local + microsoft + google all together when both are configured', async () => {
  const store = makeEventStore([{ id: '1', title: 'Local one', date: '2026-08-10' }]);
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    graphRequest: async () => ({ data: { value: [{ id: 'ms1', subject: 'MS event', start: { dateTime: '2026-08-11T10:00:00' } }] } }),
    googleCalendarFetch: async () => [{ id: 'g1', title: 'Google event', date: '2026-08-12', time: '09:00', source: 'google', location: '' }],
  });
  const events = await client.listEvents();
  assert.equal(events.length, 3);
});

test('listEvents swallows a googleCalendarFetch failure and returns local events only', async () => {
  const store = makeEventStore([{ id: '1', title: 'Local one', date: '2026-08-10' }]);
  const client = createCalendarClient({
    readEvents: store.readEvents, writeEvents: store.writeEvents,
    googleCalendarFetch: async () => { throw new Error('vault down'); },
  });
  const events = await client.listEvents();
  assert.equal(events.length, 1);
});

test('deleteEvent removes the matching event by id', async () => {
  const store = makeEventStore([{ id: '1', title: 'x' }, { id: '2', title: 'y' }]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const r = await client.deleteEvent('1');
  assert.equal(r.success, true);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].id, '2');
});

test('exportIcs produces a valid VCALENDAR wrapping one VEVENT per local event with a date', async () => {
  const store = makeEventStore([
    { id: '1', title: 'Team sync', date: '2026-08-25', time: '14:30', location: 'Zoom' },
    { id: '2', title: 'No date, skipped' },
  ]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const ics = await client.exportIcs();
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/);
  assert.match(ics, /END:VCALENDAR$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /SUMMARY:Team sync/);
  assert.match(ics, /DTSTART:20260825T143000/);
  assert.match(ics, /LOCATION:Zoom/);
});

test('exportIcs renders an all-day event (no time) with DTSTART;VALUE=DATE', async () => {
  const store = makeEventStore([{ id: '1', title: 'Deadline', date: '2026-09-01' }]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const ics = await client.exportIcs();
  assert.match(ics, /DTSTART;VALUE=DATE:20260901/);
});

test('exportIcs escapes RFC5545-significant characters in SUMMARY', async () => {
  const store = makeEventStore([{ id: '1', title: 'Comma, semicolon; back\\slash', date: '2026-09-01' }]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const ics = await client.exportIcs();
  assert.ok(ics.includes('SUMMARY:Comma\\, semicolon\\; back\\\\slash'));
});

test('exportIcs (BT26082004) turns scope/dates.tsv RECURS:yearly rows into RRULE:FREQ=YEARLY VEVENTs', async () => {
  const store = makeEventStore();
  const readDates = async () => [
    { ID: 'D001', TITLE: "Alex's birthday", DATE: '1985-03-14', KIND: 'birthday', RECURS: 'yearly' },
    { ID: 'D002', TITLE: 'One-time thing', DATE: '2026-05-05', KIND: 'anniversary', RECURS: '-' },
  ];
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents, readDates });
  const ics = await client.exportIcs();
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1, 'only the yearly-recurring row is exported');
  assert.match(ics, /SUMMARY:Alex's birthday/);
  assert.match(ics, /RRULE:FREQ=YEARLY/);
  assert.doesNotMatch(ics, /One-time thing/);
});

test('exportIcs never includes a computed age -- SUMMARY is the dates.tsv TITLE verbatim, matching BM26082001\'s privacy gating', async () => {
  const store = makeEventStore();
  const readDates = async () => [{ ID: 'D001', TITLE: "Someone's birthday", DATE: '1985-03-14', KIND: 'birthday', RECURS: 'yearly', PERSON_ID: 'someone-else' }];
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents, readDates });
  const ics = await client.exportIcs();
  assert.doesNotMatch(ics, /turns \d/i);
});

test('exportIcs works local-events-only when readDates is not injected', async () => {
  const store = makeEventStore([{ id: '1', title: 'x', date: '2026-09-01' }]);
  const client = createCalendarClient({ readEvents: store.readEvents, writeEvents: store.writeEvents });
  const ics = await client.exportIcs();
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});
