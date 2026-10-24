'use strict';

// Pure slot-filling algorithm. No I/O: everything it needs is passed in, which
// keeps it fully unit-testable (see test/algorithm.test.js).
//
// All instants are epoch milliseconds. Wall-clock values (working hours,
// deadlines) are interpreted in the configured IANA time zone, so DST changes
// are handled by Luxon.

const { DateTime } = require('luxon');

const MINUTE = 60 * 1000;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 };
}

function ceilTo(ms, granularityMinutes) {
  const step = granularityMinutes * MINUTE;
  return Math.ceil(ms / step) * step;
}

/** Sort and merge overlapping or touching intervals. */
function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** Remove `blocked` intervals from `windows`. Returns sorted free intervals. */
function subtractIntervals(windows, blocked) {
  const merged = mergeIntervals(blocked);
  const free = [];
  for (const w of mergeIntervals(windows)) {
    let cursor = w.start;
    for (const b of merged) {
      if (b.end <= cursor) continue;
      if (b.start >= w.end) break;
      if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, w.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) free.push({ start: cursor, end: w.end });
  }
  return free;
}

/**
 * Working-hour windows between `from` and `to` (ms).
 * workingHours: { 1..7 (ISO weekday, 1 = Monday): [["09:00","17:30"], ...] }
 */
function buildWorkingWindows({ from, to, timeZone, workingHours }) {
  const windows = [];
  let day = DateTime.fromMillis(from, { zone: timeZone }).startOf('day');
  const last = DateTime.fromMillis(to, { zone: timeZone });
  while (day < last) {
    for (const [startHM, endHM] of workingHours[day.weekday] || []) {
      const start = day.set(parseHM(startHM)).toMillis();
      const end = day.set(parseHM(endHM)).toMillis();
      const s = Math.max(start, from);
      const e = Math.min(end, to);
      if (e > s) windows.push({ start: s, end: e });
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  return windows;
}

/** Planning horizon: from `now` to the end of day (planningDays - 1) after today. */
function planningHorizon({ now, timeZone, planningDays }) {
  const end = DateTime.fromMillis(now, { zone: timeZone })
    .startOf('day')
    .plus({ days: planningDays })
    .toMillis();
  return { start: now, end };
}

/**
 * Deadline instant for a local date ('YYYY-MM-DD') and optional time ('HH:MM').
 * A date without a time means "by the end of that day".
 */
function deadlineMillis(deadlineDate, deadlineTime, timeZone) {
  const day = DateTime.fromISO(deadlineDate, { zone: timeZone });
  if (!day.isValid) throw new Error(`Invalid deadline date "${deadlineDate}"`);
  if (deadlineTime) return day.set(parseHM(deadlineTime)).toMillis();
  return day.plus({ days: 1 }).startOf('day').toMillis();
}

/** Deadline asc, then priority (high first), then creation time, then id. */
function compareTasks(a, b) {
  return (
    a.deadline - b.deadline ||
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    a.createdAt - b.createdAt ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
  );
}

function formatLocal(ms, timeZone) {
  return DateTime.fromMillis(ms, { zone: timeZone }).toFormat('ccc d LLL, h:mm a');
}

/**
 * Plan tasks into free time.
 *
 * @param {object}   p
 * @param {Array}    p.tasks  [{ id, title, priority: 'high'|'medium'|'low',
 *                              durationMinutes, deadline (ms), createdAt (ms),
 *                              committedMinutes? (already covered by a kept block) }]
 * @param {Array}    p.busy   [{ start, end }] busy time (ms) from the primary calendar
 * @param {number}   p.now    current instant (ms)
 * @param {number}   p.horizonEnd  end of planning horizon (ms)
 * @param {string}   p.timeZone
 * @param {object}   p.workingHours
 * @param {number}   p.bufferMinutes
 * @param {number}   p.splitThresholdMinutes  tasks longer than this may be split
 * @param {number}   p.minChunkMinutes
 * @param {number}   p.granularityMinutes     block starts are rounded up to this
 * @param {boolean}  p.scheduleLateTasks      place leftovers after the deadline
 * @returns {{ blocks: Array, results: Map }}
 */
function planSchedule(p) {
  const {
    tasks,
    busy = [],
    now,
    horizonEnd,
    timeZone,
    workingHours,
    bufferMinutes = 10,
    splitThresholdMinutes = 90,
    minChunkMinutes = 30,
    granularityMinutes = 5,
    scheduleLateTasks = true,
  } = p;

  const buffer = bufferMinutes * MINUTE;
  const start = ceilTo(now, granularityMinutes);
  const windows = buildWorkingWindows({ from: start, to: horizonEnd, timeZone, workingHours });

  // Busy time and placed blocks are padded by the buffer on both sides, so any
  // two adjacent items end up exactly `bufferMinutes` apart.
  const occupied = busy.map((b) => ({ start: b.start - buffer, end: b.end + buffer }));
  const blocks = [];

  function freeSlots(limitEnd) {
    return subtractIntervals(windows, occupied)
      .map((s) => ({ start: ceilTo(s.start, granularityMinutes), end: Math.min(s.end, limitEnd) }))
      .filter((s) => s.end > s.start);
  }

  function addBlock(task, blockStart, minutes, late) {
    const blockEnd = blockStart + minutes * MINUTE;
    blocks.push({ taskId: task.id, start: blockStart, end: blockEnd, late });
    occupied.push({ start: blockStart - buffer, end: blockEnd + buffer });
  }

  // Places up to `need` minutes of `task` before `limitEnd`. Returns minutes placed.
  function place(task, need, limitEnd, late) {
    const splittable = task.durationMinutes > splitThresholdMinutes;
    let remaining = need;
    while (remaining > 0) {
      let placedThisRound = false;
      for (const slot of freeSlots(limitEnd)) {
        const slotMinutes = Math.floor((slot.end - slot.start) / MINUTE);
        if (!splittable) {
          if (slotMinutes >= remaining) {
            addBlock(task, slot.start, remaining, late);
            remaining = 0;
            placedThisRound = true;
          }
        } else {
          let chunk;
          if (slotMinutes >= remaining) {
            chunk = remaining;
          } else {
            chunk = slotMinutes - (slotMinutes % granularityMinutes);
            // Never leave a remainder smaller than the minimum chunk size.
            if (remaining - chunk < minChunkMinutes) chunk = remaining - minChunkMinutes;
            if (chunk < minChunkMinutes) chunk = 0;
          }
          if (chunk > 0) {
            addBlock(task, slot.start, chunk, late);
            remaining -= chunk;
            placedThisRound = true;
          }
        }
        if (placedThisRound) break; // occupancy changed: recompute free slots
      }
      if (!placedThisRound) break;
    }
    return need - remaining;
  }

  const sorted = [...tasks].sort(compareTasks);
  const results = new Map();

  // Pass 1: everything in priority order, only before each task's deadline.
  for (const task of sorted) {
    const committed = Math.max(0, task.committedMinutes || 0);
    const need = Math.max(0, task.durationMinutes - committed);
    const limit = Math.min(task.deadline, horizonEnd);
    const placed = need > 0 && task.deadline > start ? place(task, need, limit, false) : 0;
    const remaining = need - placed;

    let status;
    if (remaining === 0) status = 'scheduled';
    else if (task.deadline <= now) status = 'overdue';
    else if (task.deadline > horizonEnd) status = 'partial';
    else status = 'at_risk';

    results.set(task.id, {
      taskId: task.id,
      status,
      scheduledMinutes: committed + placed,
      onTimeMinutes: committed + placed,
      lateMinutes: 0,
      remainingMinutes: remaining,
      warning: null,
      info: null,
    });
  }

  // Pass 2: leftovers of tasks that miss their deadline go into whatever time
  // is still free, so they never push out tasks that can still be on time.
  if (scheduleLateTasks) {
    for (const task of sorted) {
      const r = results.get(task.id);
      if ((r.status === 'at_risk' || r.status === 'overdue') && r.remainingMinutes > 0) {
        const late = place(task, r.remainingMinutes, horizonEnd, true);
        r.lateMinutes = late;
        r.scheduledMinutes += late;
        r.remainingMinutes -= late;
      }
    }
  }

  for (const task of sorted) {
    const r = results.get(task.id);
    const due = formatLocal(task.deadline, timeZone);
    const lateNote =
      r.lateMinutes > 0
        ? ` ${r.lateMinutes} min scheduled after the deadline.`
        : r.remainingMinutes > 0
          ? ' No free time left in the planning window.'
          : '';
    if (r.status === 'overdue') {
      r.warning = `Deadline passed (${due}).${lateNote}`;
    } else if (r.status === 'at_risk') {
      r.warning = `Only ${r.onTimeMinutes} of ${task.durationMinutes} min fit before the deadline (${due}).${lateNote}`;
    } else if (r.status === 'partial') {
      r.info = `${r.scheduledMinutes} of ${task.durationMinutes} min planned this week; the rest will be planned on a later run.`;
    }
  }

  // Number the chunks of each task.
  blocks.sort((a, b) => a.start - b.start);
  const byTask = new Map();
  for (const b of blocks) {
    if (!byTask.has(b.taskId)) byTask.set(b.taskId, []);
    byTask.get(b.taskId).push(b);
  }
  for (const list of byTask.values()) {
    list.forEach((b, i) => {
      b.chunkIndex = i + 1;
      b.chunkCount = list.length;
    });
  }

  return { blocks, results };
}

module.exports = {
  MINUTE,
  PRIORITY_RANK,
  ceilTo,
  mergeIntervals,
  subtractIntervals,
  buildWorkingWindows,
  planningHorizon,
  deadlineMillis,
  compareTasks,
  planSchedule,
};
