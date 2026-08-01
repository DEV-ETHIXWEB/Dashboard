'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = 'v1';

let cachedKey = null;
let usingEphemeralKey = false;

function parseConfiguredKey(raw) {
  const trimmed = String(raw).trim();
  let buf = null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, 'hex');
  } else {
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length === KEY_BYTES) buf = decoded;
    } catch {
      buf = null;
    }
  }

  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error(
      'OTP_ENCRYPTION_KEY must be 32 bytes, given as 64 hex characters or base64. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return buf;
}

function getKey() {
  if (cachedKey) return cachedKey;

  const configured = process.env.OTP_ENCRYPTION_KEY;
  if (configured) {
    cachedKey = parseConfiguredKey(configured);
    return cachedKey;
  }

  cachedKey = crypto.randomBytes(KEY_BYTES);
  usingEphemeralKey = true;
  console.warn(
    '[otp] OTP_ENCRYPTION_KEY is not set. Using a random key generated at startup, ' +
      'so login codes issued before a restart stop being readable after it. Codes ' +
      'expire in 5 minutes, so this is safe but means a restart cancels any login in ' +
      'flight. Set OTP_ENCRYPTION_KEY in .env to make it persistent.',
  );
  return cachedKey;
}

function isUsingEphemeralKey() {
  return usingEphemeralKey;
}

function encryptCode(plainCode) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainCode), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptCode(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function codesMatch(submitted, storedCiphertext) {
  const actual = decryptCode(storedCiphertext);
  if (actual === null) return false;

  const a = Buffer.from(String(submitted));
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { encryptCode, decryptCode, codesMatch, isUsingEphemeralKey };
