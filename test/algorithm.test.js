'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
  mergeIntervals,
  subtractIntervals,
  buildWorkingWindows,
  planningHorizon,
  deadlineMillis,
  compareTasks,
  planSchedule,
} = require('../src/scheduler/algorithm');
const { DEFAULT_WORKING_HOURS } = require('../src/config');

const TZ = 'Pacific/Auckland';
// Monday 26 Oct 2026 (NZDT, UTC+13).
const at = (iso) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const fmt = (ms) => DateTime.fromMillis(ms, { zone: TZ }).toFormat("ccc yyyy-LL-dd HH:mm");
const span = (b) => `${fmt(b.start)}-${DateTime.fromMillis(b.end, { zone: TZ }).toFormat('HH:mm')}`;

let nextId = 1;
function task(overrides = {}) {
  const id = overrides.id ?? nextId++;
  return {
    id,
    title: `Task ${id}`,
    priority: 'medium',
    durationMinutes: 60,
    deadline: at('2026-10-30T17:30'),
    createdAt: at('2026-10-01T00:00') + id,
    ...overrides,
  };
}

function plan(overrides = {}) {
  const now = overrides.now ?? at('2026-10-26T08:00');
  const { end } = planningHorizon({ now, timeZone: TZ, planningDays: overrides.planningDays ?? 7 });
  return planSchedule({
    busy: [],
    now,
    horizonEnd: end,
    timeZone: TZ,
    workingHours: DEFAULT_WORKING_HOURS,
    bufferMinutes: 10,
    splitThresholdMinutes: 90,
    minChunkMinutes: 30,
    granularityMinutes: 5,
    scheduleLateTasks: true,
    ...overrides,
  });
}

const blocksFor = (result, id) => result.blocks.filter((b) => b.taskId === id);

test('mergeIntervals merges overlapping and touching intervals', () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 5, end: 7 },
      { start: 1, end: 3 },
      { start: 3, end: 4 },
      { start: 6, end: 10 },
      { start: 12, end: 12 },
    ]),
    [
      { start: 1, end: 4 },
      { start: 5, end: 10 },
    ],
  );
});

test('subtractIntervals removes blocked time from windows', () => {
  const free = subtractIntervals(
    [{ start: 0, end: 100 }],
    [
      { start: 10, end: 20 },
      { start: 15, end: 30 },
      { start: 90, end: 120 },
    ],
  );
  assert.deepEqual(free, [
    { start: 0, end: 10 },
    { start: 30, end: 90 },
  ]);
});

test('working windows: Mon-Fri 9:00-17:30, Sat 10:00-14:00, Sun off', () => {
  const from = at('2026-10-26T00:00');
  const to = at('2026-11-02T00:00');
  const windows = buildWorkingWindows({ from, to, timeZone: TZ, workingHours: DEFAULT_WORKING_HOURS });
  assert.deepEqual(windows.map(span), [
    'Mon 2026-10-26 09:00-17:30',
    'Tue 2026-10-27 09:00-17:30',
    'Wed 2026-10-28 09:00-17:30',
    'Thu 2026-10-29 09:00-17:30',
    'Fri 2026-10-30 09:00-17:30',
    'Sat 2026-10-31 10:00-14:00',
  ]);
});

test('working windows are correct across the NZ DST change (April)', () => {
  // NZDT ends Sunday 5 April 2026 at 03:00 -> 02:00 (UTC+13 -> UTC+12).
  const windows = buildWorkingWindows({
    from: at('2026-04-03T00:00'),
    to: at('2026-04-07T00:00'),
    timeZone: TZ,
    workingHours: DEFAULT_WORKING_HOURS,
  });
  assert.deepEqual(windows.map(span), [
    'Fri 2026-04-03 09:00-17:30',
    'Sat 2026-04-04 10:00-14:00',
    'Mon 2026-04-06 09:00-17:30',
  ]);
  // Monday 9:00 NZST is 21:00 UTC on Sunday.
  assert.equal(new Date(windows[2].start).toISOString(), '2026-04-05T21:00:00.000Z');
});

test('planning horizon covers today plus the next 6 days', () => {
  const { end } = planningHorizon({ now: at('2026-10-26T14:23'), timeZone: TZ, planningDays: 7 });
  assert.equal(fmt(end), 'Mon 2026-11-02 00:00');
});

test('deadline without a time means end of that day', () => {
  assert.equal(fmt(deadlineMillis('2026-10-28', null, TZ)), 'Thu 2026-10-29 00:00');
  assert.equal(fmt(deadlineMillis('2026-10-28', '13:15', TZ)), 'Wed 2026-10-28 13:15');
});

test('orders by deadline, then priority, then creation date', () => {
  const tasks = [
    task({ id: 'a', deadline: at('2026-10-29T12:00'), priority: 'low', createdAt: 1 }),
    task({ id: 'b', deadline: at('2026-10-28T12:00'), priority: 'low', createdAt: 2 }),
    task({ id: 'c', deadline: at('2026-10-29T12:00'), priority: 'high', createdAt: 3 }),
    task({ id: 'd', deadline: at('2026-10-29T12:00'), priority: 'low', createdAt: 0 }),
  ];
  assert.deepEqual(
    [...tasks].sort(compareTasks).map((t) => t.id),
    ['b', 'c', 'd', 'a'],
  );
});

test('places tasks greedily from the start of the working day with a buffer between blocks', () => {
  const t1 = task({ durationMinutes: 60, priority: 'high' });
  const t2 = task({ durationMinutes: 45 });
  const result = plan({ tasks: [t1, t2] });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 09:00-10:00']);
  assert.deepEqual(blocksFor(result, t2.id).map(span), ['Mon 2026-10-26 10:10-10:55']);
  assert.equal(result.results.get(t1.id).status, 'scheduled');
  assert.equal(result.results.get(t2.id).status, 'scheduled');
});

test('respects busy time from the primary calendar plus buffer on both sides', () => {
  const t1 = task({ durationMinutes: 60 });
  const busy = [{ start: at('2026-10-26T09:30'), end: at('2026-10-26T10:00') }];
  const result = plan({ tasks: [t1], busy });
  // 9:00-9:20 is too short for a 60-minute unsplittable task; next start is 10:00 + 10 min.
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 10:10-11:10']);
});

test('rounds block starts up to the granularity after odd busy end times', () => {
  const t1 = task({ durationMinutes: 30 });
  const busy = [{ start: at('2026-10-26T08:30'), end: at('2026-10-26T09:07') }];
  const result = plan({ tasks: [t1], busy });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 09:20-09:50']);
});

test('starts from "now" when re-planning mid-day', () => {
  const t1 = task({ durationMinutes: 30 });
  const result = plan({ tasks: [t1], now: at('2026-10-26T13:02') });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 13:05-13:35']);
});

test('tasks of 90 minutes or less are never split', () => {
  const t1 = task({ durationMinutes: 90 });
  // Free gaps on Monday: 9:00-9:50 and 10:30-17:30 (with buffers). Two 50-minute
  // gaps would fit it split, but it must go in one piece.
  const busy = [{ start: at('2026-10-26T10:00'), end: at('2026-10-26T10:20') }];
  const result = plan({ tasks: [t1], busy });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 10:30-12:00']);
});

test('tasks over 90 minutes are split into chunks of at least 30 minutes', () => {
  const t1 = task({ durationMinutes: 150 });
  const busy = [
    { start: at('2026-10-26T10:10'), end: at('2026-10-26T11:00') }, // gap 9:00-10:00 (60)
    { start: at('2026-10-26T11:30'), end: at('2026-10-26T17:30') }, // gap 11:10-11:20 (10, too small)
  ];
  const result = plan({ tasks: [t1], busy });
  const blocks = blocksFor(result, t1.id);
  assert.deepEqual(blocks.map(span), ['Mon 2026-10-26 09:00-10:00', 'Tue 2026-10-27 09:00-10:30']);
  assert.deepEqual(blocks.map((b) => [b.chunkIndex, b.chunkCount]), [[1, 2], [2, 2]]);
  for (const b of blocks) assert.ok(b.end - b.start >= 30 * 60000);
  assert.equal(result.results.get(t1.id).status, 'scheduled');
});

test('splitting never leaves a remainder shorter than the minimum chunk', () => {
  const t1 = task({ durationMinutes: 100 });
  // Gap 9:00-10:20 is 80 minutes; taking all 80 would leave 20 (< 30), so it takes 70.
  const busy = [{ start: at('2026-10-26T10:30'), end: at('2026-10-26T17:30') }];
  const result = plan({ tasks: [t1], busy });
  assert.deepEqual(blocksFor(result, t1.id).map(span), [
    'Mon 2026-10-26 09:00-10:10',
    'Tue 2026-10-27 09:00-09:30',
  ]);
});

test('splittable task skips gaps shorter than the minimum chunk', () => {
  const t1 = task({ durationMinutes: 120 });
  const busy = [
    { start: at('2026-10-26T09:25'), end: at('2026-10-26T17:30') }, // only 9:00-9:15 free
  ];
  const result = plan({ tasks: [t1], busy });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Tue 2026-10-27 09:00-11:00']);
});

test('flags a task that cannot fit before its deadline (at risk)', () => {
  const t1 = task({ durationMinutes: 60, deadline: at('2026-10-26T12:00') });
  const busy = [{ start: at('2026-10-26T09:00'), end: at('2026-10-26T11:30') }];
  const result = plan({ tasks: [t1], busy, scheduleLateTasks: false });
  const r = result.results.get(t1.id);
  assert.equal(r.status, 'at_risk');
  assert.equal(r.scheduledMinutes, 0);
  assert.match(r.warning, /Only 0 of 60 min fit before the deadline/);
  assert.equal(blocksFor(result, t1.id).length, 0);
});

test('late leftovers are placed after on-time tasks and never steal their slots', () => {
  // A 3h task due Monday 10:00 cannot make it (only 9:00-10:00 is available).
  // A 7h task due Monday 17:30 fits in 10:10-17:10 only if the late remainder
  // of the first task does not take Monday's time.
  const urgent = task({ id: 'urgent', durationMinutes: 180, deadline: at('2026-10-26T10:00'), priority: 'high' });
  const onTime = task({ id: 'ontime', durationMinutes: 420, deadline: at('2026-10-26T17:30') });
  const result = plan({ tasks: [urgent, onTime] });

  assert.deepEqual(blocksFor(result, 'ontime').map(span), ['Mon 2026-10-26 10:10-17:10']);
  assert.equal(result.results.get('ontime').status, 'scheduled');

  const urgentResult = result.results.get('urgent');
  assert.equal(urgentResult.status, 'at_risk');
  assert.equal(urgentResult.onTimeMinutes, 60);
  assert.equal(urgentResult.lateMinutes, 120);
  assert.equal(urgentResult.remainingMinutes, 0);
  assert.match(urgentResult.warning, /Only 60 of 180 min fit before the deadline/);
  assert.match(urgentResult.warning, /120 min scheduled after the deadline/);
  assert.deepEqual(
    blocksFor(result, 'urgent').map((b) => [span(b), b.late]),
    [
      ['Mon 2026-10-26 09:00-10:00', false],
      ['Tue 2026-10-27 09:00-11:00', true],
    ],
  );
});

test('overdue tasks are flagged and still scheduled as late work', () => {
  const t1 = task({ durationMinutes: 30, deadline: at('2026-10-25T17:00') });
  const result = plan({ tasks: [t1] });
  const r = result.results.get(t1.id);
  assert.equal(r.status, 'overdue');
  assert.match(r.warning, /Deadline passed/);
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 09:00-09:30']);
  assert.equal(blocksFor(result, t1.id)[0].late, true);
});

test('deadline beyond the planning window is "partial", not a warning', () => {
  const t1 = task({ durationMinutes: 600, deadline: at('2026-11-20T17:00') });
  // Busy all week except Monday 9:00-11:00.
  const busy = [
    { start: at('2026-10-26T11:10'), end: at('2026-11-02T00:00') },
  ];
  const result = plan({ tasks: [t1], busy });
  const r = result.results.get(t1.id);
  assert.equal(r.status, 'partial');
  assert.equal(r.scheduledMinutes, 120);
  assert.equal(r.warning, null);
  assert.match(r.info, /120 of 600 min planned this week/);
});

test('committed minutes from an in-progress block reduce what still needs placing', () => {
  const t1 = task({ durationMinutes: 120, committedMinutes: 60 });
  const result = plan({ tasks: [t1] });
  assert.deepEqual(blocksFor(result, t1.id).map(span), ['Mon 2026-10-26 09:00-10:00']);
  assert.equal(result.results.get(t1.id).scheduledMinutes, 120);
  assert.equal(result.results.get(t1.id).status, 'scheduled');
});

test('nothing is placed on Sunday or outside working hours', () => {
  const tasks = Array.from({ length: 20 }, () => task({ durationMinutes: 90, deadline: at('2026-11-30T17:00') }));
  const result = plan({ tasks });
  for (const b of result.blocks) {
    const s = DateTime.fromMillis(b.start, { zone: TZ });
    const e = DateTime.fromMillis(b.end, { zone: TZ });
    assert.notEqual(s.weekday, 7, `block on Sunday: ${span(b)}`);
    const [open, close] = s.weekday === 6 ? ['10:00', '14:00'] : ['09:00', '17:30'];
    assert.ok(s.toFormat('HH:mm') >= open && e.toFormat('HH:mm') <= close, `outside hours: ${span(b)}`);
  }
  // Blocks never overlap and are at least 10 minutes apart.
  for (let i = 1; i < result.blocks.length; i++) {
    assert.ok(result.blocks[i].start - result.blocks[i - 1].end >= 10 * 60000);
  }
});
