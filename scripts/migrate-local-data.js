'use strict';

// Copies your existing local db/data/*.json files into the Postgres
// database pointed to by DATABASE_URL, preserving all existing IDs.
//
// Usage:
//   DATABASE_URL="postgres://..." npm run migrate
//
// Safe to run once against a fresh database. Re-running it after data
// already exists will fail on duplicate primary keys (by design, so you
// don't accidentally double-insert) -- wipe the tables first if you need
// to re-run it.

const fs = require('fs');
const path = require('path');
const { db, initSchema } = require('../db/setup');

const DATA_DIR = path.join(__dirname, '..', 'db', 'data');
const COLLECTIONS = ['users', 'projects', 'tasks', 'tickets', 'notifications', 'sessions', 'activity_log'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Example:');
    console.error('  DATABASE_URL="postgres://user:pass@host/db" npm run migrate');
    if (require.main === module) process.exit(1);
    throw new Error('DATABASE_URL is not set');
  }

  if (!fs.existsSync(DATA_DIR)) {
    console.log(`No local data found at ${DATA_DIR} -- nothing to migrate.`);
    console.log('(This is expected if you never ran the app locally, or already cleared it.)');
    return;
  }

  console.log('Creating tables if they do not already exist...');
  await initSchema();

  let totalMigrated = 0;

  for (const collection of COLLECTIONS) {
    const file = path.join(DATA_DIR, `${collection}.json`);
    if (!fs.existsSync(file)) {
      console.log(`- ${collection}: no local file, skipping`);
      continue;
    }

    const rows = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    if (rows.length === 0) {
      console.log(`- ${collection}: local file is empty, skipping`);
      continue;
    }

    let migrated = 0;
    for (const row of rows) {
      try {
        await db.insert(collection, row);
        migrated += 1;
      } catch (err) {
        console.warn(`  ! skipped one row in ${collection} (id=${row.id}): ${err.message}`);
      }
    }
    console.log(`- ${collection}: migrated ${migrated} / ${rows.length} rows`);
    totalMigrated += migrated;
  }

  console.log(`\nDone. Migrated ${totalMigrated} total rows into Postgres.`);
  console.log('Your local db/data/*.json files were not modified or deleted.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { main };
