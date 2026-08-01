'use strict';

const { getPool, SCHEMAS, DB_DRIVER } = require('../db/setup');

function mask(url) {
  return String(url).replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
}

function explain(err, url) {
  const code = err.code || '';
  const msg = err.message || '';

  if (!url) return 'DATABASE_URL is not set. Add it to .env (see .env.example).';
  if (code === 'ENOTFOUND') {
    return 'Host not found. Check the hostname; if you copied the "Direct connection" string\n' +
      '  from Supabase, it is IPv6-only on newer projects -- use the Transaction pooler\n' +
      '  (port 6543) or Session pooler instead.';
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return 'Connection timed out. Usually a firewall/network block, or an IPv6-only direct\n' +
      '  connection string. Try the pooler endpoint (port 6543).';
  }
  if (code === 'ECONNREFUSED') return 'Connection refused -- nothing is listening on that host/port.';
  if (/password authentication failed/i.test(msg)) {
    return 'Wrong password. If it contains @ # / or other special characters they must be\n' +
      '  percent-encoded in the URL (@ -> %40, # -> %23, / -> %2F).';
  }
  if (/Tenant or user not found/i.test(msg)) {
    return 'Supabase pooler rejected the username. It must include the project ref, i.e.\n' +
      '  postgres.<project-ref>, not just "postgres".';
  }
  if (/self.signed|certificate/i.test(msg)) return 'TLS certificate problem verifying the server.';
  return null;
}

(async () => {
  const url = process.env.DATABASE_URL;
  console.log(`driver:        ${DB_DRIVER}`);
  console.log(`DATABASE_URL:  ${url ? mask(url) : '(not set)'}`);

  if (DB_DRIVER !== 'postgres') {
    console.log('\nDB_DRIVER is not "postgres" -- nothing to check here.');
    process.exit(0);
  }

  const startedAt = Date.now();
  try {
    const pool = getPool();
    const info = await pool.query(
      'SELECT version() AS version, current_database() AS db, current_user AS "user"',
    );
    const { version, db, user } = info.rows[0];
    console.log(`\nCONNECTED in ${Date.now() - startedAt}ms`);
    console.log(`  server:      ${version.split(' on ')[0]}`);
    console.log(`  database:    ${db}`);
    console.log(`  user:        ${user}`);

    const expected = Object.keys(SCHEMAS);
    const present = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [expected],
    );
    const found = present.rows.map((r) => r.table_name);
    const missing = expected.filter((t) => !found.includes(t));

    console.log(`\ntables:        ${found.length}/${expected.length} present`);
    if (missing.length) {
      console.log(`  missing:     ${missing.join(', ')}`);
      console.log('  (these are created automatically on the next server start)');
    } else {
      const counts = [];
      for (const t of ['users', 'projects', 'tickets', 'sessions']) {
        const c = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        counts.push(`${t}=${c.rows[0].n}`);
      }
      console.log(`  rows:        ${counts.join('  ')}`);
    }

    await pool.end();
    console.log('\nOK');
    process.exit(0);
  } catch (err) {
    console.error(`\nFAILED after ${Date.now() - startedAt}ms`);
    console.error(`  ${err.code ? err.code + ': ' : ''}${err.message}`);
    const hint = explain(err, url);
    if (hint) console.error(`\nLikely cause:\n  ${hint}`);
    process.exit(1);
  }
})();
