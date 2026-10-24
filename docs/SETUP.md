# Setup guide

You'll do three things in this order:

1. Create a Railway project and get its public URL (Google needs this URL).
2. Create the Google Cloud OAuth credentials.
3. Finish configuring Railway: variables, the cron service, and connecting Google.

Allow about 20–30 minutes.

---

## Part 1 — Railway: project, Postgres and a public URL

1. Sign in at <https://railway.com> with your GitHub account.
2. Click **New Project → Deploy from GitHub repo** and pick `Motion-Replicator`.
   (If you can't see the repo, click **Configure GitHub App** and give Railway access to
   it.) This creates the **web service**. The first deploy will fail because no variables
   are set yet. That's expected.
3. In the project canvas click **+ Create → Database → PostgreSQL**. Railway provisions a
   Postgres service named `Postgres`.
4. Open the web service → **Settings → Networking → Public Networking → Generate Domain**.
   You'll get a URL like `https://motion-replicator-production.up.railway.app`. Copy it.
   This is your **APP_BASE_URL**.
5. (Optional) In the same settings, check that **Config-as-code** points to `/railway.json`.
   It's picked up automatically from the repo root. It sets the start command
   (`npm start`), a health check on `/healthz`, and restart-on-failure.

---

## Part 2 — Google Cloud: OAuth client

### 2.1 Create a project and enable the Calendar API

1. Go to <https://console.cloud.google.com/> and sign in with the Google account that owns
   your calendar.
2. Use the project picker (top left) to choose **New Project**, name it `Motion Replicator`,
   and click **Create**. Make sure it's selected afterwards.
3. Go to **APIs & Services → Library**, search for **Google Calendar API**, open it and click
   **Enable**.

### 2.2 Configure the consent screen (Google Auth Platform)

Go to **APIs & Services → OAuth consent screen**. Newer consoles call this
**Google Auth Platform**. Click **Get started** if prompted.

1. **Branding:** set the app name to `Motion Replicator`, the user support email to your
   email, and the developer contact to your email. Save.
2. **Audience:** choose **External**. (Internal is only available for Google Workspace
   orgs. If you have Workspace, Internal is fine and you can skip step 4.)
3. **Data Access → Add or remove scopes.** Paste these into "Manually add scopes", click
   **Add to table**, then **Update** and **Save**:
   ```
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.app.created
   ```
   - `calendar.readonly`: free/busy for your primary calendar, and finding an existing
     "Tasks" calendar.
   - `calendar.events`: creating and deleting the task blocks.
   - `calendar.app.created`: Google requires this to **create** a new secondary calendar.
     `calendar.events` alone cannot create calendars.
4. **Publish the app. This is important.** Under **Audience → Publishing status**, click
   **Publish app → Confirm** so the status reads **In production**.
   - While an External app is in **Testing**, Google expires its refresh tokens after
     **7 days**, and the daily cron would then stop working.
   - You don't need to submit for verification for personal use. When you connect, Google
     shows a "Google hasn't verified this app" screen. Click **Advanced → Go to Motion
     Replicator (unsafe)**. This is your own app talking to your own calendar.
   - If you'd rather stay in Testing, add your Gmail address under **Audience → Test users**
     and expect to reconnect weekly.

### 2.3 Create the OAuth client ID

1. Go to **APIs & Services → Credentials**. In newer consoles this is
   **Google Auth Platform → Clients**. Click **Create credentials → OAuth client ID**.
2. Set **Application type** to **Web application** and **Name** to `Motion Replicator web`.
3. Under **Authorized redirect URIs**, add:
   ```
   https://<your-railway-domain>/auth/google/callback
   ```
   For example, `https://motion-replicator-production.up.railway.app/auth/google/callback`.
   Optionally, also add `http://localhost:3000/auth/google/callback` for local development.
   You don't need any JavaScript origins.
4. Click **Create**, then copy the **Client ID** and **Client secret**. You can download the
   JSON as a backup, but don't commit it.

---

## Part 3 — Railway: variables, cron, and first run

### 3.1 Generate secrets

On your machine, with the repo cloned and `npm install` done:

```bash
npm run gen-key   # copy -> SESSION_SECRET
npm run gen-key   # copy -> TOKEN_ENCRYPTION_KEY
```

You can also use `openssl rand -base64 32` for each. Keep TOKEN_ENCRYPTION_KEY safe. If you
lose it, you'll just need to reconnect Google.

### 3.2 Shared variables

Both the web and the cron service need most of the same variables, so define them once.

1. Go to **Project → Settings → Shared Variables** and add:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_BASE_URL` | `https://<your-railway-domain>` (no trailing slash) |
   | `TOKEN_ENCRYPTION_KEY` | the second generated key |
   | `GOOGLE_CLIENT_ID` | from step 2.3 |
   | `GOOGLE_CLIENT_SECRET` | from step 2.3 |

2. Open the **web service → Variables** and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a reference variable; pick it from the autocomplete) |
   | `APP_PASSWORD` | the password you'll log in with (make it long) |
   | `SESSION_SECRET` | the first generated key |

   Then use **Shared Variable → Add** (or the "shared variables" suggestion banner) to share
   all five shared variables with this service.

3. Click **Deploy** to apply the staged changes. Watch **Deployments → View logs** for:
   ```
   Applying migration 001_initial_schema.sql
   Migrations up to date
   Motion Replicator listening on port 8080 (https://...)
   ```
   `https://<domain>/healthz` should return `{"ok":true}`. Railway sets `PORT` for you.

### 3.3 Create the cron service

Railway runs cron jobs as a separate service that starts, does its work and exits.

1. In the project canvas, click **+ Create → GitHub Repo** and pick the **same repository**
   again. Rename the new service `planner-cron` (**Settings → Service name**).
2. Go to **Settings → Config-as-code** and set **Railway Config File** to
   `/railway.cron.json`. That file sets:
   - **Start command:** `npm run cron`
   - **Cron schedule:** `30 17,18 * * *`
   - **Restart policy:** Never

   If you'd rather set these by hand, use **Settings → Deploy → Custom Start Command** for
   `npm run cron` and **Settings → Deploy → Cron Schedule** for `30 17,18 * * *`.
3. **Variables:** add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` and share the same five
   shared variables (`NODE_ENV`, `APP_BASE_URL`, `TOKEN_ENCRYPTION_KEY`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). It doesn't need `APP_PASSWORD` or
   `SESSION_SECRET`.
4. Don't generate a public domain for this service.
5. Click **Deploy**.

**Why two times?** Railway cron schedules are in **UTC**, and 6:30am in Auckland is a
different UTC time depending on the season:

| Season | Offset | 6:30am NZ in UTC |
|---|---|---|
| NZDT (late Sep → early Apr) | UTC+13 | 17:30 the previous day |
| NZST (early Apr → late Sep) | UTC+12 | 18:30 the previous day |

The job runs at both times. `src/cron.js` checks the real Auckland time and only plans when
the local hour is 6, so exactly one of the two runs does the work. It also skips if a cron
run already succeeded that day. The other run logs "not the planning hour" and exits. To
change the time, edit the cron schedule and set `CRON_LOCAL_HOUR`.

### 3.4 Connect Google and run the first plan

1. Open `https://<your-railway-domain>` and log in with `APP_PASSWORD`.
2. Click **Connect Google Calendar**, choose your account, and get past the "unverified app"
   screen (**Advanced → Go to Motion Replicator**). Tick **all** the Calendar permission
   checkboxes and click **Continue**.
3. You'll land back in the app with "Google Calendar connected". A calendar called **Tasks**
   now shows up in Google Calendar.
4. Add a task and press **Re-plan now**. The blocks appear in the Tasks calendar.

To test the cron path straight away, temporarily set the cron service's start command to
`node src/cron.js --force`, deploy it, check the logs, and then set it back.

### 3.5 Install it as an app (PWA)

- **iPhone/iPad:** open the URL in **Safari → Share → Add to Home Screen**.
- **Android:** in Chrome, use **⋮ → Install app** (or the install banner).
- **Laptop:** in Chrome or Edge, click the install icon in the address bar. In Safari on
  macOS, use **File → Add to Dock**.

The app shell is cached for fast start-up and offline launch. Task data always comes live
from the server.

---

## Optional settings

You can set these as variables on **both** services:

| Variable | Default | Meaning |
|---|---|---|
| `PLANNING_DAYS` | `7` | today + 6 days |
| `BUFFER_MINUTES` | `10` | gap between blocks/meetings |
| `SPLIT_THRESHOLD_MINUTES` | `90` | tasks longer than this may be split |
| `MIN_CHUNK_MINUTES` | `30` | smallest chunk when splitting |
| `GRANULARITY_MINUTES` | `5` | block start times are rounded up to this |
| `SCHEDULE_LATE_TASKS` | `true` | place the leftover of at-risk tasks after the deadline |
| `TASKS_CALENDAR_NAME` | `Tasks` | name of the secondary calendar |
| `CRON_LOCAL_HOUR` | `6` | local hour in which the cron job plans |
| `WORKING_HOURS_JSON` | Mon–Fri 9–17:30, Sat 10–14 | e.g. `{"1":[["09:00","12:00"],["13:00","17:30"]],"6":[["10:00","14:00"]]}` (1 = Mon … 7 = Sun; multiple ranges per day allowed) |

## Troubleshooting

- **`redirect_uri_mismatch`:** the redirect URI in Google must exactly match
  `APP_BASE_URL + /auth/google/callback`. Check https vs http, the domain, and that there's
  no trailing slash on `APP_BASE_URL`.
- **"Google did not grant all required permissions":** you unticked a checkbox on the
  consent screen. Reconnect and tick all of them.
- **"Google access was revoked or expired":** the app was probably still in **Testing**
  (7-day tokens), or you removed access at <https://myaccount.google.com/permissions>.
  Publish the app (step 2.2.4) and reconnect.
- **Cron did nothing:** check the `planner-cron` logs. One of the two daily runs always
  logs "not the planning hour", which is normal. Errors also show up in the app under
  "Upcoming schedule" as "Last daily run failed: …".
- **Login loops on Railway:** make sure `NODE_ENV=production` and that you're using the
  `https://` URL. Secure cookies need HTTPS, and the app trusts Railway's proxy.
