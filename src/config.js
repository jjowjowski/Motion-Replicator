'use strict';

// Central configuration. Secrets come from environment variables (Railway
// "Variables" tab in production, a local .env file in development).

const fs = require('fs');
const path = require('path');

// Minimal .env loader for local development (Railway injects real env vars).
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

// Working hours per ISO weekday (1 = Monday ... 7 = Sunday), local time.
// Override with WORKING_HOURS_JSON, e.g.
// {"1":[["09:00","17:30"]],"6":[["10:00","14:00"]]}
const DEFAULT_WORKING_HOURS = {
  1: [['09:00', '17:30']],
  2: [['09:00', '17:30']],
  3: [['09:00', '17:30']],
  4: [['09:00', '17:30']],
  5: [['09:00', '17:30']],
  6: [['10:00', '14:00']],
  7: [],
};

function workingHoursFromEnv() {
  const raw = process.env.WORKING_HOURS_JSON;
  if (!raw) return DEFAULT_WORKING_HOURS;
  const parsed = JSON.parse(raw);
  const result = {};
  for (let d = 1; d <= 7; d++) result[d] = parsed[d] || parsed[String(d)] || [];
  return result;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: intEnv('PORT', 3000),
  // Public URL of the app, used for OAuth redirect and links in calendar events.
  baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  databaseUrl: process.env.DATABASE_URL,
  appPassword: process.env.APP_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // calendar.readonly  -> read free/busy of the primary calendar + list calendars
    // calendar.events    -> create/delete events (works on any calendar you own)
    // calendar.app.created -> required by Google to *create* the secondary "Tasks"
    //                       calendar (calendar.events alone cannot create calendars)
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.app.created',
    ],
    tasksCalendarName: process.env.TASKS_CALENDAR_NAME || 'Tasks',
  },

  schedule: {
    timeZone: 'Pacific/Auckland',
    planningDays: intEnv('PLANNING_DAYS', 7), // today + next 6 days
    bufferMinutes: intEnv('BUFFER_MINUTES', 10),
    splitThresholdMinutes: intEnv('SPLIT_THRESHOLD_MINUTES', 90),
    minChunkMinutes: intEnv('MIN_CHUNK_MINUTES', 30),
    granularityMinutes: intEnv('GRANULARITY_MINUTES', 5),
    // After on-time placement, also place the unfinished remainder of tasks that
    // miss their deadline into any leftover time (flagged as late).
    scheduleLateTasks: process.env.SCHEDULE_LATE_TASKS !== 'false',
    workingHours: workingHoursFromEnv(),
    // The cron job only runs the planner when the local Auckland time is in this hour.
    cronLocalHour: intEnv('CRON_LOCAL_HOUR', 6),
  },
};

function requireConfig(keys) {
  const missing = keys.filter((k) => {
    const value = k.split('.').reduce((o, part) => (o ? o[part] : undefined), config);
    return !value;
  });
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

module.exports = { config, requireConfig, DEFAULT_WORKING_HOURS };
