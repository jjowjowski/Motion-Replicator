'use strict';

const express = require('express');
const db = require('../db');
const { removeFutureEventsForTask } = require('../scheduler/planner');

const router = express.Router();

const PRIORITIES = ['high', 'medium', 'low'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/** Validate a create/update payload. `partial` allows missing fields. */
function parseTaskInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('title')) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 300) throw badRequest('Title is required (max 300 characters)');
    out.title = title;
  }
  if (!partial || has('priority')) {
    if (!PRIORITIES.includes(body.priority)) throw badRequest('Priority must be high, medium or low');
    out.priority = body.priority;
  }
  if (!partial || has('duration_minutes')) {
    const n = Number(body.duration_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 6000) {
      throw badRequest('Duration must be a whole number of minutes between 5 and 6000');
    }
    out.duration_minutes = n;
  }
  if (!partial || has('deadline_date')) {
    if (typeof body.deadline_date !== 'string' || !validDate(body.deadline_date)) {
      throw badRequest('Deadline date is required (YYYY-MM-DD)');
    }
    out.deadline_date = body.deadline_date;
  }
  if (!partial || has('deadline_time')) {
    const t = body.deadline_time;
    if (t === null || t === undefined || t === '') out.deadline_time = null;
    else if (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) out.deadline_time = t;
    else throw badRequest('Deadline time must be HH:MM');
  }
  if (!partial || has('notes')) {
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (notes.length > 5000) throw badRequest('Notes are limited to 5000 characters');
    out.notes = notes || null;
  }
  return out;
}

function serializeTask(row, blocks = []) {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    duration_minutes: row.duration_minutes,
    deadline_date: row.deadline_date,
    deadline_time: row.deadline_time ? row.deadline_time.slice(0, 5) : null,
    notes: row.notes,
    status: row.status,
    completed_at: row.completed_at,
    schedule_status: row.schedule_status,
    scheduled_minutes: row.scheduled_minutes,
    schedule_warning: row.schedule_warning,
    created_at: row.created_at,
    updated_at: row.updated_at,
    blocks,
  };
}

async function blocksByTask(taskIds) {
  if (!taskIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT task_id, start_at, end_at, is_late, chunk_index, chunk_count
       FROM scheduled_events
      WHERE task_id = ANY($1::int[]) AND end_at > now()
      ORDER BY start_at`,
    [taskIds],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push({
      start: r.start_at,
      end: r.end_at,
      late: r.is_late,
      chunk_index: r.chunk_index,
      chunk_count: r.chunk_count,
    });
  }
  return map;
}

async function loadTask(id) {
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!rows[0]) {
    const err = new Error('Task not found');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

function parseId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid task id');
  return id;
}

// GET /api/tasks?status=open|done|all
router.get('/', async (req, res) => {
  const status = ['open', 'done', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const { rows } = await db.query(
    `SELECT * FROM tasks
      WHERE ($1 = 'all' OR status = $1)
      ORDER BY deadline_date, deadline_time NULLS LAST,
               CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               created_at`,
    [status],
  );
  const blocks = await blocksByTask(rows.map((r) => r.id));
  res.json({ tasks: rows.map((r) => serializeTask(r, blocks.get(r.id) || [])) });
});

router.get('/:id', async (req, res) => {
  const row = await loadTask(parseId(req));
  const blocks = await blocksByTask([row.id]);
  res.json({ task: serializeTask(row, blocks.get(row.id) || []) });
});

router.post('/', async (req, res) => {
  const input = parseTaskInput(req.body || {});
  const { rows } = await db.query(
    `INSERT INTO tasks (title, priority, duration_minutes, deadline_date, deadline_time, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.title, input.priority, input.duration_minutes, input.deadline_date, input.deadline_time, input.notes],
  );
  res.status(201).json({ task: serializeTask(rows[0]) });
});

router.patch('/:id', async (req, res) => {
  const id = parseId(req);
  await loadTask(id);
  const input = parseTaskInput(req.body || {}, { partial: true });
  const fields = Object.keys(input);
  if (!fields.length) throw badRequest('Nothing to update');
  const sets = fields.map((f, i) => `${f} = $${i + 2}`);
  const { rows } = await db.query(
    `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...fields.map((f) => input[f])],
  );
  const blocks = await blocksByTask([id]);
  res.json({ task: serializeTask(rows[0], blocks.get(id) || []) });
});

// Mark done: the task is never scheduled again and its future blocks are removed.
router.post('/:id/done', async (req, res) => {
  const id = parseId(req);
  await loadTask(id);
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now(),
            schedule_status = NULL, schedule_warning = NULL
      WHERE id = $1 RETURNING *`,
    [id],
  );
  const removedEvents = await removeFutureEventsForTask(id);
  res.json({ task: serializeTask(rows[0]), removed_events: removedEvents });
});

router.post('/:id/reopen', async (req, res) => {
  const id = parseId(req);
  await loadTask(id);
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  res.json({ task: serializeTask(rows[0]) });
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req);
  await loadTask(id);
  const removedEvents = await removeFutureEventsForTask(id);
  await db.query('DELETE FROM tasks WHERE id = $1', [id]);
  res.json({ ok: true, removed_events: removedEvents });
});

module.exports = router;
module.exports.parseTaskInput = parseTaskInput;
