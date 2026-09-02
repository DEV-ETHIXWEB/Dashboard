'use strict';

/**
 * Where a profile picture lives.
 *
 * The app has no object store today, and routes/reports.js shows what it does
 * instead: bytes base64-encoded into a Postgres column, with a `storage_type`
 * discriminator on the row saying which backend put them there ('database' or
 * 'drive'). That pattern is reused rather than reinvented -- it works on the
 * serverless target, where there is no writable disk to fall back on, and it
 * keeps an avatar inside the same backup and access story as everything else.
 *
 * The one thing added here is the seam. Every read and write goes through
 * `driver()`, and a driver is four functions. Moving avatars to S3 or GCS later
 * means writing one of those and setting AVATAR_STORAGE -- no route, no
 * component, and no caller in this file changes, because none of them knows
 * where the bytes are. The `storage_type` column already records which driver
 * wrote each row, so a migration can move them one at a time.
 *
 * Deliberately *not* done here: resizing. The browser hands us an image already
 * scaled to avatar size (see frontend/src/lib/avatar.ts), so the server's job
 * is to verify rather than to transform -- which is also the only version of
 * this that runs without a native image library in the bundle. The server still
 * refuses anything that is not a small, sane picture; it just does not repair
 * it. See utils/imageValidation.js.
 */

const crypto = require('crypto');
const { db } = require('../db/setup');

/** Which backend new uploads go to. */
function storageType() {
  return String(process.env.AVATAR_STORAGE || 'database').toLowerCase();
}

/**
 * The bytes in a Postgres (or Firestore) column, alongside every other record.
 *
 * One row per account -- `user_avatars.user_id` is UNIQUE, and the row id *is*
 * the user id, so replacing a picture is an overwrite by construction rather
 * than an insert that somebody has to remember to pair with a delete.
 */
const databaseDriver = {
  name: 'database',

  async put(userId, { buffer, image, actorId }) {
    return {
      storageType: 'database',
      contentBase64: buffer.toString('base64'),
      mimeType: image.mimeType,
      sizeBytes: buffer.length,
      width: image.width,
      height: image.height,
      checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
      updatedBy: actorId || null,
    };
  },

  async read(row) {
    if (!row || !row.contentBase64) return null;
    return Buffer.from(row.contentBase64, 'base64');
  },

  async remove() {
    // The bytes live in the row itself, so deleting the row is the whole job.
  },
};

const DRIVERS = { database: databaseDriver };

function driver(name = storageType()) {
  const chosen = DRIVERS[name];
  if (chosen) return chosen;
  // An unknown name is a configuration mistake, and quietly falling back would
  // hide it until somebody wondered why nothing reached their bucket.
  console.warn(`[avatars] Unknown AVATAR_STORAGE "${name}". Falling back to the database.`);
  return databaseDriver;
}

/** The stored record for one account, or null. Never includes the bytes. */
async function metaFor(userId) {
  const row = await db.find('user_avatars', userId);
  if (!row) return null;
  return {
    userId: row.userId,
    storageType: row.storageType,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes) || 0,
    width: row.width,
    height: row.height,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** The picture itself: `{ buffer, mimeType, updatedAt }`, or null. */
async function load(userId) {
  const row = await db.find('user_avatars', userId);
  if (!row) return null;
  const buffer = await driver(row.storageType).read(row);
  if (!buffer) return null;
  return {
    buffer,
    // The type the *validator* decided when this was stored, never one the
    // uploader supplied. That is what makes serving these bytes safe.
    mimeType: row.mimeType,
    updatedAt: row.updatedAt,
    checksum: row.checksum,
  };
}

/**
 * Store a picture for one account, replacing whatever was there.
 *
 * `image` is the validated descriptor from utils/imageValidation.js -- the
 * caller must have run it, because this is where its verdict becomes the
 * stored content type.
 */
async function save(userId, { buffer, image, actorId = null }) {
  const stored = await driver().put(userId, { buffer, image, actorId });
  const updatedAt = new Date().toISOString();
  const existing = await db.find('user_avatars', userId);

  const record = { ...stored, updatedAt };

  if (existing) {
    await db.update('user_avatars', existing.id, record);
  } else {
    await db.insert('user_avatars', { id: userId, userId, ...record });
  }

  // The cheap flag the user list reads. Doubles as the cache-buster on the
  // avatar URL, so a replaced picture appears immediately instead of whenever
  // the browser next feels like revalidating.
  const avatarUpdatedAt = Date.now();
  await db.update('users', userId, { avatarUpdatedAt });

  return { ...record, contentBase64: undefined, avatarUpdatedAt };
}

/** Remove a picture. Safe to call when there is not one. */
async function remove(userId) {
  const existing = await db.find('user_avatars', userId);
  if (existing) {
    await driver(existing.storageType).remove(existing);
    await db.remove('user_avatars', existing.id);
  }
  await db.update('users', userId, { avatarUpdatedAt: null });
  return Boolean(existing);
}

module.exports = { storageType, driver, metaFor, load, save, remove };
