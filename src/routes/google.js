'use strict';

// Google OAuth 2.0 flow:
//   GET  /auth/google           -> redirect to Google's consent screen
//   GET  /auth/google/callback  -> exchange code, store refresh token, create "Tasks" calendar
//   POST /api/google/disconnect -> revoke + forget the token

const crypto = require('crypto');
const express = require('express');
const google = require('../google');
const { requireAuth, requireAuthPage } = require('../auth');

const pages = express.Router();
const api = express.Router();

pages.get('/auth/google', requireAuthPage, (req, res, next) => {
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) return next(err);
    res.redirect(google.buildAuthUrl(state));
  });
});

pages.get('/auth/google/callback', requireAuthPage, async (req, res) => {
  const { code, state, error } = req.query;
  const expected = req.session.oauthState;
  delete req.session.oauthState;

  if (error) return res.redirect(`/?google_error=${encodeURIComponent(String(error))}`);
  if (!state || !expected || state !== expected) {
    return res.redirect(`/?google_error=${encodeURIComponent('Invalid OAuth state. Please try again.')}`);
  }
  try {
    await google.completeOAuth(String(code));
    res.redirect('/?google=connected');
  } catch (err) {
    console.error('Google OAuth failed', err);
    res.redirect(`/?google_error=${encodeURIComponent(err.message || 'Google connection failed')}`);
  }
});

api.post('/disconnect', requireAuth, async (req, res) => {
  await google.disconnect();
  res.json({ ok: true });
});

module.exports = { pages, api };
