'use strict';

/* ============ State ============ */
let CURRENT_USER = null;
let CSRF_TOKEN = null;
let ACTIVE_VIEW = 'Dashboard';
let APP_CONFIG = {};
let CACHE = { users: [], projects: [], tasks: [], tickets: [], notifications: [] };

/* ============ API helper ============ */
async function api(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  };
  if (CSRF_TOKEN && method !== 'GET') opts.headers['X-CSRF-Token'] = CSRF_TOKEN;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401) {
    window.location.href = '/index.html';
    return Promise.reject(new Error('Not signed in'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ============ Icons (inline SVG, stroke style) ============ */
const ICONS = {
  Dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  Projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  Tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  Tickets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="3.5"/></svg>',
  Team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  Notifications: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  Domains: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 4 6 4 9.5s-1.4 6.8-4 9.5c-2.6-2.7-4-6-4-9.5s1.4-6.8 4-9.5z"/></svg>',
  Reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>',
  Budget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>',
  Billing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="15" rx="2.2"/><path d="M2 9.5h20"/></svg>',
  Settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const PILL_SVG = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.5 15A9 9 0 1 1 19 5.6L23 10"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4L12 14.01l-3-3"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a5 5 0 1 1 1.7-9.7 6 6 0 0 1 11.3 3A4.5 4.5 0 0 1 21 19h-3.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-6-5z"/><path d="M13 3v5h5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M12 18h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.2"/><path d="M22 6.5l-10 7L2 6.5"/></svg>',
  barChart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>',
  pieChart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.2 15.3A10 10 0 1 1 12 2v10z"/></svg>',
};

const ROLE_LABEL = { admin: 'Admin', sales: 'Sales', project_manager: 'Project Manager', employee: 'Employee', client: 'Client' };
const ROLE_NAV = {
  admin: ['Dashboard', 'Projects', 'Tasks', 'Tickets', 'Domains', 'Reports', 'Budget', 'Billing', 'Team', 'Settings'],
  sales: ['Dashboard', 'Projects', 'Tickets', 'Domains', 'Reports', 'Settings'],
  project_manager: ['Dashboard', 'Projects', 'Tasks', 'Tickets', 'Domains', 'Reports', 'Budget', 'Settings'],
  employee: ['Dashboard', 'Tasks', 'Tickets', 'Settings'],
  client: ['Dashboard', 'Projects', 'Tickets', 'Domains', 'Reports', 'Budget', 'Billing', 'Settings'],
};
const STATUS_PILL = {
  'On Track': 'pill-ontrack', 'In Review': 'pill-review', 'At Risk': 'pill-atrisk',
  'Open': 'pill-open', 'In Progress': 'pill-progress', 'Resolved': 'pill-resolved', 'Complete': 'pill-complete',
  'To Do': 'pill-todo',
};
const PRIORITY_PILL = { Low: 'pill-todo', Medium: 'pill-atrisk', High: 'pill-open' };

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============ Toast ============ */
function showToast(msg) {
  const host = document.getElementById('toastHost');
  host.innerHTML = `<div class="ew-toast">${PILL_SVG.checkCircle} ${escapeHtml(msg)}</div>`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { host.innerHTML = ''; }, 2600);
}

/* ============ Modal helpers ============ */
function openModal(html) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'ew-modal-overlay';
  overlay.id = 'activeModalOverlay';
  overlay.innerHTML = `<div class="ew-modal" onclick="event.stopPropagation()">${html}</div>`;
  overlay.addEventListener('click', closeModal);
  document.getElementById('ewRoot').appendChild(overlay);
}
function closeModal() {
  document.getElementById('activeModalOverlay')?.remove();
}

function confirmModal({ title, message, confirmLabel = 'Delete', onConfirm }) {
  openModal(`
    <div class="ew-confirm-icon">⚠</div>
    <h2 style="text-align:center">${escapeHtml(title)}</h2>
    <p class="ew-modal-sub" style="text-align:center">${escapeHtml(message)}</p>
    <div class="ew-modal-actions" style="justify-content:center">
      <button type="button" class="ew-btn ew-btn-ghost" id="confirmCancelBtn">Cancel</button>
      <button type="button" class="ew-btn ew-btn-danger" id="confirmOkBtn">${escapeHtml(confirmLabel)}</button>
    </div>
  `);
  document.getElementById('confirmCancelBtn').addEventListener('click', closeModal);
  document.getElementById('confirmOkBtn').addEventListener('click', async () => {
    await onConfirm();
    closeModal();
  });
}

/* ============ Bootstrap ============ */
async function bootstrap() {
  try {
    const { user, csrfToken } = await api('GET', '/auth/me');
    CURRENT_USER = user;
    CSRF_TOKEN = csrfToken;
  } catch {
    window.location.href = '/index.html';
    return;
  }

  try { APP_CONFIG = await api('GET', '/config'); } catch { APP_CONFIG = {}; }

  document.getElementById('navUserName').textContent = CURRENT_USER.name;
  document.getElementById('navUserRole').textContent = ROLE_LABEL[CURRENT_USER.role] || CURRENT_USER.role;
  document.getElementById('avatarBtn').textContent = initials(CURRENT_USER.name);

  renderNav();
  bindTopbar();
  initBell();
  await navigateTo('Dashboard');
}

function renderNav() {
  const nav = document.getElementById('sideNav');
  const items = ROLE_NAV[CURRENT_USER.role] || ['Dashboard'];
  nav.innerHTML = items.map((label) => `
    <button class="ew-nav-item" data-view="${label}">
      ${ICONS[label] || ''}${label}
    </button>
  `).join('');
  nav.querySelectorAll('.ew-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.view));
  });
}

function bindTopbar() {
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
    window.location.href = '/index.html';
  });
  document.getElementById('darkBtn').addEventListener('click', () => setTheme('dark'));
  document.getElementById('lightBtn').addEventListener('click', () => setTheme('light'));

  const avatarBtn = document.getElementById('avatarBtn');
  const avatarMenu = document.getElementById('avatarMenu');
  avatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (avatarMenu.classList.contains('ew-hidden')) {
      avatarMenu.innerHTML = `
        <div class="who">
          <div class="name">${escapeHtml(CURRENT_USER.name)}</div>
          <div class="email">${escapeHtml(CURRENT_USER.email)}</div>
        </div>
        <button id="avatarSettingsBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Profile &amp; Settings
        </button>
        <button id="avatarLogoutBtn" class="danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          Log out
        </button>
      `;
      document.getElementById('avatarSettingsBtn').addEventListener('click', () => { avatarMenu.classList.add('ew-hidden'); navigateTo('Settings'); });
      document.getElementById('avatarLogoutBtn').addEventListener('click', () => document.getElementById('logoutBtn').click());
      avatarMenu.classList.remove('ew-hidden');
    } else {
      avatarMenu.classList.add('ew-hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!avatarMenu.contains(e.target) && e.target !== avatarBtn) avatarMenu.classList.add('ew-hidden');
  });
}

/* ============ Notification bell (topbar, replaces the old Notifications tab) ============ */
async function initBell() {
  const btn = document.getElementById('bellBtn');
  const panel = document.getElementById('bellPanel');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isHidden = panel.classList.contains('ew-hidden');
    if (isHidden) { await refreshBell(true); panel.classList.remove('ew-hidden'); }
    else panel.classList.add('ew-hidden');
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) panel.classList.add('ew-hidden');
  });
  await refreshBell(false);
}

async function refreshBell(openPanel) {
  const { notifications } = await api('GET', '/notifications');
  CACHE.notifications = notifications;
  const unread = notifications.filter((n) => !n.read).length;

  const badge = document.getElementById('bellBadge');
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('ew-hidden', unread === 0);

  const panel = document.getElementById('bellPanel');
  panel.innerHTML = `
    <div class="ew-bell-panel-head">
      <span class="t">Notifications</span>
      <button id="bellMarkAll" ${unread === 0 ? 'disabled' : ''}>Mark all read</button>
    </div>
    ${notifications.length === 0
      ? '<div class="ew-bell-empty">No notifications yet.</div>'
      : notifications.slice(0, 12).map((n) => `
        <div class="ew-bell-item">
          <div style="flex:1">
            <div class="txt">${escapeHtml(n.message)}</div>
            <div class="time">${timeAgo(n.createdAt)}</div>
          </div>
          ${!n.read ? `<span class="dot"></span>` : ''}
        </div>
      `).join('')}
  `;
  document.getElementById('bellMarkAll')?.addEventListener('click', async () => {
    await api('POST', '/notifications/read-all');
    await refreshBell(true);
  });

  if (openPanel !== undefined) { /* caller controls visibility */ }
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ============ Card/List view toggle (shared by Projects, Tasks, Tickets, Domains) ============ */
function getViewMode(key) {
  try { return localStorage.getItem(`ew_view_${key}`) || 'list'; } catch { return 'list'; }
}
function setViewMode(key, mode) {
  try { localStorage.setItem(`ew_view_${key}`, mode); } catch { /* ignore */ }
}
function viewToggleHtml(key) {
  const mode = getViewMode(key);
  return `
    <div class="ew-view-toggle" data-view-key="${key}">
      <button type="button" data-mode="list" class="${mode === 'list' ? 'active' : ''}" aria-label="List view">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
      </button>
      <button type="button" data-mode="card" class="${mode === 'card' ? 'active' : ''}" aria-label="Card view">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/></svg>
      </button>
    </div>
  `;
}
function bindViewToggle(key, onChange) {
  document.querySelectorAll(`[data-view-key="${key}"] button`).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (getViewMode(key) === btn.dataset.mode) return;
      setViewMode(key, btn.dataset.mode);
      onChange();
    });
  });
}

/* ============ Tooltip helper ============ */
function tooltipHtml(text) {
  return `<span class="ew-tooltip-wrap"><span class="ew-tooltip-icon">?</span><span class="ew-tooltip-bubble">${escapeHtml(text)}</span></span>`;
}

function setTheme(theme) {
  document.getElementById('ewRoot').setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('darkBtn').classList.toggle('active', theme === 'dark');
  document.getElementById('lightBtn').classList.toggle('active', theme === 'light');
}

async function navigateTo(view) {
  ACTIVE_VIEW = view;
  document.getElementById('pageTitle').textContent = view;
  document.querySelectorAll('.ew-nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));

  const main = document.getElementById('mainContent');
  main.innerHTML = '<div class="ew-loading">Loading…</div>';

  try {
    if (view === 'Dashboard') await renderDashboard(main);
    else if (view === 'Projects') await renderProjects(main);
    else if (view === 'Tasks') await renderTasks(main);
    else if (view === 'Tickets') await renderTickets(main);
    else if (view === 'Domains') await renderDomains(main);
    else if (view === 'Reports') await renderReports(main);
    else if (view === 'Budget') await renderBudget(main);
    else if (view === 'Billing') await renderBilling(main);
    else if (view === 'Team') await renderTeam(main);
    else if (view === 'Settings') await renderSettings(main);
  } catch (err) {
    main.innerHTML = `<div class="ew-card"><div class="ew-inline-error">${escapeHtml(err.message)}</div></div>`;
  }
}

/* ============ Dashboard ============ */
async function renderDashboard(main) {
  const [{ projects }, { tasks }, { tickets }, { notifications }] = await Promise.all([
    api('GET', '/projects'), api('GET', '/tasks'), api('GET', '/tickets'), api('GET', '/notifications'),
  ]);
  CACHE.projects = projects; CACHE.tasks = tasks; CACHE.tickets = tickets; CACHE.notifications = notifications;

  const openTickets = tickets.filter((t) => t.status !== 'Resolved').length;
  const activeTasks = tasks.filter((t) => t.status !== 'Complete').length;
  const unread = notifications.filter((n) => !n.read).length;

  main.innerHTML = `
    <section class="ew-card ew-welcome">
      <div>
        <h1 class="serif">Welcome back, ${escapeHtml(CURRENT_USER.name.split(' ')[0])} 👋</h1>
        <p>${projects.length} projects, ${openTickets} open ticket(s), and ${unread} unread notification(s) need your attention.</p>
      </div>
    </section>
    <section class="ew-kpi-grid">
      ${kpi('Projects', projects.length)}
      ${kpi('Active Tasks', activeTasks)}
      ${kpi('Open Tickets', openTickets)}
      ${kpi('Unread Alerts', unread)}
    </section>
    <section class="ew-card">
      <div class="ew-card-head"><div class="ew-card-title">Recent Projects</div></div>
      ${projects.length === 0 ? emptyState('No projects yet.') : projects.slice(0, 5).map(projectRowHtml).join('')}
    </section>
  `;
}
function kpi(label, value) {
  return `<div class="ew-card ew-kpi"><div class="ew-kpi-value">${value}</div><div class="ew-kpi-label">${escapeHtml(label)}</div></div>`;
}
function emptyState(msg) { return `<div class="ew-empty">${escapeHtml(msg)}</div>`; }

function projectRowHtml(p) {
  const pct = p.progress?.pct ?? 0;
  return `
    <div class="ew-project-row">
      <div class="ew-project-top">
        <div><div class="ew-project-name">${escapeHtml(p.name)}</div><div class="ew-project-tag">${escapeHtml(p.type)}</div></div>
        <div class="ew-project-meta">
          <span class="ew-pill ${STATUS_PILL[p.status] || 'pill-todo'}">${escapeHtml(p.status)}</span>
          <span class="ew-project-pct">${pct}%</span>
        </div>
      </div>
      <div class="ew-progress-track"><div class="ew-progress-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

/* ============ Projects ============ */
async function renderProjects(main) {
  const [{ projects }, { users }] = await Promise.all([api('GET', '/projects'), api('GET', '/users')]);
  CACHE.projects = projects; CACHE.users = users;
  const canCreate = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  const canDelete = CURRENT_USER.role === 'admin';
  const mode = getViewMode('projects');

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Projects</h2><p>Every active engagement across your account.</p></div>
      <div style="display:flex;gap:10px;align-items:center">
        ${viewToggleHtml('projects')}
        ${canCreate ? `<button class="ew-btn ew-btn-primary" id="addProjectBtn">+ Add Project</button>` : ''}
      </div>
    </div>
    ${projects.length === 0 ? emptyState('No projects yet.') : (
      mode === 'card'
        ? `<div class="ew-card-grid">${projects.map((p) => projectCardHtml(p, canDelete)).join('')}</div>`
        : `<section class="ew-card">${projects.map((p) => projectDetailRow(p, canDelete)).join('')}</section>`
    )}
  `;

  if (canCreate) document.getElementById('addProjectBtn').addEventListener('click', () => openProjectModal());
  bindViewToggle('projects', () => renderProjects(main));
  projects.forEach((p) => {
    document.getElementById(`proj-toggle-${p.id}`)?.addEventListener('click', () => {
      document.getElementById(`proj-detail-${p.id}`)?.classList.toggle('ew-hidden');
    });
    document.getElementById(`proj-edit-${p.id}`)?.addEventListener('click', () => openProjectModal(p));
    document.getElementById(`proj-delete-${p.id}`)?.addEventListener('click', () => {
      confirmModal({
        title: 'Delete this project?',
        message: `This will also delete all tasks linked to "${p.name}". This can't be undone.`,
        onConfirm: async () => {
          await api('DELETE', `/projects/${p.id}`);
          showToast('Project deleted');
          navigateTo('Projects');
        },
      });
    });
  });
}

function projectCardHtml(p, canDelete) {
  const pct = p.progress?.pct ?? 0;
  const client = CACHE.users.find((u) => u.id === p.clientId);
  const canEdit = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  return `
    <div class="ew-item-card">
      <div class="ew-item-card-head">
        <div><div class="name">${escapeHtml(p.name)}</div><div class="sub">${escapeHtml(p.type)} · ${client ? escapeHtml(client.company || client.name) : '—'}</div></div>
        <span class="ew-pill ${STATUS_PILL[p.status] || 'pill-todo'}">${escapeHtml(p.status)}</span>
      </div>
      <div class="ew-progress-track"><div class="ew-progress-fill" style="width:${pct}%"></div></div>
      <div class="ew-card-sub" style="margin-top:8px">${p.progress.complete} of ${p.progress.total} tasks complete</div>
      <div class="ew-item-card-foot">
        <span class="ew-project-pct">${pct}%</span>
        <div style="display:flex;gap:8px">
          ${canEdit ? `<button class="ew-btn ew-btn-ghost ew-btn-sm" id="proj-edit-${p.id}">Edit</button>` : ''}
          ${canDelete ? `<button class="ew-btn ew-btn-danger ew-btn-sm" id="proj-delete-${p.id}">Delete</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function projectDetailRow(p, canDelete) {
  const pct = p.progress?.pct ?? 0;
  const client = CACHE.users.find((u) => u.id === p.clientId);
  const pm = CACHE.users.find((u) => u.id === p.assignedPmId);
  const canEdit = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  return `
    <div class="ew-project-row">
      <button style="width:100%;text-align:left;display:block" id="proj-toggle-${p.id}">
        <div class="ew-project-top">
          <div><div class="ew-project-name">${escapeHtml(p.name)}</div><div class="ew-project-tag">${escapeHtml(p.type)} · ${client ? escapeHtml(client.company || client.name) : '—'}</div></div>
          <div class="ew-project-meta">
            <span class="ew-pill ${STATUS_PILL[p.status] || 'pill-todo'}">${escapeHtml(p.status)}</span>
            <span class="ew-project-pct">${pct}%</span>
          </div>
        </div>
        <div class="ew-progress-track"><div class="ew-progress-fill" style="width:${pct}%"></div></div>
      </button>
      <div class="ew-project-detail ew-hidden" id="proj-detail-${p.id}">
        <p class="ew-project-desc" style="margin-top:0">${escapeHtml(p.description || 'No description yet.')}</p>
        <div class="ew-card-sub">PM: ${pm ? escapeHtml(pm.name) : 'Unassigned'} · ${p.progress.complete} of ${p.progress.total} tasks complete</div>
        <div class="ew-project-actions">
          ${canEdit ? `<button class="ew-btn ew-btn-ghost ew-btn-sm" id="proj-edit-${p.id}">Edit Project</button>` : ''}
          ${canDelete ? `<button class="ew-btn ew-btn-danger ew-btn-sm" id="proj-delete-${p.id}">Delete Project</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function openProjectModal(project) {
  const isEdit = Boolean(project);
  const clients = CACHE.users.filter((u) => u.role === 'client');
  const pms = CACHE.users.filter((u) => u.role === 'project_manager');
  openModal(`
    <h2>${isEdit ? 'Edit project' : 'Add a project'}</h2>
    <form id="projectForm">
      <div class="ew-field"><label>Project name</label><input id="pf-name" type="text" value="${isEdit ? escapeHtml(project.name) : ''}" required></div>
      <div class="ew-field"><label>Type</label><input id="pf-type" type="text" placeholder="Website, Mobile App, Digital Marketing…" value="${isEdit ? escapeHtml(project.type) : ''}"></div>
      <div class="ew-field"><label>Client</label>
        <select id="pf-client" ${isEdit ? 'disabled' : ''}>
          ${clients.map((c) => `<option value="${c.id}" ${isEdit && project.clientId === c.id ? 'selected' : ''}>${escapeHtml(c.company || c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Project Manager</label>
        <select id="pf-pm">
          <option value="">Unassigned</option>
          ${pms.map((p) => `<option value="${p.id}" ${isEdit && project.assignedPmId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Status</label>
        <select id="pf-status">
          ${['On Track', 'In Review', 'At Risk'].map((s) => `<option value="${s}" ${isEdit && project.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Description</label><textarea id="pf-desc">${isEdit ? escapeHtml(project.description) : ''}</textarea></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="pf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">${isEdit ? 'Save Changes' : 'Add Project'}</button>
      </div>
    </form>
  `);
  document.getElementById('pf-cancel').addEventListener('click', closeModal);
  document.getElementById('projectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('pf-name').value.trim(),
      type: document.getElementById('pf-type').value.trim() || 'General',
      assignedPmId: document.getElementById('pf-pm').value || null,
      status: document.getElementById('pf-status').value,
      description: document.getElementById('pf-desc').value.trim(),
    };
    if (!isEdit) payload.clientId = document.getElementById('pf-client').value;
    if (!payload.name || (!isEdit && !payload.clientId)) return;

    if (isEdit) await api('PUT', `/projects/${project.id}`, payload);
    else await api('POST', '/projects', payload);

    closeModal();
    showToast(isEdit ? 'Project updated' : 'Project added');
    navigateTo('Projects');
  });
}

/* ============ Tasks ============ */
async function renderTasks(main) {
  const [{ tasks }, { projects }, { users }] = await Promise.all([api('GET', '/tasks'), api('GET', '/projects'), api('GET', '/users')]);
  CACHE.tasks = tasks; CACHE.projects = projects; CACHE.users = users;
  const canManage = ['admin', 'project_manager'].includes(CURRENT_USER.role);
  const mode = getViewMode('tasks');

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Tasks</h2><p>Work items linked to your active projects.</p></div>
      <div style="display:flex;gap:10px;align-items:center">
        ${viewToggleHtml('tasks')}
        ${canManage ? `<button class="ew-btn ew-btn-primary" id="addTaskBtn">+ Add Task</button>` : ''}
      </div>
    </div>
    ${tasks.length === 0 ? emptyState('No tasks yet.') : (
      mode === 'card'
        ? `<div class="ew-card-grid">${tasks.map((t) => taskCardHtml(t, canManage)).join('')}</div>`
        : `<section class="ew-card"><table class="ew-table">
            <thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Due</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>${tasks.map((t) => taskRowHtml(t, canManage)).join('')}</tbody>
          </table></section>`
    )}
  `;

  if (canManage) document.getElementById('addTaskBtn').addEventListener('click', () => openTaskModal());
  bindViewToggle('tasks', () => renderTasks(main));
  tasks.forEach((t) => {
    document.getElementById(`task-status-${t.id}`)?.addEventListener('change', async (e) => {
      await api('PUT', `/tasks/${t.id}`, { status: e.target.value });
      showToast('Task updated');
      navigateTo('Tasks');
    });
    document.getElementById(`task-edit-${t.id}`)?.addEventListener('click', () => openTaskModal(t));
    document.getElementById(`task-delete-${t.id}`)?.addEventListener('click', () => {
      confirmModal({
        title: 'Delete this task?',
        message: `"${t.name}" will be permanently removed.`,
        onConfirm: async () => { await api('DELETE', `/tasks/${t.id}`); showToast('Task deleted'); navigateTo('Tasks'); },
      });
    });
  });
}

function taskCardHtml(t, canManage) {
  const project = CACHE.projects.find((p) => p.id === t.projectId);
  const assignee = CACHE.users.find((u) => u.id === t.assigneeId);
  return `
    <div class="ew-item-card">
      <div class="ew-item-card-head">
        <div><div class="name">${escapeHtml(t.name)}</div><div class="sub">${project ? escapeHtml(project.name) : '—'}</div></div>
        <span class="ew-pill ${PRIORITY_PILL[t.priority] || 'pill-todo'}">${escapeHtml(t.priority)}</span>
      </div>
      ${assignee ? `<div class="ew-assignee"><div class="ew-assignee-avatar" style="background:#ff4438">${initials(assignee.name)}</div>${escapeHtml(assignee.name)}</div>` : '<span class="ew-card-sub">Unassigned</span>'}
      <div class="ew-item-card-foot">
        <span class="ew-pill ${STATUS_PILL[t.status] || 'pill-todo'}">${escapeHtml(t.status)}</span>
        ${canManage ? `<div style="display:flex;gap:8px"><button class="ew-btn ew-btn-ghost ew-btn-sm" id="task-edit-${t.id}">Edit</button><button class="ew-btn ew-btn-danger ew-btn-sm" id="task-delete-${t.id}">Delete</button></div>` : ''}
      </div>
    </div>
  `;
}

function taskRowHtml(t, canManage) {
  const project = CACHE.projects.find((p) => p.id === t.projectId);
  const assignee = CACHE.users.find((u) => u.id === t.assigneeId);
  const canEditStatus = canManage || (CURRENT_USER.role === 'employee' && t.assigneeId === CURRENT_USER.id);
  return `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td><span class="ew-card-sub">${project ? escapeHtml(project.name) : '—'}</span></td>
      <td>${assignee ? `<div class="ew-assignee"><div class="ew-assignee-avatar" style="background:#ff4438">${initials(assignee.name)}</div>${escapeHtml(assignee.name)}</div>` : '<span class="ew-card-sub">Unassigned</span>'}</td>
      <td><span class="ew-pill ${PRIORITY_PILL[t.priority] || 'pill-todo'}">${escapeHtml(t.priority)}</span></td>
      <td>
        ${canEditStatus ? `
          <select class="ew-status-select" id="task-status-${t.id}">
            ${['To Do', 'In Progress', 'In Review', 'Complete'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        ` : `<span class="ew-pill ${STATUS_PILL[t.status] || 'pill-todo'}">${escapeHtml(t.status)}</span>`}
      </td>
      <td>${t.due ? new Date(t.due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
      ${canManage ? `<td style="display:flex;gap:6px"><button class="ew-icon-btn" style="margin-left:0" id="task-edit-${t.id}">${PILL_SVG.edit}</button><button class="ew-icon-btn" id="task-delete-${t.id}">${PILL_SVG.trash}</button></td>` : ''}
    </tr>
  `;
}

function openTaskModal(task) {
  const isEdit = Boolean(task);
  const employees = CACHE.users.filter((u) => u.role === 'employee');
  openModal(`
    <h2>${isEdit ? 'Edit task' : 'Add a task'}</h2>
    <form id="taskForm">
      <div class="ew-field"><label>Task name</label><input id="tf-name" type="text" value="${isEdit ? escapeHtml(task.name) : ''}" required></div>
      <div class="ew-field"><label>Project</label>
        <select id="tf-project" ${isEdit ? 'disabled' : ''}>
          ${CACHE.projects.map((p) => `<option value="${p.id}" ${isEdit && task.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Assignee</label>
        <select id="tf-assignee">
          <option value="">Unassigned</option>
          ${employees.map((e) => `<option value="${e.id}" ${isEdit && task.assigneeId === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Priority</label>
        <select id="tf-priority">
          ${['Low', 'Medium', 'High'].map((p) => `<option value="${p}" ${isEdit && task.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Due date</label><input id="tf-due" type="date" value="${isEdit && task.due ? task.due.slice(0, 10) : ''}"></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="tf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">${isEdit ? 'Save Changes' : 'Add Task'}</button>
      </div>
    </form>
  `);
  document.getElementById('tf-cancel').addEventListener('click', closeModal);
  document.getElementById('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('tf-name').value.trim(),
      assigneeId: document.getElementById('tf-assignee').value || null,
      priority: document.getElementById('tf-priority').value,
      due: document.getElementById('tf-due').value ? new Date(document.getElementById('tf-due').value).toISOString() : null,
    };
    if (!isEdit) payload.projectId = document.getElementById('tf-project').value;
    if (!payload.name) return;

    if (isEdit) await api('PUT', `/tasks/${task.id}`, payload);
    else await api('POST', '/tasks', payload);

    closeModal();
    showToast(isEdit ? 'Task updated' : 'Task added');
    navigateTo('Tasks');
  });
}

/* ============ Tickets ============ */
async function renderTickets(main) {
  const [{ tickets }, { users }] = await Promise.all([api('GET', '/tickets'), api('GET', '/users')]);
  CACHE.tickets = tickets; CACHE.users = users;
  const canAssign = ['admin', 'project_manager'].includes(CURRENT_USER.role);
  const mode = getViewMode('tickets');

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Support Tickets</h2><p>Client requests and internal follow-ups.</p></div>
      <div style="display:flex;gap:10px;align-items:center">
        ${viewToggleHtml('tickets')}
        <button class="ew-btn ew-btn-primary" id="addTicketBtn">+ Create Ticket</button>
      </div>
    </div>
    ${tickets.length === 0 ? emptyState('No tickets yet.') : (
      mode === 'card'
        ? `<div class="ew-card-grid">${tickets.map((t) => ticketCardHtml(t, canAssign)).join('')}</div>`
        : `<section class="ew-card">${tickets.map((t) => ticketRowHtml(t, canAssign)).join('')}</section>`
    )}
  `;

  document.getElementById('addTicketBtn')?.addEventListener('click', () => openTicketModal());
  bindViewToggle('tickets', () => renderTickets(main));
  tickets.forEach((t) => {
    document.getElementById(`ticket-status-${t.id}`)?.addEventListener('change', async (e) => {
      await api('PUT', `/tickets/${t.id}`, { status: e.target.value });
      showToast('Ticket updated');
      navigateTo('Tickets');
    });
    document.getElementById(`ticket-assignee-${t.id}`)?.addEventListener('change', async (e) => {
      await api('PUT', `/tickets/${t.id}`, { assigneeId: e.target.value || null });
      showToast('Ticket reassigned');
      navigateTo('Tickets');
    });
  });
}

function ticketCardHtml(t, canAssign) {
  const client = CACHE.users.find((u) => u.id === t.clientId);
  const assignee = CACHE.users.find((u) => u.id === t.assigneeId);
  const canEditStatus = canAssign || (CURRENT_USER.role === 'employee' && t.assigneeId === CURRENT_USER.id);
  return `
    <div class="ew-item-card">
      <div class="ew-item-card-head">
        <div><div class="name">${escapeHtml(t.id.replace('ticket-', '#'))} · ${escapeHtml(t.subject)}</div><div class="sub">${escapeHtml(t.category)} · ${client ? escapeHtml(client.company || client.name) : '—'}</div></div>
      </div>
      ${assignee ? `<div class="ew-card-sub">Assigned to ${escapeHtml(assignee.name)}</div>` : `<div class="ew-card-sub">Unassigned</div>`}
      <div class="ew-item-card-foot">
        ${canEditStatus
          ? `<select class="ew-status-select" id="ticket-status-${t.id}">${['Open', 'In Progress', 'Resolved'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`
          : `<span class="ew-pill ${STATUS_PILL[t.status] || 'pill-todo'}">${escapeHtml(t.status)}</span>`}
      </div>
    </div>
  `;
}

function ticketRowHtml(t, canAssign) {
  const client = CACHE.users.find((u) => u.id === t.clientId);
  const assignee = CACHE.users.find((u) => u.id === t.assigneeId);
  const staff = CACHE.users.filter((u) => ['employee', 'project_manager'].includes(u.role));
  const canEditStatus = canAssign || (CURRENT_USER.role === 'employee' && t.assigneeId === CURRENT_USER.id);
  return `
    <div class="ew-ticket-row">
      <div class="ew-ticket-id">${escapeHtml(t.id.replace('ticket-', '#'))}</div>
      <div style="flex:1;min-width:200px">
        <div class="ew-ticket-subject">${escapeHtml(t.subject)}</div>
        <div class="ew-ticket-meta">${escapeHtml(t.category)} · ${client ? escapeHtml(client.company || client.name) : '—'}${assignee ? ` · Assigned to ${escapeHtml(assignee.name)}` : ''}</div>
      </div>
      ${canAssign ? `
        <select class="ew-status-select" id="ticket-assignee-${t.id}" style="margin-right:8px">
          <option value="">Unassigned</option>
          ${staff.map((s) => `<option value="${s.id}" ${t.assigneeId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      ` : ''}
      ${canEditStatus ? `
        <select class="ew-status-select" id="ticket-status-${t.id}">
          ${['Open', 'In Progress', 'Resolved'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      ` : `<span class="ew-pill ${STATUS_PILL[t.status] || 'pill-todo'}">${escapeHtml(t.status)}</span>`}
    </div>
  `;
}

function openTicketModal() {
  openModal(`
    <h2>Create a support ticket</h2>
    <p class="ew-modal-sub">Your team typically responds within one business day.</p>
    <form id="ticketForm">
      <div class="ew-field"><label>Subject</label><input id="tkf-subject" type="text" required></div>
      <div class="ew-field"><label>Category</label>
        <select id="tkf-category">
          <option>Website</option><option>Mobile App</option><option>Marketing</option><option>Billing</option><option>Other</option>
        </select>
      </div>
      <div class="ew-field"><label>Description</label><textarea id="tkf-desc"></textarea></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="tkf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">Submit Ticket</button>
      </div>
    </form>
  `);
  document.getElementById('tkf-cancel').addEventListener('click', closeModal);
  document.getElementById('ticketForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = document.getElementById('tkf-subject').value.trim();
    if (!subject) return;
    await api('POST', '/tickets', {
      subject, category: document.getElementById('tkf-category').value,
      description: document.getElementById('tkf-desc').value.trim(),
    });
    closeModal();
    showToast('Ticket created');
    navigateTo('Tickets');
  });
}

/* ============ Team (Admin only) ============ */
async function renderTeam(main) {
  const { users } = await api('GET', '/users');
  CACHE.users = users;

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Team</h2><p>Manage everyone who has access to the CRM.</p></div>
      <button class="ew-btn ew-btn-primary" id="addUserBtn">+ Add Team Member</button>
    </div>
    <section class="ew-card">
      ${users.map((u) => `
        <div class="ew-settings-member-row">
          <div class="ew-assignee-avatar" style="background:#ff4438">${initials(u.name)}</div>
          <div class="info"><div class="name">${escapeHtml(u.name)}${u.company ? ` · ${escapeHtml(u.company)}` : ''}</div><div class="role">${escapeHtml(ROLE_LABEL[u.role] || u.role)} · ${escapeHtml(u.email)}</div></div>
          <button class="ew-icon-btn" style="margin-left:0" id="user-edit-${u.id}">${PILL_SVG.edit}</button>
          ${u.id !== CURRENT_USER.id ? `<button class="ew-icon-btn" id="user-delete-${u.id}">${PILL_SVG.trash}</button>` : ''}
        </div>
      `).join('')}
    </section>
  `;

  document.getElementById('addUserBtn').addEventListener('click', () => openUserModal());
  users.forEach((u) => {
    document.getElementById(`user-edit-${u.id}`)?.addEventListener('click', () => openUserModal(u));
    document.getElementById(`user-delete-${u.id}`)?.addEventListener('click', () => {
      confirmModal({
        title: 'Remove this user?',
        message: `${u.name} will lose access. Their assigned tasks/tickets will show as unassigned.`,
        onConfirm: async () => { await api('DELETE', `/users/${u.id}`); showToast('User removed'); navigateTo('Team'); },
      });
    });
  });
}

function openUserModal(user) {
  const isEdit = Boolean(user);
  openModal(`
    <h2>${isEdit ? 'Edit team member' : 'Add a team member'}</h2>
    <form id="userForm">
      <div class="ew-field"><label>Full name</label><input id="uf-name" type="text" value="${isEdit ? escapeHtml(user.name) : ''}" required></div>
      <div class="ew-field"><label>Email</label><input id="uf-email" type="email" value="${isEdit ? escapeHtml(user.email) : ''}" required ${isEdit ? 'disabled' : ''}></div>
      <div class="ew-field"><label>Role</label>
        <select id="uf-role" ${isEdit ? 'disabled' : ''}>
          ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${isEdit && user.role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field" id="uf-company-wrap"><label>Company (clients only)</label><input id="uf-company" type="text" value="${isEdit ? escapeHtml(user.company || '') : ''}"></div>
      <div class="ew-field"><label>${isEdit ? 'New password (leave blank to keep current)' : 'Password'}</label><input id="uf-password" type="password" ${isEdit ? '' : 'required'}></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="uf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">${isEdit ? 'Save Changes' : 'Add Member'}</button>
      </div>
    </form>
  `);
  document.getElementById('uf-cancel').addEventListener('click', closeModal);
  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('uf-password').value;
    if (isEdit) {
      const patch = { name: document.getElementById('uf-name').value.trim(), company: document.getElementById('uf-company').value.trim() || null };
      if (password) patch.password = password;
      await api('PUT', `/users/${user.id}`, patch);
    } else {
      await api('POST', '/users', {
        name: document.getElementById('uf-name').value.trim(),
        email: document.getElementById('uf-email').value.trim(),
        role: document.getElementById('uf-role').value,
        company: document.getElementById('uf-company').value.trim() || null,
        password,
      });
    }
    closeModal();
    showToast(isEdit ? 'Team member updated' : 'Team member added');
    navigateTo('Team');
  });
}

/* ============ Notifications ============ */
/* ============ Domains & Website Info ============ */
const PLATFORM_OPTIONS = ['WordPress', 'Shopify', 'Webflow', 'Squarespace', 'Wix', 'Custom Code', 'Other'];

async function renderDomains(main) {
  const [{ domains }, { users }] = await Promise.all([api('GET', '/domains'), api('GET', '/users')]);
  CACHE.domains = domains; CACHE.users = users;
  const canManage = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  const canDelete = CURRENT_USER.role === 'admin';
  const mode = getViewMode('domains');

  main.innerHTML = `
    <div class="ew-page-head">
      <div>
        <h2>Domains &amp; Website Info${tooltipHtml("A domain is the web address people type to reach a site (like yourbrand.com). This page also shows what platform each site is built on and where it is hosted.")}</h2>
        <p>Everything about where your site lives — the domain, the platform it runs on, and hosting details.</p>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        ${viewToggleHtml('domains')}
        ${canManage ? `<button class="ew-btn ew-btn-primary" id="addDomainBtn">+ Add Domain</button>` : ''}
      </div>
    </div>
    <div id="domainsContainer">${domains.length === 0 ? emptyState('No domains added yet.') : (mode === 'card' ? domainCardGrid(domains, canDelete) : domainList(domains, canDelete))}</div>
  `;

  if (canManage) document.getElementById('addDomainBtn').addEventListener('click', () => openDomainModal());
  bindViewToggle('domains', () => renderDomains(main));
  bindDomainActions(domains, canDelete);
}

function clientLabel(clientId) {
  const c = CACHE.users.find((u) => u.id === clientId);
  return c ? escapeHtml(c.company || c.name) : '—';
}

function domainList(domains, canDelete) {
  return `<section class="ew-card">${domains.map((d) => domainRowHtml(d, canDelete)).join('')}</section>`;
}
function domainCardGrid(domains, canDelete) {
  return `<div class="ew-card-grid">${domains.map((d) => domainCardHtml(d, canDelete)).join('')}</div>`;
}

function domainMetaBlock(d) {
  return `
    <div class="ew-domain-row"><span>Platform</span><span class="ew-domain-platform">${escapeHtml(d.platform || 'Custom')}</span></div>
    <div class="ew-domain-row"><span>Hosting Provider</span><span>${escapeHtml(d.hostingProvider || 'Not set')}${d.hostingRegion ? ` · ${escapeHtml(d.hostingRegion)}` : ''}</span></div>
    <div class="ew-domain-row"><span>Registrar</span><span>${escapeHtml(d.registrar || '—')}</span></div>
    <div class="ew-domain-row"><span>SSL Certificate</span><span><span class="ew-status-dot" style="background:${d.sslStatus === 'Valid' ? 'var(--green-500)' : 'var(--amber-500)'}"></span>${escapeHtml(d.sslStatus || 'Unknown')}</span></div>
    <div class="ew-domain-row"><span>Expires</span><span>${escapeHtml(d.expiresAt || 'Not set')}</span></div>
    <div class="ew-domain-row"><span>Auto-renew</span><span><span class="ew-status-dot" style="background:${d.autoRenew ? 'var(--green-500)' : 'var(--text-faint)'}"></span>${d.autoRenew ? 'Enabled' : 'Disabled'}</span></div>
    <div class="ew-domain-row"><span>DNS</span><span><span class="ew-status-dot" style="background:var(--green-500)"></span>${escapeHtml(d.dnsStatus || 'Propagated')}</span></div>
    ${d.notes ? `<div class="ew-card-sub" style="margin-top:8px">${escapeHtml(d.notes)}</div>` : ''}
  `;
}

function domainRowHtml(d, canDelete) {
  return `
    <div class="ew-project-row">
      <div class="ew-project-top">
        <div><div class="ew-domain-name serif">${escapeHtml(d.domainName)}</div><div class="ew-project-tag">${clientLabel(d.clientId)}</div></div>
        <span class="ew-pill ${d.sslStatus === 'Valid' ? 'pill-ontrack' : 'pill-atrisk'}">${escapeHtml(d.sslStatus || 'Unknown')}</span>
      </div>
      <div style="margin-top:10px">${domainMetaBlock(d)}</div>
      <div class="ew-project-actions">
        <button class="ew-btn ew-btn-ghost ew-btn-sm" id="dom-renew-${d.id}">${PILL_SVG.refresh} Renew for 1 year</button>
        <button class="ew-btn ew-btn-ghost ew-btn-sm" id="dom-edit-${d.id}">Edit</button>
        ${canDelete ? `<button class="ew-btn ew-btn-danger ew-btn-sm" id="dom-delete-${d.id}">Delete</button>` : ''}
      </div>
    </div>
  `;
}
function domainCardHtml(d, canDelete) {
  return `
    <div class="ew-item-card">
      <div class="ew-item-card-head">
        <div><div class="name">${escapeHtml(d.domainName)}</div><div class="sub">${clientLabel(d.clientId)}</div></div>
        <span class="ew-pill ${d.sslStatus === 'Valid' ? 'pill-ontrack' : 'pill-atrisk'}">${escapeHtml(d.sslStatus || 'Unknown')}</span>
      </div>
      ${domainMetaBlock(d)}
      <div class="ew-item-card-foot">
        <button class="ew-btn ew-btn-ghost ew-btn-sm" id="dom-renew-${d.id}">Renew</button>
        <div style="display:flex;gap:8px">
          <button class="ew-btn ew-btn-ghost ew-btn-sm" id="dom-edit-${d.id}">Edit</button>
          ${canDelete ? `<button class="ew-btn ew-btn-danger ew-btn-sm" id="dom-delete-${d.id}">Delete</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function bindDomainActions(domains, canDelete) {
  domains.forEach((d) => {
    document.getElementById(`dom-renew-${d.id}`)?.addEventListener('click', async () => {
      await api('POST', `/domains/${d.id}/renew`);
      showToast('Domain renewed for 1 year');
      navigateTo('Domains');
    });
    document.getElementById(`dom-edit-${d.id}`)?.addEventListener('click', () => openDomainModal(d));
    if (canDelete) {
      document.getElementById(`dom-delete-${d.id}`)?.addEventListener('click', () => {
        confirmModal({
          title: 'Delete this domain?',
          message: `"${d.domainName}" will be permanently removed.`,
          onConfirm: async () => { await api('DELETE', `/domains/${d.id}`); showToast('Domain deleted'); navigateTo('Domains'); },
        });
      });
    }
  });
}

function openDomainModal(domain) {
  const isEdit = Boolean(domain);
  const clients = CACHE.users.filter((u) => u.role === 'client');
  openModal(`
    <h2>${isEdit ? 'Edit domain' : 'Add a domain'}</h2>
    <p class="ew-modal-sub">Track the domain, hosting, and platform info for a client's site.</p>
    <form id="domainForm">
      <div class="ew-field"><label>Domain name</label><input id="df-name" type="text" placeholder="e.g. mynewsite.com" value="${isEdit ? escapeHtml(domain.domainName) : ''}" required></div>
      <div class="ew-field"><label>Client</label>
        <select id="df-client" ${isEdit ? 'disabled' : ''}>
          ${clients.map((c) => `<option value="${c.id}" ${isEdit && domain.clientId === c.id ? 'selected' : ''}>${escapeHtml(c.company || c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Platform ${tooltipHtml('What the website itself is built with/on — helps whoever supports it know which tools apply.')}</label>
        <select id="df-platform">
          ${PLATFORM_OPTIONS.map((p) => `<option value="${p}" ${isEdit && domain.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="ew-field"><label>Hosting provider</label><input id="df-hosting" type="text" placeholder="e.g. Vercel, SiteGround, AWS…" value="${isEdit ? escapeHtml(domain.hostingProvider || '') : ''}"></div>
      <div class="ew-field"><label>Hosting region</label><input id="df-region" type="text" placeholder="e.g. US East" value="${isEdit ? escapeHtml(domain.hostingRegion || '') : ''}"></div>
      <div class="ew-field"><label>Registrar</label><input id="df-registrar" type="text" placeholder="e.g. GoDaddy, Namecheap…" value="${isEdit ? escapeHtml(domain.registrar || '') : ''}"></div>
      <div class="ew-field"><label>Expiration date</label><input id="df-expires" type="text" placeholder="e.g. Aug 23, 2026" value="${isEdit ? escapeHtml(domain.expiresAt || '') : ''}"></div>
      <div class="ew-field"><label>Notes</label><textarea id="df-notes">${isEdit ? escapeHtml(domain.notes || '') : ''}</textarea></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="df-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">${isEdit ? 'Save Changes' : 'Add Domain'}</button>
      </div>
    </form>
  `);
  document.getElementById('df-cancel').addEventListener('click', closeModal);
  document.getElementById('domainForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      domainName: document.getElementById('df-name').value.trim(),
      platform: document.getElementById('df-platform').value,
      hostingProvider: document.getElementById('df-hosting').value.trim(),
      hostingRegion: document.getElementById('df-region').value.trim(),
      registrar: document.getElementById('df-registrar').value.trim(),
      expiresAt: document.getElementById('df-expires').value.trim(),
      notes: document.getElementById('df-notes').value.trim(),
    };
    if (!isEdit) payload.clientId = document.getElementById('df-client').value;
    if (!payload.domainName || (!isEdit && !payload.clientId)) return;

    if (isEdit) await api('PUT', `/domains/${domain.id}`, payload);
    else await api('POST', '/domains', payload);

    closeModal();
    showToast(isEdit ? 'Domain updated' : 'Domain added');
    navigateTo('Domains');
  });
}

/* ============ Reports ============ */
async function renderReports(main) {
  const { reports, driveEnabled } = await api('GET', '/reports');
  const users = CACHE.users.length ? CACHE.users : (await api('GET', '/users')).users;
  CACHE.users = users; CACHE.reports = reports;
  const canUpload = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  const canDelete = ['admin', 'project_manager'].includes(CURRENT_USER.role);

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Reports</h2><p>Performance reports and documents shared with your account.</p></div>
      ${canUpload ? `<button class="ew-btn ew-btn-primary" id="uploadReportBtn">+ Upload Report</button>` : ''}
    </div>
    ${!driveEnabled ? `<div class="ew-info-not-configured" style="margin-bottom:16px">${PILL_SVG.warning} Google Drive storage isn't connected yet — files are temporarily stored in the database with a 4MB limit per file. See the README to connect Drive for unlimited storage.</div>` : ''}
    <section class="ew-card">
      ${reports.length === 0 ? emptyState('No reports yet.') : reports.map((r) => `
        <div class="ew-report-row">
          <div class="ew-report-icon">${r.storageType === 'drive' ? PILL_SVG.cloud : PILL_SVG.file}</div>
          <div><div class="ew-report-name">${escapeHtml(r.name)}</div><div class="ew-report-meta">${escapeHtml(r.category)} · ${clientLabel(r.clientId)} · ${(r.sizeBytes / 1024).toFixed(0)} KB</div></div>
          <button class="ew-icon-btn" id="report-dl-${r.id}">${PILL_SVG.download}</button>
          ${canDelete ? `<button class="ew-icon-btn" id="report-del-${r.id}">${PILL_SVG.trash}</button>` : ''}
        </div>
      `).join('')}
    </section>
  `;

  reports.forEach((r) => {
    document.getElementById(`report-dl-${r.id}`)?.addEventListener('click', () => { window.open(`/api/reports/${r.id}/download`, '_blank'); });
    document.getElementById(`report-del-${r.id}`)?.addEventListener('click', () => {
      confirmModal({
        title: 'Delete this report?', message: `"${r.name}" will be permanently removed.`,
        onConfirm: async () => { await api('DELETE', `/reports/${r.id}`); showToast('Report deleted'); navigateTo('Reports'); },
      });
    });
  });

  document.getElementById('uploadReportBtn')?.addEventListener('click', () => openReportUploadModal());
}

function openReportUploadModal() {
  const clients = CACHE.users.filter((u) => u.role === 'client');
  openModal(`
    <h2>Upload a report</h2>
    <form id="reportForm">
      <div class="ew-field"><label>Client</label>
        <select id="rf-client">${clients.map((c) => `<option value="${c.id}">${escapeHtml(c.company || c.name)}</option>`).join('')}</select>
      </div>
      <div class="ew-field"><label>Category</label>
        <select id="rf-category"><option>Performance</option><option>SEO Audit</option><option>Ad Spend</option><option>Strategy</option><option>Other</option></select>
      </div>
      <div class="ew-field"><label>Report name (optional)</label><input id="rf-name" type="text" placeholder="Defaults to the file name"></div>
      <div class="ew-field"><label>File</label><input id="rf-file" type="file" required></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="rf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary" id="rf-submit">Upload</button>
      </div>
    </form>
  `);
  document.getElementById('rf-cancel').addEventListener('click', closeModal);
  document.getElementById('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('rf-file').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('clientId', document.getElementById('rf-client').value);
    fd.append('category', document.getElementById('rf-category').value);
    fd.append('name', document.getElementById('rf-name').value.trim());

    const submitBtn = document.getElementById('rf-submit');
    submitBtn.disabled = true; submitBtn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/reports', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': CSRF_TOKEN }, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      closeModal();
      showToast('Report uploaded');
      navigateTo('Reports');
    } catch (err) {
      submitBtn.disabled = false; submitBtn.textContent = 'Upload';
      showToast(err.message);
    }
  });
}

/* ============ Budget ============ */
async function renderBudget(main) {
  const isStaff = ['admin', 'sales', 'project_manager'].includes(CURRENT_USER.role);
  if (isStaff && CACHE.users.length === 0) CACHE.users = (await api('GET', '/users')).users;
  const clients = isStaff ? CACHE.users.filter((u) => u.role === 'client') : [];
  const selectedClientId = isStaff ? (CACHE.selectedBudgetClient || clients[0]?.id) : CURRENT_USER.id;
  CACHE.selectedBudgetClient = selectedClientId;

  const { items } = selectedClientId ? await api('GET', `/budget?clientId=${selectedClientId}`) : { items: [] };
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  const chartMode = getViewMode('budget-chart') === 'card' ? 'pie' : 'bar'; // reuse list/card storage as bar/pie

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Marketing Budget</h2><p>See exactly where ad spend is going, channel by channel.</p></div>
      <div style="display:flex;gap:10px;align-items:center">
        <div class="ew-view-toggle" data-view-key="budget-chart">
          <button type="button" data-mode="list" class="${chartMode === 'bar' ? 'active' : ''}" aria-label="Bar chart">${PILL_SVG.barChart}</button>
          <button type="button" data-mode="card" class="${chartMode === 'pie' ? 'active' : ''}" aria-label="Pie chart">${PILL_SVG.pieChart}</button>
        </div>
        ${isStaff ? `<button class="ew-btn ew-btn-primary" id="addBudgetBtn">+ Add Budget Item</button>` : ''}
      </div>
    </div>
    ${isStaff ? `
      <div class="ew-field ew-budget-client-picker">
        <label>Client</label>
        <select id="budgetClientPicker">${clients.map((c) => `<option value="${c.id}" ${c.id === selectedClientId ? 'selected' : ''}>${escapeHtml(c.company || c.name)}</option>`).join('')}</select>
      </div>
    ` : ''}
    <section class="ew-card">
      <div class="ew-card-head"><div><div class="ew-card-title">This month's allocation</div><div class="ew-card-sub">Total: $${total.toLocaleString()}</div></div></div>
      ${items.length === 0 ? emptyState('No budget items yet.') : `
        ${chartMode === 'pie' ? budgetPieHtml(items, total) : `
          <div class="ew-budget-stack">
            ${items.map((i) => `<div class="ew-budget-stack-seg" style="width:${(i.amount / total * 100).toFixed(1)}%;background:${i.color}" title="${escapeHtml(i.label)}: $${i.amount.toLocaleString()}"></div>`).join('')}
          </div>
        `}
        <div class="ew-legend" style="margin-top:18px">
          ${items.map((i) => `
            <div class="ew-legend-row">
              <div class="ew-legend-left"><span class="ew-dot" style="background:${i.color}"></span>${escapeHtml(i.label)}</div>
              <span class="ew-legend-amt">$${i.amount.toLocaleString()} · ${((i.amount / total) * 100).toFixed(0)}%</span>
              ${isStaff ? `<button class="ew-icon-btn" style="margin-left:12px" id="budget-del-${i.id}">${PILL_SVG.trash}</button>` : ''}
            </div>
          `).join('')}
        </div>
      `}
    </section>
  `;

  bindViewToggle('budget-chart', () => renderBudget(main));
  document.getElementById('budgetClientPicker')?.addEventListener('change', (e) => { CACHE.selectedBudgetClient = e.target.value; navigateTo('Budget'); });
  document.getElementById('addBudgetBtn')?.addEventListener('click', () => openBudgetModal(selectedClientId));
  items.forEach((i) => {
    document.getElementById(`budget-del-${i.id}`)?.addEventListener('click', () => {
      confirmModal({
        title: 'Remove this budget item?', message: `"${i.label}" will be removed from this month's allocation.`,
        onConfirm: async () => { await api('DELETE', `/budget/${i.id}`); showToast('Budget item removed'); navigateTo('Budget'); },
      });
    });
  });
}

function budgetPieHtml(items, total) {
  let offset = 25;
  const arcs = items.map((i) => {
    const pct = total > 0 ? (i.amount / total) * 100 : 0;
    const el = `<circle cx="21" cy="21" r="15.9" fill="transparent" stroke="${i.color}" stroke-width="5" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${offset}" stroke-linecap="round"/>`;
    offset -= pct;
    return el;
  }).join('');
  return `
    <div style="display:flex;justify-content:center;padding:10px 0 4px">
      <svg width="180" height="180" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--track)" stroke-width="5"/>
        ${arcs}
        <text x="21" y="20" text-anchor="middle" font-size="5.2" fill="var(--text)" font-weight="600" font-family="Fraunces, serif">$${(total / 1000).toFixed(1)}k</text>
        <text x="21" y="25" text-anchor="middle" font-size="2.4" fill="var(--text-faint)">total spend</text>
      </svg>
    </div>
  `;
}

function openBudgetModal(clientId) {
  openModal(`
    <h2>Add a budget item</h2>
    <form id="budgetForm">
      <div class="ew-field"><label>Channel / category</label><input id="bf-label" type="text" placeholder="e.g. Google Ads, Local Services Ads…" required></div>
      <div class="ew-field"><label>Monthly amount ($)</label><input id="bf-amount" type="number" min="1" step="1" required></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="bf-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary">Add Item</button>
      </div>
    </form>
  `);
  document.getElementById('bf-cancel').addEventListener('click', closeModal);
  document.getElementById('budgetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('bf-label').value.trim();
    const amount = document.getElementById('bf-amount').value;
    if (!label || !amount) return;
    await api('POST', '/budget', { clientId, label, amount });
    closeModal();
    showToast('Budget item added');
    navigateTo('Budget');
  });
}

/* ============ Billing ============ */
async function renderBilling(main) {
  const { enabled, billing } = await api('GET', '/billing/status');

  if (CURRENT_USER.role === 'client') {
    const status = billing?.status || 'no_subscription';
    main.innerHTML = `
      <div class="ew-page-head"><div><h2>Billing</h2><p>Manage your subscription.</p></div></div>
      ${!enabled ? `<div class="ew-info-not-configured">${PILL_SVG.warning} Billing isn't connected yet. Ask your account manager to finish Stripe setup.</div>` : `
        <section class="ew-card ew-billing-plan-card" style="max-width:420px;margin:0 auto">
          <div class="ew-card-title">Standard Plan</div>
          <div class="price">$5<span>/month</span></div>
          <div class="ew-billing-feature">✓ Unlimited support tickets</div>
          <div class="ew-billing-feature">✓ Monthly performance reports</div>
          <div class="ew-billing-feature">✓ Live project &amp; task tracking</div>
          <div style="margin-top:20px">
            <span class="ew-pill ${status === 'active' ? 'pill-ontrack' : 'pill-todo'}">${status === 'active' ? 'Active' : status.replace('_', ' ')}</span>
          </div>
          <button class="ew-btn ew-btn-primary ew-btn-block" id="billingCheckoutBtn" style="margin-top:18px">
            ${status === 'active' ? 'Manage subscription' : 'Subscribe'}
          </button>
        </section>
      `}
    `;
    document.getElementById('billingCheckoutBtn')?.addEventListener('click', async () => {
      try {
        const { url } = await api('POST', '/billing/checkout');
        window.location.href = url;
      } catch (err) { showToast(err.message); }
    });
    return;
  }

  // Staff view: everyone's billing status
  if (CACHE.users.length === 0) CACHE.users = (await api('GET', '/users')).users;
  main.innerHTML = `
    <div class="ew-page-head"><div><h2>Billing</h2><p>Subscription status across all clients.</p></div></div>
    ${!enabled ? `<div class="ew-info-not-configured" style="margin-bottom:16px">${PILL_SVG.warning} Stripe isn't connected yet — see the README for setup steps.</div>` : ''}
    <section class="ew-card">
      ${(billing || []).length === 0 ? emptyState('No billing records yet.') : billing.map((b) => `
        <div class="ew-settings-member-row">
          <div class="info"><div class="name">${clientLabel(b.clientId)}</div><div class="role">${escapeHtml(b.plan || 'standard')}</div></div>
          <span class="ew-pill ${b.status === 'active' ? 'pill-ontrack' : 'pill-todo'}">${escapeHtml(b.status || 'no subscription')}</span>
        </div>
      `).join('')}
    </section>
  `;
}

/* ============ Settings ============ */
async function renderSettings(main) {
  main.innerHTML = `
    <div class="ew-page-head"><div><h2>Settings</h2><p>Manage your profile and appearance.</p></div></div>
    <div class="ew-row-2col">
      <section class="ew-card">
        <div class="ew-card-head"><div class="ew-card-title">Profile</div></div>
        <form id="profileForm">
          <div class="ew-field"><label>Full name</label><input id="sf-name" type="text" value="${escapeHtml(CURRENT_USER.name)}" required></div>
          <div class="ew-field"><label>Email</label><input id="sf-email" type="email" value="${escapeHtml(CURRENT_USER.email)}" required></div>
          <div class="ew-field"><label>New password (leave blank to keep current)</label><input id="sf-password" type="password"></div>
          <button type="submit" class="ew-btn ew-btn-primary">Save changes</button>
        </form>
      </section>
      <section class="ew-card">
        <div class="ew-card-head"><div class="ew-card-title">Preferences</div></div>
        <div class="ew-settings-row">
          <div><div class="label">Appearance</div><div class="desc">Choose dark or light mode</div></div>
          <div class="ew-toggle">
            <button id="settingsDark">Dark</button>
            <button id="settingsLight" class="active">Light</button>
          </div>
        </div>
        <div class="ew-settings-row">
          <div><div class="label">Session</div><div class="desc">Sign out of your account</div></div>
          <button class="ew-btn ew-btn-ghost ew-btn-sm" id="settingsLogout">Log out</button>
        </div>
      </section>
    </div>

    <section class="ew-card" style="margin-top:20px">
      <div class="ew-card-head"><div><div class="ew-card-title">Two-Factor Authentication</div><div class="ew-card-sub">Add an extra verification step at login.</div></div></div>
      ${!APP_CONFIG.firebaseEnabled ? `
        <div class="ew-info-not-configured">${PILL_SVG.warning} Two-factor authentication isn't configured on this server yet. See the README for Firebase setup steps.</div>
      ` : CURRENT_USER.twoFactorEnabled ? `
        <div class="ew-settings-row">
          <div><div class="label">Status</div><div class="desc">Enabled — verifying via ${escapeHtml(CURRENT_USER.twoFactorContact || 'your contact on file')}</div></div>
          <button class="ew-btn ew-btn-ghost ew-btn-sm" id="disable2faBtn">Disable</button>
        </div>
      ` : `
        <div class="ew-settings-row">
          <div><div class="label">Status</div><div class="desc">Not enabled</div></div>
          <button class="ew-btn ew-btn-primary ew-btn-sm" id="enable2faBtn">Set up 2FA</button>
        </div>
      `}
    </section>
  `;

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = { name: document.getElementById('sf-name').value.trim(), email: document.getElementById('sf-email').value.trim() };
    const pw = document.getElementById('sf-password').value;
    if (pw) patch.password = pw;
    const { user } = await api('PUT', '/users/me', patch);
    CURRENT_USER = user;
    document.getElementById('navUserName').textContent = user.name;
    document.getElementById('avatarBtn').textContent = initials(user.name);
    showToast('Settings saved');
  });
  document.getElementById('settingsDark').addEventListener('click', () => { setTheme('dark'); syncSettingsToggle(); });
  document.getElementById('settingsLight').addEventListener('click', () => { setTheme('light'); syncSettingsToggle(); });
  document.getElementById('settingsLogout').addEventListener('click', () => document.getElementById('logoutBtn').click());
  syncSettingsToggle();

  document.getElementById('enable2faBtn')?.addEventListener('click', () => open2FASetupModal());
  document.getElementById('disable2faBtn')?.addEventListener('click', () => {
    confirmModal({
      title: 'Disable two-factor authentication?',
      message: 'Your account will only require a password to sign in.',
      confirmLabel: 'Disable',
      onConfirm: async () => {
        const { user } = await api('POST', '/users/me/2fa/disable');
        CURRENT_USER = user;
        showToast('Two-factor authentication disabled');
        navigateTo('Settings');
      },
    });
  });
}

function open2FASetupModal() {
  openModal(`
    <h2>Set up two-factor authentication</h2>
    <p class="ew-modal-sub">Choose how you'd like to verify it's you at login.</p>
    <div class="ew-modal-actions" style="justify-content:center;gap:14px;margin-bottom:6px">
      <button class="ew-btn ew-btn-ghost" id="setup2faPhone">${PILL_SVG.phone} Phone (SMS code)</button>
      <button class="ew-btn ew-btn-ghost" id="setup2faEmail">${PILL_SVG.mail} Email (secure link)</button>
    </div>
  `);
  document.getElementById('setup2faPhone').addEventListener('click', () => open2FAPhoneModal());
  document.getElementById('setup2faEmail').addEventListener('click', () => open2FAEmailModal());
}

async function ensureFirebaseLoaded() {
  if (!APP_CONFIG.firebaseEnabled) throw new Error('Two-factor authentication is not configured on this server yet.');
  if (!window.EWFirebase2FA) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/firebase2fa.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the verification library.'));
      document.head.appendChild(s);
    });
    await new Promise((r) => setTimeout(r, 50)); // let the module attach window.EWFirebase2FA
  }
  await window.EWFirebase2FA.loadFirebase(APP_CONFIG.firebaseConfig);
}

function open2FAPhoneModal() {
  openModal(`
    <h2>Verify your phone</h2>
    <form id="phoneStep1">
      <div class="ew-field"><label>Phone number</label><input id="p2fa-phone" type="tel" placeholder="+1 415 555 0148" required></div>
      <div id="recaptcha-container"></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="p2fa-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary" id="p2fa-send">Send code</button>
      </div>
    </form>
    <div id="phoneStep2" class="ew-hidden">
      <div class="ew-2fa-code-input">
        ${[0, 1, 2, 3, 4, 5].map((i) => `<input maxlength="1" inputmode="numeric" data-idx="${i}">`).join('')}
      </div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-primary ew-btn-block" id="p2fa-confirm">Confirm code</button>
      </div>
    </div>
  `);
  document.getElementById('p2fa-cancel').addEventListener('click', closeModal);
  document.getElementById('phoneStep1').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sendBtn = document.getElementById('p2fa-send');
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      await ensureFirebaseLoaded();
      const phone = document.getElementById('p2fa-phone').value.trim();
      await window.EWFirebase2FA.sendPhoneCode(phone, 'recaptcha-container');
      document.getElementById('phoneStep1').classList.add('ew-hidden');
      document.getElementById('phoneStep2').classList.remove('ew-hidden');
      document.querySelector('#phoneStep2 input')?.focus();
    } catch (err) {
      showToast(err.message);
      sendBtn.disabled = false; sendBtn.textContent = 'Send code';
    }
  });
  const codeInputs = () => Array.from(document.querySelectorAll('#phoneStep2 input'));
  codeInputs().forEach((input, i) => {
    input.addEventListener('input', () => { if (input.value && codeInputs()[i + 1]) codeInputs()[i + 1].focus(); });
  });
  document.getElementById('p2fa-confirm').addEventListener('click', async () => {
    const code = codeInputs().map((i) => i.value).join('');
    if (code.length !== 6) { showToast('Enter the full 6-digit code'); return; }
    try {
      const firebaseIdToken = await window.EWFirebase2FA.confirmPhoneCode(code);
      const { user } = await api('POST', '/users/me/2fa/enable', { firebaseIdToken });
      CURRENT_USER = user;
      closeModal();
      showToast('Two-factor authentication enabled');
      navigateTo('Settings');
    } catch (err) {
      showToast(err.message);
    }
  });
}

function open2FAEmailModal() {
  openModal(`
    <h2>Verify your email</h2>
    <p class="ew-modal-sub">We'll send a secure sign-in link to your email — click it there to finish setup.</p>
    <form id="emailStep1">
      <div class="ew-field"><label>Email address</label><input id="e2fa-email" type="email" value="${escapeHtml(CURRENT_USER.email)}" required></div>
      <div class="ew-modal-actions">
        <button type="button" class="ew-btn ew-btn-ghost" id="e2fa-cancel">Cancel</button>
        <button type="submit" class="ew-btn ew-btn-primary" id="e2fa-send">Send link</button>
      </div>
    </form>
  `);
  document.getElementById('e2fa-cancel').addEventListener('click', closeModal);
  document.getElementById('emailStep1').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('e2fa-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await ensureFirebaseLoaded();
      await window.EWFirebase2FA.sendEmailSignInLink(document.getElementById('e2fa-email').value.trim());
      document.querySelector('.ew-modal').innerHTML = `
        <h2>Check your email</h2>
        <p class="ew-modal-sub">Click the link we just sent you, then come back — it'll finish setting up 2FA automatically.</p>
        <div class="ew-modal-actions"><button class="ew-btn ew-btn-ghost" onclick="closeModal()">Close</button></div>
      `;
    } catch (err) {
      showToast(err.message);
      btn.disabled = false; btn.textContent = 'Send link';
    }
  });
}
function syncSettingsToggle() {
  const theme = document.getElementById('ewRoot').getAttribute('data-theme');
  document.getElementById('settingsDark')?.classList.toggle('active', theme === 'dark');
  document.getElementById('settingsLight')?.classList.toggle('active', theme === 'light');
}

/* ============ Go ============ */
bootstrap();
