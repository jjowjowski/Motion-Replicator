'use strict';

// AES-256-GCM encryption for the Google refresh token at rest.
// TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 or hex encoded
// (generate one with `npm run gen-key`).

const crypto = require('crypto');
const { config } = require('./config');

function getKey() {
  const raw = config.tokenEncryptionKey;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(payload) {
  const [version, iv, tag, ciphertext] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unknown encrypted token format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
