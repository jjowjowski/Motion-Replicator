'use strict';

// Entry point for the Railway cron service.
//
// Railway cron schedules are in UTC, and 6:30am in Auckland is 17:30 UTC
// during daylight time (NZDT, UTC+13) but 18:30 UTC in winter (NZST, UTC+12).
// The cron service therefore runs at both times ("30 17,18 * * *") and this
// script only plans when the local Auckland hour is CRON_LOCAL_HOUR (6).
// It also skips if a cron run already succeeded today (local date).
//
// Usage: node src/cron.js [--force]

const { DateTime } = require('luxon');
const { config, requireConfig } = require('./config');
const db = require('./db');
const { migrate } = require('./migrate');
const { replan } = require('./scheduler/planner');

async function main() {
  requireConfig(['databaseUrl', 'tokenEncryptionKey', 'google.clientId', 'google.clientSecret']);
  const force = process.argv.includes('--force');
  const tz = config.schedule.timeZone;
  const local = DateTime.now().setZone(tz);

  if (!force && local.hour !== config.schedule.cronLocalHour) {
    console.log(`Local time is ${local.toFormat('HH:mm')} ${tz}; not the planning hour. Exiting.`);
    return;
  }

  await migrate({ log: () => {} });

  if (!force) {
    const { rows } = await db.query(
      `SELECT 1 FROM schedule_runs
        WHERE trigger = 'cron' AND status = 'ok'
          AND (started_at AT TIME ZONE $1)::date = $2::date
        LIMIT 1`,
      [tz, local.toISODate()],
    );
    if (rows.length) {
      console.log('A cron run already succeeded today. Exiting.');
      return;
    }
  }

  const result = await replan({ trigger: 'cron' });
  console.log('Cron planning run finished', result);
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Cron planning run failed:', err);
    await db.close().catch(() => {});
    process.exit(1);
  });
