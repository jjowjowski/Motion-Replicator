'use strict';

const express = require('express');
const db = require('../db');
const google = require('../google');
const { config } = require('../config');
const { replan } = require('../scheduler/planner');

const router = express.Router();

async function googleStatus() {
  const account = await google.getAccount();
  return {
    configured: Boolean(config.google.clientId && config.google.clientSecret),
    connected: Boolean(account) && !account.needs_reauth,
    needs_reauth: Boolean(account && account.needs_reauth),
    email: account ? account.email : null,
    calendar_name: config.google.tasksCalendarName,
    has_tasks_calendar: Boolean(account && account.tasks_calendar_id),
  };
}

// GET /api/schedule — upcoming blocks, last run, connection state, staleness.
router.get('/', async (req, res) => {
  const [{ rows: blocks }, { rows: runs }, status] = await Promise.all([
    db.query(
      `SELECT e.task_id, e.start_at, e.end_at, e.is_late, e.chunk_index, e.chunk_count,
              t.title, t.priority
         FROM scheduled_events e
         LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.end_at > now()
        ORDER BY e.start_at`,
    ),
    db.query(`SELECT * FROM schedule_runs ORDER BY started_at DESC LIMIT 1`),
    googleStatus(),
  ]);

  const lastOk = await db.query(
    `SELECT started_at FROM schedule_runs WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1`,
  );
  let stale = false;
  if (lastOk.rows[0]) {
    const { rows } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM tasks WHERE updated_at > $1 OR created_at > $1) AS stale`,
      [lastOk.rows[0].started_at],
    );
    stale = rows[0].stale;
  } else {
    const { rows } = await db.query(`SELECT EXISTS (SELECT 1 FROM tasks WHERE status = 'open') AS stale`);
    stale = rows[0].stale;
  }

  res.json({
    time_zone: config.schedule.timeZone,
    google: status,
    last_run: runs[0] || null,
    stale,
    blocks: blocks.map((b) => ({
      task_id: b.task_id,
      title: b.title || '(deleted task)',
      priority: b.priority,
      start: b.start_at,
      end: b.end_at,
      late: b.is_late,
      chunk_index: b.chunk_index,
      chunk_count: b.chunk_count,
    })),
  });
});

// POST /api/schedule/replan — the "Re-plan now" button.
router.post('/replan', async (req, res) => {
  const result = await replan({ trigger: 'manual' });
  res.json({ ok: true, result });
});

module.exports = router;
module.exports.googleStatus = googleStatus;
