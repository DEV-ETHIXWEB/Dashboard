'use strict';

const { v4: uuidv4 } = require('uuid');
const { toSnake, toCamel, isWritableField } = require('./schemas');

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
    await getDb().collection(collection).doc(id).set(data);
    return { id, ...data };
  },

  async update(collection, id, patch) {
    const ref = getDb().collection(collection).doc(String(id));
    const data = sanitize(collection, patch);
    delete data.id;

    const existing = await ref.get();
    if (!existing.exists) return null;
    if (Object.keys(data).length > 0) await ref.update(data);

    const after = await ref.get();
    return docToObj(after);
  },

  async remove(collection, id) {
    const ref = getDb().collection(collection).doc(String(id));
    const existing = await ref.get();
    if (!existing.exists) return false;
    await ref.delete();
    return true;
  },

  async removeWhere(collection, predicate) {
    const rows = await firestoreDb.filter(collection, predicate);
    await deleteAll(collection, rows.map((r) => r.id));
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

module.exports = { db: firestoreDb, initSchema, getDb };
