'use strict';

// Dev convenience: lets you run/test the whole app WITHOUT a real Postgres
// connection, by monkey-patching every `require('pg')` to resolve to an
// in-memory Postgres emulator instead. Useful for trying things out before
// you've set up a real database, or for quick local testing.
//
// Usage:  npm run dev:pgmem
//
// This is dev-tooling only -- nothing in the actual app (server.js,
// routes/*, db/setup.js) requires pg-mem or knows it exists. Swap
// DATABASE_URL to a real connection string and everything works exactly
// the same way against real Postgres.

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
const pgAdapter = mem.adapters.createPg();

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';

module.exports = { mem };
