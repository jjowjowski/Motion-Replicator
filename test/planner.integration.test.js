'use strict';

// Integration test for the planner against a real Postgres database with the
// Google API stubbed out. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/mr_test npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const TZ = 'Pacific/Auckland';
const at = (iso) => DateTime.fromISO(iso, { zone: TZ }).toMillis();

test('planner (integration)', { skip: !TEST_DB && 'TEST_DATABASE_URL not set' }, async (t) => {
  const db = require('../src/db');
  const google = require('../src/google');
  const { migrate } = require('../src/migrate');
  const { replan, removeFutureEventsForTask } = require('../src/scheduler/planner');

  await migrate({ log: () => {} });

  let busy = [];
  let nextEvent = 1;
  const calls = { inserted: [], deleted: [] };
  google.getCalendarClient = async () => ({ cal: {}, account: { tasks_calendar_id: 'tasks-cal' } });
  google.ensureTasksCalendar = async () => 'tasks-cal';
  google.getPrimaryBusy = async () => busy;
  google.insertEvent = async (cal, calendarId, body) => {
    calls.inserted.push({ calendarId, body });
    return { id: `ev${nextEvent++}` };
  };
  google.deleteEvent = async (cal, calendarId, eventId) => {
    calls.deleted.push({ calendarId, eventId });
  };

  async function reset() {
    await db.query('TRUNCATE scheduled_events, tasks, schedule_runs RESTART IDENTITY CASCADE');
    calls.inserted.length = 0;
    calls.deleted.length = 0;
    busy = [];
    nextEvent = 1;
  }

  async function addTask(title, priority, minutes, date, time = null) {
    const { rows } = await db.query(
      `INSERT INTO tasks (title, priority, duration_minutes, deadline_date, deadline_time)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, priority, minutes, date, time],
    );
    return rows[0].id;
  }

  t.after(() => db.close());

  await t.test('creates events in the Tasks calendar and records them', async () => {
    await reset();
    const a = await addTask('Write report', 'high', 60, '2026-10-27');
    const b = await addTask('Big project', 'low', 150, '2026-10-30');
    busy = [{ start: at('2026-10-26T09:00'), end: at('2026-10-26T10:00') }];

    const result = await replan({ trigger: 'manual', now: at('2026-10-26T08:00'), log: () => {} });
    assert.equal(result.eventsDeleted, 0);
    assert.ok(result.eventsCreated >= 2);
    assert.ok(calls.inserted.every((c) => c.calendarId === 'tasks-cal'));

    const first = calls.inserted[0].body;
    assert.equal(first.summary, 'Write report');
    assert.match(first.description, /Priority: High/);
    assert.match(first.description, /\/\?task=\d+/);
    assert.equal(first.start.timeZone, TZ);
    assert.equal(first.start.dateTime, '2026-10-26T10:10:00.000+13:00');

    const { rows } = await db.query('SELECT task_id FROM scheduled_events ORDER BY start_at');
    assert.equal(rows.length, result.eventsCreated);
    assert.deepEqual([...new Set(rows.map((r) => r.task_id))].sort(), [a, b].sort());

    const tasks = await db.query('SELECT id, schedule_status FROM tasks ORDER BY id');
    assert.deepEqual(tasks.rows.map((r) => r.schedule_status), ['scheduled', 'scheduled']);
  });

  await t.test('re-plan deletes only future app events and keeps the in-progress one', async () => {
    await reset();
    const id = await addTask('Deep work', 'medium', 120, '2026-10-30');
    await replan({ trigger: 'manual', now: at('2026-10-26T08:00'), log: () => {} });
    assert.deepEqual(
      calls.inserted.map((c) => [c.body.start.dateTime, c.body.end.dateTime]),
      [['2026-10-26T09:00:00.000+13:00', '2026-10-26T11:00:00.000+13:00']],
    );

    // A past event row must never be deleted.
    await db.query(
      `INSERT INTO scheduled_events (task_id, calendar_id, google_event_id, start_at, end_at)
       VALUES ($1, 'tasks-cal', 'past-ev', now() - interval '30 days', now() - interval '29 days')`,
      [id],
    );
    calls.inserted.length = 0;

    // Re-plan at 10:00, while the 9:00-11:00 block is in progress.
    const result = await replan({ trigger: 'manual', now: at('2026-10-26T10:00'), log: () => {} });
    assert.equal(result.eventsDeleted, 0, 'in-progress and past events are kept');
    assert.equal(result.eventsCreated, 0, 'in-progress block already covers the task');
    const task = await db.query('SELECT schedule_status, scheduled_minutes FROM tasks WHERE id = $1', [id]);
    assert.deepEqual(task.rows[0], { schedule_status: 'scheduled', scheduled_minutes: 120 });

    // Re-plan from the previous evening: the block is in the future, so it is replaced.
    const again = await replan({ trigger: 'manual', now: at('2026-10-25T20:00'), log: () => {} });
    assert.equal(again.eventsDeleted, 1);
    assert.equal(calls.deleted.length, 1);
    assert.equal(calls.deleted[0].calendarId, 'tasks-cal');
    assert.equal(calls.deleted[0].eventId, 'ev1');
  });

  await t.test('flags tasks that cannot fit before the deadline', async () => {
    await reset();
    const id = await addTask('Too big', 'high', 300, '2026-10-26', '12:00');
    await replan({ trigger: 'manual', now: at('2026-10-26T08:00'), log: () => {} });
    const { rows } = await db.query('SELECT schedule_status, schedule_warning FROM tasks WHERE id = $1', [id]);
    assert.equal(rows[0].schedule_status, 'at_risk');
    assert.match(rows[0].schedule_warning, /fit before the deadline/);
    const late = await db.query('SELECT count(*)::int AS n FROM scheduled_events WHERE is_late');
    assert.ok(late.rows[0].n > 0);
  });

  await t.test('removeFutureEventsForTask deletes that task’s future events only', async () => {
    await reset();
    const keep = await addTask('Keep', 'high', 30, '2026-12-01');
    const drop = await addTask('Drop', 'high', 30, '2026-12-01');
    // Plan relative to the real clock so these events are in the future.
    await replan({ trigger: 'manual', log: () => {} });
    calls.deleted.length = 0;
    const removed = await removeFutureEventsForTask(drop);
    assert.equal(removed, 1);
    const { rows } = await db.query('SELECT task_id FROM scheduled_events');
    assert.deepEqual(rows.map((r) => r.task_id), [keep]);
  });

  await t.test('concurrent runs are rejected', async () => {
    await reset();
    await addTask('A', 'high', 30, '2026-12-01');
    const results = await Promise.allSettled([
      replan({ trigger: 'manual', log: () => {} }),
      replan({ trigger: 'manual', log: () => {} }),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.ok(rejected.length <= 1);
    if (rejected.length) assert.equal(rejected[0].reason.name, 'PlannerBusyError');
  });
});
