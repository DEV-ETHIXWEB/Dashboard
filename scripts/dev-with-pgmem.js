'use strict';

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
const pgAdapter = mem.adapters.createPg();

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake:fake@localhost/fake';

module.exports = { mem };
