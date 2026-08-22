'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { SCHEMAS, toSnake, toCamel } = require('./schemas');

const DB_DRIVER =
  process.env.DB_DRIVER ||
  (!process.env.DATABASE_URL && process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? 'firestore' : 'postgres');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. See .env.example / README for setup steps.');
    }

    const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(connectionString);

    pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on('error', (err) => {
      console.error('[db] idle client error (connection dropped, pool recovers):', err.message);
    });
  }
  return pool;
}

function rowToCamel(row, collection) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] = v;
  }
  if ('meta' in out && typeof out.meta === 'string') {
    try { out.meta = JSON.parse(out.meta); } catch { /* leave as-is */ }
  }
  if ('allowedPages' in out && typeof out.allowedPages === 'string') {
    try { out.allowedPages = JSON.parse(out.allowedPages); } catch { out.allowedPages = null; }
  }
  if ('createdAt' in out && typeof out.createdAt === 'object' && out.createdAt instanceof Date) {
    out.createdAt = out.createdAt.toISOString();
  }
  if (collection === 'sessions') {
    if ('expiresAt' in out) out.expiresAt = Number(out.expiresAt);
    if ('createdAt' in out) out.createdAt = Number(out.createdAt);
  }
  if ('amount' in out && out.amount !== null) out.amount = Number(out.amount);
  if ('sizeBytes' in out && out.sizeBytes !== null) out.sizeBytes = Number(out.sizeBytes);
  if ('passwordExpiresAt' in out && out.passwordExpiresAt !== null) out.passwordExpiresAt = Number(out.passwordExpiresAt);
  if ('responseDueAt' in out && out.responseDueAt !== null) out.responseDueAt = Number(out.responseDueAt);
  if ('firstResponseAt' in out && out.firstResponseAt !== null) out.firstResponseAt = Number(out.firstResponseAt);
  if ('resolvedNotifiedAt' in out && out.resolvedNotifiedAt !== null) out.resolvedNotifiedAt = Number(out.resolvedNotifiedAt);
  return out;
}

function objToSnakeEntries(collection, obj) {
  const cols = SCHEMAS[collection];
  const entries = [];
  for (const [k, v] of Object.entries(obj)) {
    const snakeKey = toSnake(k);
    if (!cols.includes(snakeKey)) continue;
    let value = v;
    if (k === 'meta' && value !== null && typeof value === 'object') value = JSON.stringify(value);
    if (k === 'allowedPages' && Array.isArray(value)) value = JSON.stringify(value);
    entries.push([snakeKey, value]);
  }
  return entries;
}

const pgDb = {
  async all(collection) {
    const res = await getPool().query(`SELECT * FROM ${collection}`);
    return res.rows.map((row) => rowToCamel(row, collection));
  },
  async find(collection, id) {
    const res = await getPool().query(`SELECT * FROM ${collection} WHERE id = $1`, [id]);
    return rowToCamel(res.rows[0], collection) || null;
  },
  async filter(collection, predicate) {
    const rows = await pgDb.all(collection);
    return rows.filter(predicate);
  },
  async recent(collection, limit = 100) {
    const res = await getPool().query(`SELECT * FROM ${collection} ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map((row) => rowToCamel(row, collection));
  },
  async insert(collection, obj) {
    const row = { id: obj.id || uuidv4(), ...obj };
    const entries = objToSnakeEntries(collection, row);
    const cols = entries.map(([k]) => k);
    const placeholders = entries.map((_, i) => `$${i + 1}`);
    const values = entries.map(([, v]) => v);
    const res = await getPool().query(
      `INSERT INTO ${collection} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    return rowToCamel(res.rows[0], collection);
  },
  async update(collection, id, patch) {
    const entries = objToSnakeEntries(collection, patch).filter(([k]) => k !== 'id');
    if (entries.length === 0) return pgDb.find(collection, id);
    const setClause = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    const values = entries.map(([, v]) => v);
    const res = await getPool().query(
      `UPDATE ${collection} SET ${setClause} WHERE id = $${entries.length + 1} RETURNING *`,
      [...values, id]
    );
    return rowToCamel(res.rows[0], collection) || null;
  },
  async remove(collection, id) {
    const res = await getPool().query(`DELETE FROM ${collection} WHERE id = $1`, [id]);
    return res.rowCount > 0;
  },
  async removeWhere(collection, predicate) {
    const rows = await pgDb.filter(collection, predicate);
    for (const row of rows) await pgDb.remove(collection, row.id);
    return rows.length;
  },
  async incrementIfBelow(collection, id, field, max) {
    const col = toSnake(field);
    const res = await getPool().query(
      `UPDATE ${collection} SET ${col} = ${col} + 1 WHERE id = $1 AND ${col} < $2 RETURNING *`,
      [id, max]
    );
    return rowToCamel(res.rows[0], collection) || null;
  },
  async pruneExpiredOtps() {
    await getPool().query(`DELETE FROM otp_codes WHERE expires_at < $1`, [Date.now()]);
  },
  async invalidateUserOtps(userId) {
    await getPool().query(`DELETE FROM otp_codes WHERE user_id = $1 AND consumed = FALSE`, [userId]);
  },
  async pruneExpiredLoginLinks() {
    await getPool().query(`DELETE FROM login_links WHERE expires_at < $1`, [Date.now()]);
  },
  async invalidateUserLoginLinks(userId) {
    await getPool().query(`DELETE FROM login_links WHERE user_id = $1 AND consumed = FALSE`, [userId]);
  },
  /**
   * Mark a link used, but only if it was not already. The UPDATE ... WHERE
   * consumed = FALSE is the whole single-use guarantee: two clicks arriving at
   * once means one of them gets no row back and is rejected.
   */
  async consumeLoginLink(id) {
    const res = await getPool().query(
      `UPDATE login_links SET consumed = TRUE WHERE id = $1 AND consumed = FALSE RETURNING *`,
      [id]
    );
    return rowToCamel(res.rows[0], 'login_links') || null;
  },
};

const firestore = DB_DRIVER === 'firestore' ? require('./firestore') : null;
const db = firestore ? firestore.db : pgDb;

async function initSchema() {
  if (firestore) return firestore.initSchema();
  return initPostgresSchema();
}

async function initPostgresSchema() {
  const p = getPool();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, company TEXT, password TEXT, google_id TEXT,
      two_factor_enabled BOOLEAN DEFAULT FALSE, two_factor_contact TEXT,
      password_expires_at BIGINT, allowed_pages TEXT,
      slack_channel_id TEXT, slack_channel_name TEXT,
      is_super_admin BOOLEAN DEFAULT FALSE,
      admin_trusted BOOLEAN DEFAULT FALSE, admin_trusted_at TEXT, admin_trusted_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, client_id TEXT,
      assigned_pm_id TEXT, status TEXT, description TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, assignee_id TEXT,
      status TEXT, priority TEXT, due TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, category TEXT, client_id TEXT,
      assignee_id TEXT, status TEXT, description TEXT, created_at TEXT,
      clickup_task_id TEXT, clickup_task_url TEXT,
      progress INTEGER DEFAULT 0, stage TEXT,
      priority TEXT, response_due_at BIGINT, first_response_at BIGINT,
      slack_channel_id TEXT, slack_thread_ts TEXT, resolved_notified_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_updates (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, author_id TEXT, kind TEXT NOT NULL,
      body TEXT, progress INTEGER, stage TEXT, target_user_id TEXT, status TEXT,
      created_at TEXT, resolved_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_collaborators (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, user_id TEXT NOT NULL,
      added_by TEXT, created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_updates_ticket ON ticket_updates(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_collaborators_ticket ON ticket_collaborators(ticket_id)`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT, message TEXT, type TEXT,
      read BOOLEAN DEFAULT FALSE, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT, csrf_token TEXT,
      created_at BIGINT, expires_at BIGINT, pending BOOLEAN DEFAULT FALSE
    )`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY, actor_id TEXT, action TEXT, entity TEXT,
      entity_id TEXT, meta TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY, client_id TEXT, domain_name TEXT NOT NULL, platform TEXT,
      hosting_provider TEXT, hosting_region TEXT, registrar TEXT, ssl_status TEXT,
      expires_at TEXT, auto_renew BOOLEAN DEFAULT FALSE, dns_status TEXT, notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, client_id TEXT, name TEXT NOT NULL, category TEXT,
      storage_type TEXT DEFAULT 'database', drive_file_id TEXT, drive_link TEXT,
      content_base64 TEXT, mime_type TEXT, size_bytes BIGINT, uploaded_by TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS budget_items (
      id TEXT PRIMARY KEY, client_id TEXT, label TEXT NOT NULL, amount NUMERIC,
      color TEXT, month TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS billing (
      id TEXT PRIMARY KEY, client_id TEXT UNIQUE, stripe_customer_id TEXT,
      stripe_subscription_id TEXT, plan TEXT, status TEXT, updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, client_id TEXT, stripe_customer_id TEXT,
      stripe_object_id TEXT UNIQUE, kind TEXT, description TEXT,
      amount NUMERIC, currency TEXT, status TEXT, paid_at TEXT,
      period_start TEXT, period_end TEXT, invoice_url TEXT, receipt_url TEXT,
      invoice_number TEXT, card_brand TEXT, card_last4 TEXT,
      failure_message TEXT, created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments(paid_at DESC)`,
    `CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, summary TEXT, payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT, requested_at TEXT, expires_at BIGINT,
      decided_by TEXT, decided_at TEXT, decision_note TEXT,
      executed_at TEXT, execution_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_approval_requests_requested_at ON approval_requests(requested_at DESC)`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT NOT NULL, ip_address TEXT,
      created_at TEXT, expires_at BIGINT, consumed BOOLEAN DEFAULT FALSE, attempts INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_otp_codes_user_id ON otp_codes(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_otp_codes_created_at ON otp_codes(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS login_links (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, ip_address TEXT,
      created_at TEXT, expires_at BIGINT, consumed BOOLEAN DEFAULT FALSE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_login_links_user_id ON login_links(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_login_links_created_at ON login_links(created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, to_emails TEXT, subject TEXT, template TEXT, status TEXT,
      transport TEXT, error TEXT, entity TEXT, entity_id TEXT, html TEXT, created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_email_log_created_at ON email_log(created_at DESC)`,
  ];
  for (const sql of statements) await p.query(sql);

  const alterations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_contact TEXT`,
    `ALTER TABLE users ALTER COLUMN password DROP NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_expires_at BIGINT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS clickup_task_id TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS clickup_task_url TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS stage TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_pages TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due_at BIGINT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at BIGINT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS slack_channel_id TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS slack_thread_ts TEXT`,
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_notified_at BIGINT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS currency TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS amount NUMERIC`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS interval TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS current_period_end TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS card_brand TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS card_last4 TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS latest_invoice_url TEXT`,
    `ALTER TABLE billing ADD COLUMN IF NOT EXISTS synced_at TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_trusted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_trusted_at TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_trusted_by TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_channel_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_channel_name TEXT`,
  ];
  for (const sql of alterations) {
    try {
      await p.query(sql);
    } catch (err) {
      console.warn(`Schema migration skipped (${sql}): ${err.message}`);
    }
  }
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

async function seed() {
  await initSchema();

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const usersEmpty = (await db.all('users')).length === 0;

  if (usersEmpty) {
    await Promise.all([
      // Two admins from the start: this workspace is multi-admin by design, and
      // seeding a single one makes it look like an owner account that cannot
      // be shared. Both have identical powers.
      // The seeded workspace has one super admin and one ordinary admin, so the
      // approval flow is exercised the moment anyone tries it.
      db.insert('users', {
        id: 'u-admin', name: 'Admin User', email: 'admin@ethixweb.local', role: 'admin',
        password: hash('Admin#2026!'), isSuperAdmin: true, adminTrusted: true,
        adminTrustedAt: new Date().toISOString(), adminTrustedBy: 'system',
      }),
      db.insert('users', {
        id: 'u-admin-2', name: 'Priya Nair', email: 'priya.nair@ethixweb.local', role: 'admin',
        password: hash('Admin#2026!'), isSuperAdmin: false, adminTrusted: false,
      }),
      db.insert('users', { id: 'u-sales', name: 'Emily Turner', email: 'emily.turner@ethixweb.local', role: 'sales', password: hash('Sales#2026!') }),
      db.insert('users', { id: 'u-pm', name: 'Ryan Coleman', email: 'ryan.coleman@ethixweb.local', role: 'project_manager', password: hash('Manager#2026!') }),
      db.insert('users', { id: 'u-employee', name: 'Jordan Brooks', email: 'jordan.brooks@ethixweb.local', role: 'employee', password: hash('Staff#2026!') }),
      db.insert('users', { id: 'u-client', name: 'David Shaw', email: 'client@brightpath-retail.com', role: 'client', company: 'BrightPath Retail Co.', password: hash('Client#2026!') }),
    ]);
  }

  if ((await db.all('projects')).length === 0) {
    await Promise.all([
      db.insert('projects', { id: 'proj-1', name: 'BrightPath Website Redesign', type: 'Website', clientId: 'u-client', assignedPmId: 'u-pm', status: 'In Progress', description: 'Full marketing site redesign with new booking flow.', createdAt: new Date().toISOString() }),
      db.insert('projects', { id: 'proj-2', name: 'BrightPath Mobile App', type: 'Mobile App', clientId: 'u-client', assignedPmId: 'u-pm', status: 'On Track', description: 'iOS/Android app for loyalty rewards and in-store pickup.', createdAt: new Date().toISOString() }),
      db.insert('projects', { id: 'proj-3', name: 'Q3 Paid Social Campaign', type: 'Digital Marketing', clientId: 'u-client', assignedPmId: 'u-pm', status: 'On Track', description: 'Meta + Google Ads campaign for the fall product launch.', createdAt: new Date().toISOString() }),
    ]);
  }

  if ((await db.all('tasks')).length === 0) {
    await Promise.all([
      db.insert('tasks', { id: 'task-1', projectId: 'proj-1', name: 'Homepage hero redesign', assigneeId: 'u-employee', status: 'In Progress', priority: 'High', due: daysFromNow(5) }),
      db.insert('tasks', { id: 'task-2', projectId: 'proj-1', name: 'Booking flow wireframes', assigneeId: 'u-employee', status: 'To Do', priority: 'Medium', due: daysFromNow(10) }),
      db.insert('tasks', { id: 'task-3', projectId: 'proj-2', name: 'App store listing assets', assigneeId: 'u-employee', status: 'In Review', priority: 'High', due: daysFromNow(3) }),
      db.insert('tasks', { id: 'task-4', projectId: 'proj-3', name: 'Ad creative - carousel set', assigneeId: 'u-employee', status: 'Complete', priority: 'Low', due: daysFromNow(-2) }),
    ]);
  }

  if ((await db.all('tickets')).length === 0) {
    await Promise.all([
      db.insert('tickets', { id: 'ticket-1001', subject: 'Homepage CTA button not linking correctly', category: 'Website', clientId: 'u-client', assigneeId: 'u-employee', status: 'Open', createdAt: new Date().toISOString(), description: 'The "Book Now" button on mobile leads to a 404 page.' }),
      db.insert('tickets', { id: 'ticket-1002', subject: 'Request to add new landing page for fall promo', category: 'Marketing', clientId: 'u-client', assigneeId: 'u-pm', status: 'In Progress', createdAt: new Date().toISOString(), description: 'Need a dedicated landing page for the fall promo campaign.' }),
    ]);
  }

  if ((await db.all('notifications')).length === 0) {
    await Promise.all([
      db.insert('notifications', { id: uuidv4(), userId: 'u-employee', message: 'You were assigned a new task: "Homepage hero redesign"', type: 'task', read: false, createdAt: new Date().toISOString() }),
      db.insert('notifications', { id: uuidv4(), userId: 'u-pm', message: 'New ticket opened: "Homepage CTA button not linking correctly"', type: 'ticket', read: false, createdAt: new Date().toISOString() }),
      db.insert('notifications', { id: uuidv4(), userId: 'u-client', message: 'Your project "BrightPath Website Redesign" moved to In Progress', type: 'project', read: true, createdAt: new Date().toISOString() }),
    ]);
  }

  if ((await db.all('domains')).length === 0) {
    await Promise.all([
      db.insert('domains', {
        id: 'dom-1', clientId: 'u-client', domainName: 'brightpath-retail.com', platform: 'WordPress',
        hostingProvider: 'EthixWeb Managed Hosting', hostingRegion: 'Washington, D.C., USA (East)',
        registrar: 'Registered with EthixWeb', sslStatus: 'Valid', expiresAt: 'Aug 23, 2026',
        autoRenew: true, dnsStatus: 'Propagated', notes: 'Primary storefront domain.',
      }),
      db.insert('domains', {
        id: 'dom-2', clientId: 'u-client', domainName: 'shop.brightpath-retail.com', platform: 'Shopify',
        hostingProvider: 'Shopify', hostingRegion: 'Global CDN',
        registrar: 'Registered externally', sslStatus: 'Valid', expiresAt: 'Oct 4, 2026',
        autoRenew: true, dnsStatus: 'Propagated', notes: 'Online storefront subdomain.',
      }),
    ]);
  }

  if ((await db.all('reports')).length === 0) {
    await Promise.all([
      db.insert('reports', {
        id: 'rep-1', clientId: 'u-client', name: 'June Performance Report', category: 'Performance',
        storageType: 'database', mimeType: 'application/pdf', sizeBytes: 2100000,
        uploadedBy: 'u-pm', createdAt: new Date().toISOString(),
      }),
      db.insert('reports', {
        id: 'rep-2', clientId: 'u-client', name: 'SEO Audit - Q2 2026', category: 'SEO',
        storageType: 'database', mimeType: 'application/pdf', sizeBytes: 4600000,
        uploadedBy: 'u-pm', createdAt: new Date().toISOString(),
      }),
    ]);
  }

  if ((await db.all('budget_items')).length === 0) {
    const thisMonth = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    await Promise.all([
      db.insert('budget_items', { id: 'bud-1', clientId: 'u-client', label: 'Google Ads', amount: 3520, color: '#ff4438', month: thisMonth }),
      db.insert('budget_items', { id: 'bud-2', clientId: 'u-client', label: 'Local Services Ads', amount: 1600, color: '#ffb020', month: thisMonth }),
      db.insert('budget_items', { id: 'bud-3', clientId: 'u-client', label: 'Social Media Ads', amount: 1280, color: '#ff9d90', month: thisMonth }),
    ]);
  }
}

module.exports = { db, seed, initSchema, getPool, SCHEMAS, DB_DRIVER };
