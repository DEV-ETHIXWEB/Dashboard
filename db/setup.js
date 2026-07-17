'use strict';

// Postgres-backed database layer. Works with Vercel Postgres, Neon, Supabase,
// or any standard Postgres connection string via DATABASE_URL.
//
// Route files call the same db.find/insert/update/remove API as before (now
// async), and objects still use camelCase JS property names (clientId,
// createdAt, etc.) -- this module handles the camelCase <-> snake_case
// column mapping so nothing else in the app had to change shape.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. See .env.example / README for setup steps.');
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

// Column list per "collection" (table). Only keys present here are ever
// read from / written to the database for that collection.
const SCHEMAS = {
  users: ['id', 'name', 'email', 'role', 'company', 'password', 'google_id', 'two_factor_enabled', 'two_factor_contact'],
  projects: ['id', 'name', 'type', 'client_id', 'assigned_pm_id', 'status', 'description', 'created_at'],
  tasks: ['id', 'project_id', 'name', 'assignee_id', 'status', 'priority', 'due'],
  tickets: ['id', 'subject', 'category', 'client_id', 'assignee_id', 'status', 'description', 'created_at'],
  notifications: ['id', 'user_id', 'message', 'type', 'read', 'created_at'],
  sessions: ['id', 'user_id', 'csrf_token', 'created_at', 'expires_at', 'pending'],
  activity_log: ['id', 'actor_id', 'action', 'entity', 'entity_id', 'meta', 'created_at'],
  domains: [
    'id', 'client_id', 'domain_name', 'platform', 'hosting_provider', 'hosting_region',
    'registrar', 'ssl_status', 'expires_at', 'auto_renew', 'dns_status', 'notes',
  ],
  reports: [
    'id', 'client_id', 'name', 'category', 'storage_type', 'drive_file_id', 'drive_link',
    'content_base64', 'mime_type', 'size_bytes', 'uploaded_by', 'created_at',
  ],
  budget_items: ['id', 'client_id', 'label', 'amount', 'color', 'month'],
  billing: ['id', 'client_id', 'stripe_customer_id', 'stripe_subscription_id', 'plan', 'status', 'updated_at'],
};

function toSnake(str) { return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function toCamel(str) { return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

function rowToCamel(row, collection) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] = v;
  }
  if ('meta' in out && typeof out.meta === 'string') {
    try { out.meta = JSON.parse(out.meta); } catch { /* leave as-is */ }
  }
  if ('createdAt' in out && typeof out.createdAt === 'object' && out.createdAt instanceof Date) {
    out.createdAt = out.createdAt.toISOString();
  }
  // Only the sessions table stores expiresAt/createdAt as millisecond
  // timestamps -- domains stores expiresAt as a human-readable date string
  // ("Aug 23, 2026"), so this coercion must not apply to every table.
  if (collection === 'sessions') {
    if ('expiresAt' in out) out.expiresAt = Number(out.expiresAt);
    if ('createdAt' in out) out.createdAt = Number(out.createdAt);
  }
  if ('amount' in out && out.amount !== null) out.amount = Number(out.amount);
  if ('sizeBytes' in out && out.sizeBytes !== null) out.sizeBytes = Number(out.sizeBytes);
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
    entries.push([snakeKey, value]);
  }
  return entries;
}

const db = {
  async all(collection) {
    const res = await getPool().query(`SELECT * FROM ${collection}`);
    return res.rows.map((row) => rowToCamel(row, collection));
  },
  async find(collection, id) {
    const res = await getPool().query(`SELECT * FROM ${collection} WHERE id = $1`, [id]);
    return rowToCamel(res.rows[0], collection) || null;
  },
  async filter(collection, predicate) {
    const rows = await db.all(collection);
    return rows.filter(predicate);
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
    if (entries.length === 0) return db.find(collection, id);
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
    const rows = await db.filter(collection, predicate);
    for (const row of rows) await db.remove(collection, row.id);
    return rows.length;
  },
};

async function initSchema() {
  const p = getPool();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, company TEXT, password TEXT, google_id TEXT,
      two_factor_enabled BOOLEAN DEFAULT FALSE, two_factor_contact TEXT
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
      assignee_id TEXT, status TEXT, description TEXT, created_at TEXT
    )`,
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
  ];
  for (const sql of statements) await p.query(sql);

  // Safe, idempotent migrations for databases created before these columns
  // existed (e.g. your already-deployed Vercel database).
  const alterations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_contact TEXT`,
    `ALTER TABLE users ALTER COLUMN password DROP NOT NULL`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending BOOLEAN DEFAULT FALSE`,
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
      db.insert('users', { id: 'u-admin', name: 'Admin User', email: 'admin@ethixweb.local', role: 'admin', password: hash('Admin#2026!') }),
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
      db.insert('tasks', { id: 'task-4', projectId: 'proj-3', name: 'Ad creative — carousel set', assigneeId: 'u-employee', status: 'Complete', priority: 'Low', due: daysFromNow(-2) }),
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
        id: 'rep-2', clientId: 'u-client', name: 'SEO Audit — Q2 2026', category: 'SEO',
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

module.exports = { db, seed, initSchema, getPool, SCHEMAS };
