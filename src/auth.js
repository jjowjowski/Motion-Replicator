'use strict';

// Single-user password login backed by a session cookie.

const crypto = require('crypto');
const { config } = require('./config');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> { count, resetAt }

function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count++;
}

function passwordMatches(candidate) {
  if (!config.appPassword || typeof candidate !== 'string') return false;
  // Compare fixed-length digests so the comparison is constant-time.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  return Boolean(req.session && req.session.authenticated);
}

/** Protects JSON API routes. */
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
}

/** Protects browser routes (redirects to the login screen). */
function requireAuthPage(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.redirect('/');
}

/**
 * Mutating API calls must be JSON and same-origin. Together with the SameSite
 * cookie this prevents cross-site request forgery.
 */
function requireSameOriginJson(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // req.is() returns null for requests without a body, which are allowed.
  if (req.is('application/json') === false) {
    return res.status(415).json({ error: 'Expected application/json' });
  }
  const origin = req.get('origin');
  if (origin && origin !== config.baseUrl && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  next();
}

function login(req, res, next) {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!passwordMatches(req.body && req.body.password)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  // Prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.authenticated = true;
    req.session.save((saveErr) => (saveErr ? next(saveErr) : res.json({ ok: true })));
  });
}

function logout(req, res, next) {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('mr.sid');
    res.json({ ok: true });
  });
}

module.exports = {
  requireAuth,
  requireAuthPage,
  requireSameOriginJson,
  isAuthenticated,
  login,
  logout,
  passwordMatches,
};
