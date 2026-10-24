# Motion Replicator

A single-user, Motion-style auto-scheduler. You add tasks with a priority, duration and
deadline; every morning at 6:30am (Pacific/Auckland), or when you press **Re-plan now**,
the app reads your free/busy time from your primary Google Calendar and places the tasks
as blocks in a dedicated **Tasks** calendar.

- **Backend:** Node.js 20+, Express 5, Postgres (`pg`), Luxon for time zones
- **Frontend:** plain HTML/CSS/JS, installable as a PWA (manifest + service worker)
- **Hosting:** Railway (web service + cron service + Postgres)

👉 **Setup guide (Google Cloud OAuth + Railway): [docs/SETUP.md](docs/SETUP.md)**

## Features

- Tasks: title, priority (High/Medium/Low), estimated duration, deadline date with an optional
  time, and notes. Sort by deadline or priority, then edit, delete or mark done. Done tasks
  stay in the database but are hidden (tick **Done** to see them) and are never scheduled again.
- Google Calendar via OAuth 2.0. The refresh token is encrypted with AES-256-GCM before it is
  stored in Postgres. On first connect the app finds or creates a secondary calendar named
  "Tasks".
- Scheduler:
  - Looks at today plus the next 6 days. Working hours are Mon–Fri 9:00–17:30 and
    Sat 10:00–14:00; Sunday is off. Blocks have a 10-minute buffer between them.
  - Uses the free/busy API on your **primary** calendar. It never writes to that calendar.
  - Deletes only **future** events that it created itself. Their IDs are tracked in
    `scheduled_events`, and nothing in any other calendar is touched.
  - Orders tasks by deadline, then priority, then creation date, and places them greedily.
  - Tasks longer than 90 minutes can be split into chunks of at least 30 minutes.
  - Tasks that can't fit before their deadline are flagged (**At risk** / **Overdue**) and
    shown in a warning panel. Whatever didn't fit is then placed after the deadline in time
    that is still free, so it never pushes out a task that can still be on time.
  - Each event has the task title, the priority in its description, a colour for the
    priority, and a link back to the app (`/?task=ID`).
- Password login with a session cookie stored in Postgres. All times are Pacific/Auckland.

## Project layout

```
├── migrations/001_initial_schema.sql   # tables: tasks, google_account, scheduled_events, schedule_runs, session
├── public/                             # PWA front end (index.html, app.js, styles.css, sw.js, manifest, icons)
├── scripts/generate-icons.py           # regenerates the PWA icons (Pillow)
├── src/
│   ├── server.js                       # Express app (runs migrations on boot)
│   ├── cron.js                         # Railway cron entry point
│   ├── config.js                       # env vars + scheduler settings
│   ├── db.js / migrate.js              # Postgres pool + migration runner
│   ├── auth.js                         # password login, session, CSRF guard
│   ├── crypto.js                       # AES-256-GCM for the refresh token
│   ├── google.js                       # OAuth, Tasks calendar, freebusy, event insert/delete
│   ├── routes/{tasks,schedule,google}.js
│   └── scheduler/
│       ├── algorithm.js                # pure slot-filling algorithm (unit tested)
│       └── planner.js                  # orchestrates a planning run against Google + DB
├── test/
│   ├── algorithm.test.js               # unit tests for the algorithm
│   └── planner.integration.test.js     # planner against real Postgres, Google stubbed
├── railway.json                        # web service config
└── railway.cron.json                   # cron service config
```

## Running locally

```bash
npm install
cp .env.example .env          # fill in values; use `npm run gen-key` for the two secrets
createdb motion_replicator    # or point DATABASE_URL at any Postgres
npm run dev                   # http://localhost:3000 (migrations run automatically)
```

For Google to work locally, add `http://localhost:3000/auth/google/callback` as an extra
redirect URI on your OAuth client (see the setup guide).

Run a planning pass from the command line (skips the 6am check):

```bash
node src/cron.js --force
```

## Tests

```bash
npm test                                                   # algorithm unit tests
TEST_DATABASE_URL=postgres://localhost/mr_test npm test    # + planner integration tests
```

The integration tests truncate the tables in `TEST_DATABASE_URL`, so use a throwaway
database.

## How the scheduler works

1. **Horizon.** The plan runs from now, rounded up to 5 minutes, until midnight at the end
   of the 7th day.
2. **Free time.** The app builds working-hour windows for each local day (Luxon handles NZ
   daylight saving). It then subtracts busy time from the primary calendar and any app block
   that is in progress right now. Busy time and placed blocks are padded by the buffer on
   both sides, so any two neighbours end up exactly 10 minutes apart.
3. **Pass 1, on time.** Tasks are taken in order (deadline → priority → created) and placed
   in the earliest free slot that ends before their deadline:
   - ≤ 90 min: needs one continuous slot.
   - \> 90 min: fills slots in chunks of 30 min or more, and never leaves a leftover under
     30 min.
4. **Flagging.** A task that isn't fully placed is marked `at_risk`, or `overdue` if its
   deadline has passed. If the deadline is beyond the 7-day window it is marked `partial`
   instead (informational only), and the rest is planned on later runs.
5. **Pass 2, late work.** The unplaced remainder of flagged tasks goes into whatever time is
   still free, and is marked "late" in the calendar.
6. **Apply.** Only after the new plan has been computed, the app deletes its own future
   events and inserts the new ones. If the free/busy call fails, the existing schedule is
   left as it was. A Postgres advisory lock prevents two runs at once.

**Durations are "remaining time".** If you've done part of a task, lower its duration (or
mark it done). A block that is in progress when you re-plan is kept and counts towards its
task. Past blocks don't count.

**Re-planning after edits.** Adding or editing tasks doesn't touch the calendar straight
away. A banner reminds you to press **Re-plan now**. Marking a task done, or deleting it,
removes its future blocks immediately.
