'use strict';

const { v4: uuidv4 } = require('uuid');
const { toSnake, toCamel, isWritableField, uniqueFields } = require('./schemas');

let db = null;

function getDb() {
  if (db) return db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not set. Firebase Console -> Project Settings -> ' +
        'Service Accounts -> Generate new private key, then paste the whole JSON on one line.',
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the entire downloaded file as a single line.');
  }
  if (!credentials.project_id || !credentials.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id/private_key -- that looks like the public web config, not a service account key.');
  }

  const admin = require('firebase-admin');
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(credentials) });

  db = admin.firestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

function sanitize(collection, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // Same rule as the Postgres driver: the canonical camelCase name of a real
    // column, and nothing that merely normalises onto one. Folding
    // `is_super_admin` into `isSuperAdmin` here gave the Firestore deployment
    // the identical privilege-escalation path the Postgres one had.
    if (!isWritableField(collection, k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function docToObj(doc) {
  if (!doc || !doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Postgres' unique-violation code, which callers here also check for.
 *
 * The application must not have to know which driver it is talking to in order
 * to recognise "that id is taken". Firestore reports it as gRPC status 6
 * (ALREADY_EXISTS); this restamps it as 23505 so one `err.code === '23505'`
 * check works on both.
 */
const PG_UNIQUE_VIOLATION = '23505';
const ALREADY_EXISTS = new Set([6, '6', 'already-exists', 'ALREADY_EXISTS']);

function asUniqueViolation(err, collection, id) {
  if (!ALREADY_EXISTS.has(err?.code)) return err;
  const conflict = new Error(`${collection} already has a record with id ${id}.`);
  conflict.code = PG_UNIQUE_VIOLATION;
  conflict.cause = err;
  return conflict;
}

// --- unique fields ---------------------------------------------------------

/**
 * How Firestore is made to enforce a UNIQUE column.
 *
 * Postgres rejects the second row itself. Firestore has no such thing -- a
 * field is a field, and duplicates are simply allowed -- so uniqueness has to
 * be built out of the one guarantee it does offer: a document id can only be
 * created once. Each unique value is therefore *reserved* by creating a
 * document whose id encodes it, in the same atomic write as the row, and the
 * reservation failing is what makes the row fail.
 *
 * This is not a tidiness feature. Several callers in this codebase treat a
 * rejected insert as a guarantee and act on it -- routes/sms.js reads it as
 * "Twilio is re-sending a text we already have", utils/smsConversations.js as
 * "somebody else just created this conversation". Without the reservations
 * those callers were silently wrong on this driver, and a Twilio retry became a
 * second copy of a customer's message.
 *
 * Reservations live in their own collection so nothing iterating real data ever
 * trips over them, and they are removed when the row that owns them is deleted
 * or changes the value.
 */
const UNIQUE_KEYS = '_unique_keys';

/** A document id for one (collection, field, value). Slashes are not allowed in ids. */
function reservationId(collection, field, value) {
  return `${collection}:${toSnake(field)}:${Buffer.from(String(value), 'utf8').toString('base64url')}`;
}

/**
 * The reservations a document needs, for the values it actually carries.
 *
 * Null and undefined reserve nothing, matching Postgres: a UNIQUE column allows
 * any number of NULLs, because unknown is not a value two rows can share.
 */
function reservationsFor(collection, data) {
  const wanted = [];
  for (const field of uniqueFields(collection)) {
    const value = data[field];
    if (value === null || value === undefined || value === '') continue;
    wanted.push({ field, value, id: reservationId(collection, field, value) });
  }
  return wanted;
}

function reservationRef(id) {
  return getDb().collection(UNIQUE_KEYS).doc(id);
}

/** The unique-violation error a caller expects, naming the field that clashed. */
function fieldConflict(collection, field, value) {
  const conflict = new Error(`${collection}.${toSnake(field)} already has the value ${value}.`);
  conflict.code = PG_UNIQUE_VIOLATION;
  conflict.constraint = `${collection}_${toSnake(field)}_key`;
  return conflict;
}

/**
 * Whether a reservation is still doing a job, or is debris.
 *
 * A process that dies between committing a row and releasing its old
 * reservation leaves a value claimed by nobody -- and a claim nobody owns would
 * block that email, or that phone number, forever. So a blocked write asks one
 * question before giving up: does the document this points at still exist, and
 * does it still carry this value? If not, the claim is stale and gets cleared.
 */
async function reservationIsLive(held) {
  const doc = await reservationRef(held.id).get();
  if (!doc.exists) return false;

  const { collection, docId, field } = doc.data() || {};
  if (!collection || !docId) return false;

  const owner = await getDb().collection(collection).doc(String(docId)).get();
  if (!owner.exists) return false;

  const current = owner.data()?.[toCamel(field || '')];
  return String(current ?? '') === String(held.value);
}

/** Drop reservations, best-effort: a leftover one is reclaimed by the check above. */
async function releaseReservations(ids) {
  if (ids.length === 0) return;
  const client = getDb();
  const batch = client.batch();
  for (const id of ids) batch.delete(reservationRef(id));
  try {
    await batch.commit();
  } catch (err) {
    console.error('[firestore] could not release unique-key reservations:', err.message);
  }
}

/**
 * Read the reservations a set of documents holds, so deleting them frees the
 * values again. Without this a deleted user's email could never be reused.
 */
function reservationIdsForRows(collection, rows) {
  const ids = [];
  for (const row of rows) {
    for (const held of reservationsFor(collection, row)) ids.push(held.id);
  }
  return ids;
}

const firestoreDb = {
  async all(collection) {
    const snap = await getDb().collection(collection).get();
    return snap.docs.map(docToObj);
  },

  async find(collection, id) {
    if (id == null) return null;
    const doc = await getDb().collection(collection).doc(String(id)).get();
    return docToObj(doc);
  },

  async filter(collection, predicate) {
    const rows = await firestoreDb.all(collection);
    return rows.filter(predicate);
  },

  async recent(collection, limit = 100) {
    const snap = await getDb()
      .collection(collection)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(docToObj);
  },

  async insert(collection, obj) {
    const id = String(obj.id || uuidv4());
    const data = sanitize(collection, obj);
    delete data.id; // the document id carries this; don't duplicate it in the body

    // `create`, not `set`. An id that is already taken has to be a conflict
    // here for the same reason a repeated PRIMARY KEY is one in Postgres:
    // several callers use a failed insert as a guarantee rather than an error.
    // The Slack retry ledger in routes/slackEvents.js is the sharpest case --
    // it inserts the event id before doing any work, and reads the conflict as
    // "another delivery of this event already ran". With `set` that insert
    // quietly overwrote its own ledger row and the retry went on to send the
    // customer a second text. Same for the Twilio provider_sid guard in
    // routes/sms.js and the conversation guard in utils/smsConversations.js.
    const wanted = reservationsFor(collection, data);

    // One batch, so the row and every value it claims land together or not at
    // all. A `create` on an id that is taken fails the whole commit, which is
    // exactly the behaviour a UNIQUE column has in Postgres.
    const client = getDb();
    const write = () => {
      const batch = client.batch();
      batch.create(client.collection(collection).doc(id), data);
      for (const held of wanted) {
        batch.create(reservationRef(held.id), {
          collection, field: toSnake(held.field), value: String(held.value), docId: id,
        });
      }
      return batch.commit();
    };

    try {
      await write();
    } catch (err) {
      if (!ALREADY_EXISTS.has(err?.code)) throw err;

      // Which of them clashed? Worth the extra reads: "that email is taken" and
      // "that id exists" send the caller to completely different places. And a
      // claim whose owner is gone is debris from an interrupted write, not a
      // conflict -- clear it and try once more.
      const stale = [];
      for (const held of wanted) {
        if (await reservationIsLive(held)) throw fieldConflict(collection, held.field, held.value);
        stale.push(held.id);
      }

      if (stale.length === 0) throw asUniqueViolation(err, collection, id);

      await releaseReservations(stale);
      try {
        await write();
      } catch (retryErr) {
        throw asUniqueViolation(retryErr, collection, id);
      }
    }

    return { id, ...data };
  },

  async update(collection, id, patch) {
    const ref = getDb().collection(collection).doc(String(id));
    const data = sanitize(collection, patch);
    delete data.id;

    const existing = await ref.get();
    if (!existing.exists) return null;

    if (Object.keys(data).length > 0) {
      // A unique value being changed has to move its reservation with it --
      // claim the new one, release the old. Skipped entirely when the patch
      // touches no unique field, which is almost every update.
      const before = docToObj(existing);
      const moving = reservationsFor(collection, data).filter(
        (held) => String(before[held.field] ?? '') !== String(held.value),
      );

      if (moving.length === 0) {
        await ref.update(data);
      } else {
        const client = getDb();
        const batch = client.batch();
        batch.update(ref, data);
        for (const held of moving) {
          batch.create(reservationRef(held.id), {
            collection, field: toSnake(held.field), value: String(held.value), docId: String(id),
          });
        }

        try {
          await batch.commit();
        } catch (err) {
          if (!ALREADY_EXISTS.has(err?.code)) throw err;
          const clash = moving.find(() => true);
          throw fieldConflict(collection, clash.field, clash.value);
        }

        // Only once the new claim is safely committed. The other order would
        // free a value while the row that owns it still carries it.
        await releaseReservations(
          moving
            .filter((held) => before[held.field])
            .map((held) => reservationId(collection, held.field, before[held.field])),
        );
      }
    }

    const after = await ref.get();
    return docToObj(after);
  },

  async remove(collection, id) {
    const ref = getDb().collection(collection).doc(String(id));
    const existing = await ref.get();
    if (!existing.exists) return false;
    const held = reservationIdsForRows(collection, [docToObj(existing)]);
    await ref.delete();
    // After the row is gone: a reservation outliving its row blocks the value
    // forever, which is worse than one that is briefly free.
    await releaseReservations(held);
    return true;
  },

  async removeWhere(collection, predicate) {
    const rows = await firestoreDb.filter(collection, predicate);
    const held = reservationIdsForRows(collection, rows);
    await deleteAll(collection, rows.map((r) => r.id));
    await releaseReservations(held);
    return rows.length;
  },

  async incrementIfBelow(collection, id, field, max) {
    const key = toCamel(toSnake(field));
    const ref = getDb().collection(collection).doc(String(id));

    return getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;

      const current = Number(doc.data()[key] ?? 0);
      if (current >= max) return null;

      tx.update(ref, { [key]: current + 1 });
      return { id: doc.id, ...doc.data(), [key]: current + 1 };
    });
  },

  async pruneExpiredOtps() {
    const snap = await getDb().collection('otp_codes').where('expiresAt', '<', Date.now()).get();
    await deleteAll('otp_codes', snap.docs.map((d) => d.id));
  },

  async invalidateUserOtps(userId) {
    const snap = await getDb().collection('otp_codes').where('userId', '==', userId).get();
    const ids = snap.docs.filter((d) => d.data().consumed !== true).map((d) => d.id);
    await deleteAll('otp_codes', ids);
  },

  async pruneExpiredLoginLinks() {
    const snap = await getDb().collection('login_links').where('expiresAt', '<', Date.now()).get();
    await deleteAll('login_links', snap.docs.map((d) => d.id));
  },

  async invalidateUserLoginLinks(userId) {
    const snap = await getDb().collection('login_links').where('userId', '==', userId).get();
    const ids = snap.docs.filter((d) => d.data().consumed !== true).map((d) => d.id);
    await deleteAll('login_links', ids);
  },

  /**
   * Mark a link used, but only if it was not already. Runs in a transaction so
   * two clicks arriving together cannot both succeed -- the second one reads
   * consumed = true and gets null.
   */
  async consumeLoginLink(id) {
    const ref = getDb().collection('login_links').doc(String(id));
    return getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      if (doc.data().consumed === true) return null;
      tx.update(ref, { consumed: true });
      return { id: doc.id, ...doc.data(), consumed: true };
    });
  },

  /** Single-use password-setup link, same transaction guard as above. */
  async consumePasswordToken(id) {
    const ref = getDb().collection('password_tokens').doc(String(id));
    return getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      if (doc.data().consumed === true) return null;
      const consumedAt = Date.now();
      tx.update(ref, { consumed: true, consumedAt });
      return { id: doc.id, ...doc.data(), consumed: true, consumedAt };
    });
  },

  async pruneExpiredPasswordTokens() {
    const snap = await getDb().collection('password_tokens').where('expiresAt', '<', Date.now()).get();
    await deleteAll('password_tokens', snap.docs.map((d) => d.id));
  },

  async invalidateUserPasswordTokens(userId, purpose = null) {
    const snap = await getDb().collection('password_tokens').where('userId', '==', userId).get();
    const ids = snap.docs
      .filter((d) => d.data().consumed !== true && (!purpose || d.data().purpose === purpose))
      .map((d) => d.id);
    await deleteAll('password_tokens', ids);
  },

  /**
   * Take ownership of a scheduled delivery, once. The transaction is what stops
   * two instances sweeping at the same moment from both sending the email.
   */
  async claimCredentialDelivery(id) {
    const ref = getDb().collection('credential_deliveries').doc(String(id));
    return getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const data = doc.data();
      if (data.status !== 'scheduled') return null;
      const now = Date.now();
      const patch = {
        status: 'sending',
        claimedAt: now,
        lastAttemptAt: now,
        attempts: Number(data.attempts || 0) + 1,
      };
      tx.update(ref, patch);
      return { id: doc.id, ...data, ...patch };
    });
  },

  /** Hand back a claim whose process died before it reached a conclusion. */
  async releaseStaleCredentialClaims(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    const snap = await getDb().collection('credential_deliveries').where('status', '==', 'sending').get();
    const stale = snap.docs.filter((d) => Number(d.data().claimedAt || 0) < cutoff);
    const client = getDb();
    for (let i = 0; i < stale.length; i += 450) {
      const batch = client.batch();
      for (const doc of stale.slice(i, i + 450)) {
        batch.update(doc.ref, { status: 'scheduled', claimedAt: null });
      }
      await batch.commit();
    }
    return stale.map((d) => ({ id: d.id, ...d.data(), status: 'scheduled' }));
  },

  /** See the Postgres driver: the one-text-per-task claim. */
  async claimTaskSend(id, at) {
    const ref = getDb().collection('sms_tasks').doc(String(id));
    return getDb().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return null;
      const data = doc.data();
      if (data.sentAt) return null;
      const patch = { sentAt: at, updatedAt: at };
      tx.update(ref, patch);
      return { id: doc.id, ...data, ...patch };
    });
  },

  /** See the Postgres driver: hand back a claim that never became a text. */
  async releaseTaskSend(id) {
    const ref = getDb().collection('sms_tasks').doc(String(id));
    const doc = await ref.get();
    if (!doc.exists) return null;
    const patch = { sentAt: null, updatedAt: new Date().toISOString() };
    await ref.update(patch);
    return { id: doc.id, ...doc.data(), ...patch };
  },
};

async function deleteAll(collection, ids) {
  const client = getDb();
  for (let i = 0; i < ids.length; i += 450) {
    const batch = client.batch();
    for (const id of ids.slice(i, i + 450)) {
      batch.delete(client.collection(collection).doc(String(id)));
    }
    await batch.commit();
  }
}

async function initSchema() {
  const client = getDb();
  await client.collection('users').limit(1).get();
}

module.exports = {
  db: firestoreDb,
  initSchema,
  getDb,
  // The pure half of the uniqueness machinery, exported so it can be tested
  // without a Firestore to talk to. Everything else here needs a connection.
  UNIQUE_KEYS,
  reservationId,
  reservationsFor,
};
