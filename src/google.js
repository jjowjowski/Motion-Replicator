'use strict';

// Google OAuth + Calendar API helpers.

const { auth, calendar } = require('@googleapis/calendar');
const { config, requireConfig } = require('./config');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

class GoogleNotConnectedError extends Error {
  constructor(message = 'Google Calendar is not connected') {
    super(message);
    this.name = 'GoogleNotConnectedError';
    this.status = 409;
  }
}

function redirectUri() {
  return `${config.baseUrl}/auth/google/callback`;
}

function createOAuthClient() {
  requireConfig(['google.clientId', 'google.clientSecret']);
  return new auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri());
}

function buildAuthUrl(state) {
  return createOAuthClient().generateAuthUrl({
    access_type: 'offline', // we need a refresh token for the cron job
    prompt: 'consent', // always return a refresh token, even on reconnect
    include_granted_scopes: true,
    scope: config.google.scopes,
    state,
  });
}

function isInvalidGrant(err) {
  const data = err && err.response && err.response.data;
  return (
    (data && (data.error === 'invalid_grant' || data.error === 'unauthorized_client')) ||
    /invalid_grant/.test(String(err && err.message))
  );
}

function errorStatus(err) {
  return Number(err && (err.code || (err.response && err.response.status))) || 0;
}

async function getAccount() {
  const { rows } = await db.query('SELECT * FROM google_account WHERE id = 1');
  return rows[0] || null;
}

async function markNeedsReauth() {
  await db.query('UPDATE google_account SET needs_reauth = true, updated_at = now() WHERE id = 1');
}

/** Exchange an OAuth code, store the encrypted refresh token, create the Tasks calendar. */
async function completeOAuth(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  const granted = String(tokens.scope || '').split(/\s+/);
  const missing = config.google.scopes.filter((s) => !granted.includes(s));
  if (missing.length) {
    const err = new Error(
      `Google did not grant all required permissions (missing: ${missing.join(', ')}). ` +
        'Please reconnect and tick every Calendar checkbox on the consent screen.',
    );
    err.status = 400;
    throw err;
  }

  const existing = await getAccount();
  let refreshToken = tokens.refresh_token;
  if (!refreshToken && existing) refreshToken = decrypt(existing.refresh_token_enc);
  if (!refreshToken) {
    const err = new Error(
      'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and connect again.',
    );
    err.status = 400;
    throw err;
  }

  client.setCredentials({ ...tokens, refresh_token: refreshToken });
  const cal = calendar({ version: 'v3', auth: client });
  const primary = await cal.calendars.get({ calendarId: 'primary' });

  await db.query(
    `INSERT INTO google_account (id, email, refresh_token_enc, scopes, tasks_calendar_id, needs_reauth, connected_at, updated_at)
     VALUES (1, $1, $2, $3, $4, false, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       scopes = EXCLUDED.scopes,
       -- keep the known Tasks calendar if the same Google account reconnects
       tasks_calendar_id = CASE WHEN google_account.email = EXCLUDED.email
                                THEN google_account.tasks_calendar_id ELSE NULL END,
       needs_reauth = false,
       updated_at = now()`,
    [primary.data.id, encrypt(refreshToken), tokens.scope || null, null],
  );

  const account = await getAccount();
  await ensureTasksCalendar(cal, account);
  return getAccount();
}

/** Authenticated Calendar client for the stored account. */
async function getCalendarClient() {
  const account = await getAccount();
  if (!account) throw new GoogleNotConnectedError();
  if (account.needs_reauth) {
    throw new GoogleNotConnectedError('Google access was revoked or expired. Please reconnect Google Calendar.');
  }
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: decrypt(account.refresh_token_enc) });
  client.on('tokens', (tokens) => {
    // Google occasionally rotates refresh tokens; persist the new one.
    if (tokens.refresh_token) {
      db.query('UPDATE google_account SET refresh_token_enc = $1, updated_at = now() WHERE id = 1', [
        encrypt(tokens.refresh_token),
      ]).catch((err) => console.error('Failed to store rotated refresh token', err));
    }
  });
  try {
    await client.getAccessToken();
  } catch (err) {
    if (isInvalidGrant(err)) {
      await markNeedsReauth();
      throw new GoogleNotConnectedError('Google access was revoked or expired. Please reconnect Google Calendar.');
    }
    throw err;
  }
  return { cal: calendar({ version: 'v3', auth: client }), account };
}

/**
 * Make sure the secondary "Tasks" calendar exists and return its id.
 * Order: stored id (if still accessible) -> existing owned calendar with the
 * same name -> create a new one.
 */
async function ensureTasksCalendar(cal, account) {
  const name = config.google.tasksCalendarName;

  if (account.tasks_calendar_id) {
    try {
      await cal.calendars.get({ calendarId: account.tasks_calendar_id });
      return account.tasks_calendar_id;
    } catch (err) {
      if (![404, 410].includes(errorStatus(err))) throw err;
      // Calendar was deleted by the user; fall through and recreate.
    }
  }

  let calendarId = null;
  let pageToken;
  do {
    const res = await cal.calendarList.list({ minAccessRole: 'owner', maxResults: 250, pageToken });
    const match = (res.data.items || []).find((c) => c.summary === name && !c.deleted);
    if (match) calendarId = match.id;
    pageToken = res.data.nextPageToken;
  } while (!calendarId && pageToken);

  if (!calendarId) {
    const created = await cal.calendars.insert({
      requestBody: {
        summary: name,
        description: `Task blocks planned automatically by Motion Replicator (${config.baseUrl}).`,
        timeZone: config.schedule.timeZone,
      },
    });
    calendarId = created.data.id;
  }

  await db.query('UPDATE google_account SET tasks_calendar_id = $1, updated_at = now() WHERE id = 1', [calendarId]);
  return calendarId;
}

/** Busy intervals (ms) on the primary calendar between two instants. */
async function getPrimaryBusy(cal, timeMin, timeMax) {
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      timeZone: config.schedule.timeZone,
      items: [{ id: 'primary' }],
    },
  });
  const entry = res.data.calendars && res.data.calendars.primary;
  if (entry && entry.errors && entry.errors.length) {
    throw new Error(`Free/busy lookup failed: ${entry.errors.map((e) => e.reason).join(', ')}`);
  }
  return ((entry && entry.busy) || []).map((b) => ({
    start: Date.parse(b.start),
    end: Date.parse(b.end),
  }));
}

async function insertEvent(cal, calendarId, requestBody) {
  const res = await cal.events.insert({ calendarId, requestBody, sendUpdates: 'none' });
  return res.data;
}

/** Delete an event; already-deleted events (404/410) count as success. */
async function deleteEvent(cal, calendarId, eventId) {
  try {
    await cal.events.delete({ calendarId, eventId, sendUpdates: 'none' });
  } catch (err) {
    if (![404, 410].includes(errorStatus(err))) throw err;
  }
}

async function disconnect() {
  const account = await getAccount();
  if (!account) return;
  try {
    const client = createOAuthClient();
    await client.revokeToken(decrypt(account.refresh_token_enc));
  } catch (err) {
    console.warn('Token revoke failed (continuing):', err.message);
  }
  await db.query('DELETE FROM google_account WHERE id = 1');
}

module.exports = {
  GoogleNotConnectedError,
  buildAuthUrl,
  completeOAuth,
  getAccount,
  getCalendarClient,
  ensureTasksCalendar,
  getPrimaryBusy,
  insertEvent,
  deleteEvent,
  disconnect,
  redirectUri,
};
