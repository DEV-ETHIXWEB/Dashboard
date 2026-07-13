'use strict';

/* ============ State ============ */
let CURRENT_USER = null;
let CSRF_TOKEN = null;
let ACTIVE_VIEW = 'Dashboard';
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
  Settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const ROLE_LABEL = { admin: 'Admin', sales: 'Sales', project_manager: 'Project Manager', employee: 'Employee', client: 'Client' };
const ROLE_NAV = {
  admin: ['Dashboard', 'Projects', 'Tasks', 'Tickets', 'Team', 'Notifications', 'Settings'],
  sales: ['Dashboard', 'Projects', 'Tickets', 'Notifications', 'Settings'],
  project_manager: ['Dashboard', 'Projects', 'Tasks', 'Tickets', 'Notifications', 'Settings'],
  employee: ['Dashboard', 'Tasks', 'Tickets', 'Notifications', 'Settings'],
  client: ['Dashboard', 'Projects', 'Tickets', 'Notifications', 'Settings'],
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
  host.innerHTML = `<div class="ew-toast">✓ ${escapeHtml(msg)}</div>`;
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
  document.body.appendChild(overlay);
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

  document.getElementById('navUserName').textContent = CURRENT_USER.name;
  document.getElementById('navUserRole').textContent = ROLE_LABEL[CURRENT_USER.role] || CURRENT_USER.role;
  document.getElementById('avatarBtn').textContent = initials(CURRENT_USER.name);

  renderNav();
  bindTopbar();
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
    else if (view === 'Team') await renderTeam(main);
    else if (view === 'Notifications') await renderNotifications(main);
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

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Projects</h2><p>Every active engagement across your account.</p></div>
      ${canCreate ? `<button class="ew-btn ew-btn-primary" id="addProjectBtn">+ Add Project</button>` : ''}
    </div>
    <section class="ew-card">
      ${projects.length === 0 ? emptyState('No projects yet.') : projects.map((p) => projectDetailRow(p, canDelete)).join('')}
    </section>
  `;

  if (canCreate) document.getElementById('addProjectBtn').addEventListener('click', () => openProjectModal());
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

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Tasks</h2><p>Work items linked to your active projects.</p></div>
      ${canManage ? `<button class="ew-btn ew-btn-primary" id="addTaskBtn">+ Add Task</button>` : ''}
    </div>
    <section class="ew-card">
      ${tasks.length === 0 ? emptyState('No tasks yet.') : `
        <table class="ew-table">
          <thead><tr><th>Task</th><th>Project</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Due</th>${canManage ? '<th></th>' : ''}</tr></thead>
          <tbody>${tasks.map((t) => taskRowHtml(t, canManage)).join('')}</tbody>
        </table>
      `}
    </section>
  `;

  if (canManage) document.getElementById('addTaskBtn').addEventListener('click', () => openTaskModal());
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
      ${canManage ? `<td style="display:flex;gap:6px"><button class="ew-icon-btn" style="margin-left:0" id="task-edit-${t.id}">✎</button><button class="ew-icon-btn" id="task-delete-${t.id}">🗑</button></td>` : ''}
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
  const canCreate = true; // everyone can raise a ticket

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Support Tickets</h2><p>Client requests and internal follow-ups.</p></div>
      ${canCreate ? `<button class="ew-btn ew-btn-primary" id="addTicketBtn">+ Create Ticket</button>` : ''}
    </div>
    <section class="ew-card">
      ${tickets.length === 0 ? emptyState('No tickets yet.') : tickets.map((t) => ticketRowHtml(t, canAssign)).join('')}
    </section>
  `;

  document.getElementById('addTicketBtn')?.addEventListener('click', () => openTicketModal());
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
          <button class="ew-icon-btn" style="margin-left:0" id="user-edit-${u.id}">✎</button>
          ${u.id !== CURRENT_USER.id ? `<button class="ew-icon-btn" id="user-delete-${u.id}">🗑</button>` : ''}
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
async function renderNotifications(main) {
  const { notifications } = await api('GET', '/notifications');
  CACHE.notifications = notifications;
  const unread = notifications.filter((n) => !n.read).length;

  main.innerHTML = `
    <div class="ew-page-head">
      <div><h2>Notifications</h2><p>${unread > 0 ? `${unread} unread` : "You're all caught up"}</p></div>
      <div style="display:flex;gap:10px">
        <button class="ew-btn ew-btn-ghost ew-btn-sm" id="markAllBtn" ${unread === 0 ? 'disabled' : ''}>Mark all read</button>
        <button class="ew-btn ew-btn-ghost ew-btn-sm" id="clearAllBtn" ${notifications.length === 0 ? 'disabled' : ''}>Clear all</button>
      </div>
    </div>
    <section class="ew-card">
      ${notifications.length === 0 ? emptyState('No notifications right now.') : notifications.map((n) => `
        <div class="ew-notif-row" style="align-items:center">
          <div class="ew-notif-icon">🔔</div>
          <div style="flex:1"><div class="ew-notif-text">${escapeHtml(n.message)}</div><div class="ew-notif-time">${new Date(n.createdAt).toLocaleString()}</div></div>
          ${!n.read ? `<button class="ew-btn ew-btn-ghost ew-btn-sm" id="notif-read-${n.id}">Mark read</button>` : `<span class="ew-notif-time">Read</span>`}
        </div>
      `).join('')}
    </section>
  `;

  document.getElementById('markAllBtn').addEventListener('click', async () => { await api('POST', '/notifications/read-all'); showToast('All marked as read'); navigateTo('Notifications'); });
  document.getElementById('clearAllBtn').addEventListener('click', async () => { await api('DELETE', '/notifications'); showToast('Notifications cleared'); navigateTo('Notifications'); });
  notifications.forEach((n) => {
    document.getElementById(`notif-read-${n.id}`)?.addEventListener('click', async () => { await api('PATCH', `/notifications/${n.id}/read`); navigateTo('Notifications'); });
  });
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
}
function syncSettingsToggle() {
  const theme = document.getElementById('ewRoot').getAttribute('data-theme');
  document.getElementById('settingsDark')?.classList.toggle('active', theme === 'dark');
  document.getElementById('settingsLight')?.classList.toggle('active', theme === 'light');
}

/* ============ Go ============ */
bootstrap();
