'use strict';

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
const pgAdapter = mem.adapters.createPg();

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';

// This database exists for the length of one process and is thrown away, so the
// demo workspace is exactly what it wants. Production seeds nothing without
// SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD -- see seed() in db/setup.js.
process.env.SEED_DEMO_DATA = 'true';

module.exports = { mem };
