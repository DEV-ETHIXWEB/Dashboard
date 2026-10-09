'use strict';

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
const pgAdapter = mem.adapters.createPg();

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';

/**
 * Tell db/setup.js it is talking to pg-mem rather than Postgres.
 *
 * There is one thing pg-mem gets wrong that we cannot work around in the
 * application: it will answer an ordinary `WHERE client_id = $1` out of a
 * *partial* index declared `WHERE status = 'active'`, and so silently returns
 * only the active rows. Real Postgres only uses a partial index when the
 * query's own predicate implies the index's, so this is a bug in the test
 * engine and not in the schema or the queries.
 *
 * It matters because it does not fail loudly. Every read of a client's
 * subscription history under the test harness would quietly lose their
 * pending, scheduled and cancelled rows, and the suite would be proving
 * something that is not true of production.
 */
process.env.PG_MEM = '1';

// This database exists for the length of one process and is thrown away, so the
// demo workspace is exactly what it wants. Production seeds nothing without
// SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD -- see seed() in db/setup.js.
process.env.SEED_DEMO_DATA = 'true';

module.exports = { mem };
