'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');

const COLLECTIONS = ['users', 'projects', 'tasks', 'tickets', 'notifications', 'sessions', 'activity_log'];

function filePath(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll(collection) {
  const fp = filePath(collection);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAll(collection, arr) {
  ensureDataDir();
  fs.writeFileSync(filePath(collection), JSON.stringify(arr, null, 2));
}

const db = {
  all(collection) {
    return loadAll(collection);
  },
  find(collection, id) {
    return loadAll(collection).find((row) => row.id === id) || null;
  },
  filter(collection, predicate) {
    return loadAll(collection).filter(predicate);
  },
  insert(collection, obj) {
    const rows = loadAll(collection);
    const row = { id: obj.id || uuidv4(), ...obj };
    rows.push(row);
    saveAll(collection, rows);
    return row;
  },
  update(collection, id, patch) {
    const rows = loadAll(collection);
    const idx = rows.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    saveAll(collection, rows);
    return rows[idx];
  },
  remove(collection, id) {
    const rows = loadAll(collection);
    const next = rows.filter((row) => row.id !== id);
    saveAll(collection, next);
    return rows.length !== next.length;
  },
  removeWhere(collection, predicate) {
    const rows = loadAll(collection);
    const next = rows.filter((row) => !predicate(row));
    saveAll(collection, next);
    return rows.length - next.length;
  },
};

function isSeeded() {
  return fs.existsSync(filePath('users')) && loadAll('users').length > 0;
}

function seed() {
  if (isSeeded()) return;
  ensureDataDir();

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const users = [
    { id: 'u-admin', name: 'Admin User', email: 'admin@ethixweb.local', role: 'admin', password: hash('Admin#2026!'), demoPassword: 'Admin#2026!' },
    { id: 'u-sales', name: 'Emily Turner', email: 'emily.turner@ethixweb.local', role: 'sales', password: hash('Sales#2026!'), demoPassword: 'Sales#2026!' },
    { id: 'u-pm', name: 'Ryan Coleman', email: 'ryan.coleman@ethixweb.local', role: 'project_manager', password: hash('Manager#2026!'), demoPassword: 'Manager#2026!' },
    { id: 'u-employee', name: 'Jordan Brooks', email: 'jordan.brooks@ethixweb.local', role: 'employee', password: hash('Staff#2026!'), demoPassword: 'Staff#2026!' },
    { id: 'u-client', name: 'David Shaw', email: 'client@brightpath-retail.com', role: 'client', company: 'BrightPath Retail Co.', password: hash('Client#2026!'), demoPassword: 'Client#2026!' },
  ];
  saveAll('users', users);

  const projects = [
    {
      id: 'proj-1', name: 'BrightPath Website Redesign', type: 'Website', clientId: 'u-client',
      assignedPmId: 'u-pm', status: 'In Progress', description: 'Full marketing site redesign with new booking flow.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'proj-2', name: 'BrightPath Mobile App', type: 'Mobile App', clientId: 'u-client',
      assignedPmId: 'u-pm', status: 'On Track', description: 'iOS/Android app for loyalty rewards and in-store pickup.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'proj-3', name: 'Q3 Paid Social Campaign', type: 'Digital Marketing', clientId: 'u-client',
      assignedPmId: 'u-pm', status: 'On Track', description: 'Meta + Google Ads campaign for the fall product launch.',
      createdAt: new Date().toISOString(),
    },
  ];
  saveAll('projects', projects);

  const tasks = [
    { id: 'task-1', projectId: 'proj-1', name: 'Homepage hero redesign', assigneeId: 'u-employee', status: 'In Progress', priority: 'High', due: daysFromNow(5) },
    { id: 'task-2', projectId: 'proj-1', name: 'Booking flow wireframes', assigneeId: 'u-employee', status: 'To Do', priority: 'Medium', due: daysFromNow(10) },
    { id: 'task-3', projectId: 'proj-2', name: 'App store listing assets', assigneeId: 'u-employee', status: 'In Review', priority: 'High', due: daysFromNow(3) },
    { id: 'task-4', projectId: 'proj-3', name: 'Ad creative — carousel set', assigneeId: 'u-employee', status: 'Complete', priority: 'Low', due: daysFromNow(-2) },
  ];
  saveAll('tasks', tasks);

  const tickets = [
    {
      id: 'ticket-1001', subject: 'Homepage CTA button not linking correctly', category: 'Website',
      clientId: 'u-client', assigneeId: 'u-employee', status: 'Open', createdAt: new Date().toISOString(),
      description: 'The "Book Now" button on mobile leads to a 404 page.',
    },
    {
      id: 'ticket-1002', subject: 'Request to add new landing page for fall promo', category: 'Marketing',
      clientId: 'u-client', assigneeId: 'u-pm', status: 'In Progress', createdAt: new Date().toISOString(),
      description: 'Need a dedicated landing page for the fall promo campaign.',
    },
  ];
  saveAll('tickets', tickets);

  const notifications = [
    { id: uuidv4(), userId: 'u-employee', message: 'You were assigned a new task: "Homepage hero redesign"', type: 'task', read: false, createdAt: new Date().toISOString() },
    { id: uuidv4(), userId: 'u-pm', message: 'New ticket opened: "Homepage CTA button not linking correctly"', type: 'ticket', read: false, createdAt: new Date().toISOString() },
    { id: uuidv4(), userId: 'u-client', message: 'Your project "BrightPath Website Redesign" moved to In Progress', type: 'project', read: true, createdAt: new Date().toISOString() },
  ];
  saveAll('notifications', notifications);

  saveAll('sessions', []);
  saveAll('activity_log', []);
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

module.exports = { db, seed, COLLECTIONS };
