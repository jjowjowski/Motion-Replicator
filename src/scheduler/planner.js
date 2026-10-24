'use strict';

// Orchestrates a planning run: read tasks + calendar busy time, run the pure
// algorithm, then replace the app's future events in the Tasks calendar.

const { DateTime } = require('luxon');
const { config } = require('../config');
const db = require('../db');
const google = require('../google');
const { planSchedule, planningHorizon, deadlineMillis, MINUTE } = require('./algorithm');

const PLANNER_LOCK_KEY = 727002;
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
// Google Calendar event colours: 11 Tomato, 5 Banana, 2 Sage.
const PRIORITY_COLOR = { high: '11', medium: '5', low: '2' };

class PlannerBusyError extends Error {
  constructor() {
    super('A planning run is already in progress');
    this.name = 'PlannerBusyError';
    this.status = 409;
  }
}

function toPlannerTask(row, committedMinutes) {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    durationMinutes: row.duration_minutes,
    deadline: deadlineMillis(row.deadline_date, row.deadline_time, config.schedule.timeZone),
    createdAt: new Date(row.created_at).getTime(),
    committedMinutes,
  };
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

function buildEventBody(block, row) {
  const tz = config.schedule.timeZone;
  const link = `${config.baseUrl}/?task=${row.id}`;
  const deadline = DateTime.fromMillis(
    deadlineMillis(row.deadline_date, row.deadline_time, tz),
    { zone: tz },
  ).toFormat('ccc d LLL yyyy, h:mm a');
  const part = block.chunkCount > 1 ? ` (${block.chunkIndex}/${block.chunkCount})` : '';

  const lines = [
    `Priority: ${PRIORITY_LABEL[row.priority]}`,
    `Estimated duration: ${formatDuration(row.duration_minutes)}${
      block.chunkCount > 1 ? ` — part ${block.chunkIndex} of ${block.chunkCount}` : ''
    }`,
    `Deadline: ${deadline}`,
  ];
  if (block.late) lines.push('⚠️ Scheduled after the deadline — not enough free time before it.');
  if (row.notes) lines.push('', row.notes);
  lines.push('', `Open in Motion Replicator: ${link}`);

  return {
    summary: `${row.title}${part}`,
    description: lines.join('\n'),
    start: { dateTime: DateTime.fromMillis(block.start, { zone: tz }).toISO(), timeZone: tz },
    end: { dateTime: DateTime.fromMillis(block.end, { zone: tz }).toISO(), timeZone: tz },
    colorId: PRIORITY_COLOR[row.priority],
    transparency: 'opaque',
    source: { title: 'Motion Replicator', url: link },
    extendedProperties: { private: { motionReplicator: '1', taskId: String(row.id) } },
  };
}

/** Run `fn` while holding the planner advisory lock, or throw PlannerBusyError. */
async function withPlannerLock(fn) {
  return db.withClient(async (client) => {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [PLANNER_LOCK_KEY]);
    if (!rows[0].ok) throw new PlannerBusyError();
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [PLANNER_LOCK_KEY]);
    }
  });
}

/**
 * Re-plan everything from now to the end of the planning window.
 * @param {{ trigger: 'cron'|'manual', now?: number, log?: Function }} opts
 */
async function replan({ trigger, now = Date.now(), log = console.log }) {
  return withPlannerLock(async () => {
    const run = await db.query(`INSERT INTO schedule_runs (trigger) VALUES ($1) RETURNING id`, [trigger]);
    const runId = run.rows[0].id;
    try {
      const summary = await doReplan({ now, log });
      await db.query(
        `UPDATE schedule_runs SET status = 'ok', finished_at = now(),
           events_created = $2, events_deleted = $3, warnings = $4 WHERE id = $1`,
        [runId, summary.eventsCreated, summary.eventsDeleted, summary.warnings],
      );
      return { runId, ...summary };
    } catch (err) {
      await db.query(
        `UPDATE schedule_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`,
        [runId, String(err.message || err).slice(0, 2000)],
      );
      throw err;
    }
  });
}

async function doReplan({ now, log }) {
  const s = config.schedule;
  const { cal, account } = await google.getCalendarClient();
  const calendarId = await google.ensureTasksCalendar(cal, account);
  const horizon = planningHorizon({ now, timeZone: s.timeZone, planningDays: s.planningDays });

  const { rows: taskRows } = await db.query(`SELECT * FROM tasks WHERE status = 'open'`);
  const tasksById = new Map(taskRows.map((t) => [t.id, t]));

  // App events that have not finished yet. Future ones get replaced; one that
  // is in progress right now is kept and treated as busy time.
  const { rows: appEvents } = await db.query(
    `SELECT * FROM scheduled_events WHERE end_at > to_timestamp($1 / 1000.0) ORDER BY start_at`,
    [now],
  );
  const inProgress = appEvents.filter((e) => new Date(e.start_at).getTime() <= now);
  const future = appEvents.filter((e) => new Date(e.start_at).getTime() > now);

  const committed = new Map();
  for (const e of inProgress) {
    if (!tasksById.has(e.task_id)) continue;
    const minutes = Math.round((new Date(e.end_at) - new Date(e.start_at)) / MINUTE);
    committed.set(e.task_id, (committed.get(e.task_id) || 0) + minutes);
  }

  // Compute the new plan *before* touching the calendar so a Google error
  // here leaves the existing schedule intact.
  const busy = await google.getPrimaryBusy(cal, now, horizon.end);
  for (const e of inProgress) {
    busy.push({ start: new Date(e.start_at).getTime(), end: new Date(e.end_at).getTime() });
  }

  const { blocks, results } = planSchedule({
    tasks: taskRows.map((row) => toPlannerTask(row, committed.get(row.id) || 0)),
    busy,
    now,
    horizonEnd: horizon.end,
    timeZone: s.timeZone,
    workingHours: s.workingHours,
    bufferMinutes: s.bufferMinutes,
    splitThresholdMinutes: s.splitThresholdMinutes,
    minChunkMinutes: s.minChunkMinutes,
    granularityMinutes: s.granularityMinutes,
    scheduleLateTasks: s.scheduleLateTasks,
  });

  // Delete only future events this app created (tracked in our DB).
  let eventsDeleted = 0;
  for (const e of future) {
    await google.deleteEvent(cal, e.calendar_id, e.google_event_id);
    await db.query('DELETE FROM scheduled_events WHERE id = $1', [e.id]);
    eventsDeleted++;
  }

  let eventsCreated = 0;
  for (const block of blocks) {
    const row = tasksById.get(block.taskId);
    const event = await google.insertEvent(cal, calendarId, buildEventBody(block, row));
    await db.query(
      `INSERT INTO scheduled_events
         (task_id, calendar_id, google_event_id, start_at, end_at, chunk_index, chunk_count, is_late)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, $7, $8)`,
      [row.id, calendarId, event.id, block.start, block.end, block.chunkIndex, block.chunkCount, block.late],
    );
    eventsCreated++;
  }

  let warnings = 0;
  for (const [taskId, r] of results) {
    if (r.warning) warnings++;
    await db.query(
      `UPDATE tasks SET schedule_status = $2, scheduled_minutes = $3, schedule_warning = $4 WHERE id = $1`,
      [taskId, r.status, r.scheduledMinutes, r.warning || r.info],
    );
  }

  log(`Planned ${taskRows.length} tasks: ${eventsCreated} events created, ${eventsDeleted} deleted, ${warnings} warnings`);
  return { tasks: taskRows.length, eventsCreated, eventsDeleted, warnings };
}

/**
 * Remove a task's future events (used when a task is completed or deleted).
 * Best effort: if Google is unreachable the rows stay and the next run cleans up.
 */
async function removeFutureEventsForTask(taskId, now = Date.now()) {
  const { rows } = await db.query(
    `SELECT * FROM scheduled_events WHERE task_id = $1 AND start_at > to_timestamp($2 / 1000.0)`,
    [taskId, now],
  );
  if (!rows.length) return 0;
  let cal;
  try {
    ({ cal } = await google.getCalendarClient());
  } catch (err) {
    console.warn(`Could not remove events for task ${taskId}: ${err.message}`);
    return 0;
  }
  let removed = 0;
  for (const e of rows) {
    try {
      await google.deleteEvent(cal, e.calendar_id, e.google_event_id);
      await db.query('DELETE FROM scheduled_events WHERE id = $1', [e.id]);
      removed++;
    } catch (err) {
      console.warn(`Could not delete event ${e.google_event_id}: ${err.message}`);
    }
  }
  return removed;
}

module.exports = { replan, removeFutureEventsForTask, buildEventBody, PlannerBusyError };
