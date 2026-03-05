'use strict';

let pollInterval = null;

// ── Utilities ────────────────────────────────────────────────────────────────

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function typeBadge(type) {
  const cls = type === 'Vollzeit' ? 'vollzeit'
    : type === 'Teilzeit' ? 'teilzeit'
    : 'minijobler';
  return `<span class="badge badge--${cls}">${type}</span>`;
}

// ── Login ────────────────────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('adminPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Wird angemeldet…';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'Anmeldung fehlgeschlagen';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Anmelden';
      return;
    }

    showDashboard();
  } catch {
    errEl.textContent = 'Netzwerkfehler';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
}

// ── Logout ───────────────────────────────────────────────────────────────────

async function handleLogout() {
  await fetch('/api/admin/logout', { method: 'POST' });
  clearInterval(pollInterval);
  document.getElementById('dashboardPanel').classList.add('hidden');
  document.getElementById('loginPanel').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.add('hidden');
  document.getElementById('adminPassword').value = '';
}

// ── Show dashboard ───────────────────────────────────────────────────────────

function showDashboard() {
  document.getElementById('loginPanel').classList.add('hidden');
  document.getElementById('dashboardPanel').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.remove('hidden');
  loadDashboard();
  // Auto-poll every 30s
  pollInterval = setInterval(loadDashboard, 30000);
}

// ── Load dashboard data ───────────────────────────────────────────────────────

async function loadDashboard() {
  await Promise.all([loadSubmissions(), loadShiftPlan()]);
}

async function loadSubmissions() {
  try {
    const res = await fetch('/api/admin/submissions');
    if (res.status === 401) { handleLogout(); return; }
    const data = await res.json();
    renderSubmissions(data);
    updateProgress(data.count, data.total);
  } catch (err) {
    console.error('loadSubmissions error:', err);
  }
}

async function loadShiftPlan() {
  try {
    const res = await fetch('/api/admin/shift-plan');
    if (res.status === 404) return; // not yet generated
    if (res.status === 401) return;
    const data = await res.json();
    renderShiftPlan(data);
  } catch (err) {
    console.error('loadShiftPlan error:', err);
  }
}

// ── Render submissions ────────────────────────────────────────────────────────

function renderSubmissions(data) {
  const list = document.getElementById('submissionsList');
  const countEl = document.getElementById('submissionCount');
  countEl.textContent = `(${data.count} / ${data.total})`;

  if (!data.submissions || data.submissions.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted); font-size:.875rem;">Noch keine Einreichungen.</p>';
    return;
  }

  list.innerHTML = data.submissions.map(s => `
    <div class="submission-item">
      <div class="submission-item__info">
        <div class="submission-item__name">${escHtml(s.name)}</div>
        <div class="submission-item__meta">
          ${typeBadge(s.employmentType)}
          ${s.desiredHoursPerWeek ? `&nbsp;• ${s.desiredHoursPerWeek}h/Woche` : ''}
          &nbsp;• Eingereicht: ${formatDate(s.submittedAt)}
        </div>
      </div>
      <button class="btn btn--outline btn--sm"
              onclick="deleteSubmission('${s.id}', '${escHtml(s.name)}')"
              title="Einreichung löschen">✕</button>
    </div>
  `).join('');
}

function updateProgress(count, total) {
  const pct = Math.round((count / total) * 100);
  document.getElementById('adminProgressBar').style.width = pct + '%';
  document.getElementById('adminProgressText').textContent =
    `${count} von ${total} Mitarbeitern haben ihre Verfügbarkeit eingetragen`;
  const genBtn = document.getElementById('generateBtn');
  if (count >= total) {
    genBtn.textContent = '⚡ Dienstplan generieren (alle eingereicht)';
  }
}

// ── Render shift plan ─────────────────────────────────────────────────────────

function renderShiftPlan(data) {
  const card = document.getElementById('shiftPlanCard');
  card.classList.remove('hidden');

  document.getElementById('planGeneratedAt').textContent =
    `— erstellt am ${formatDate(data.generatedAt)}`;

  // Conflicts
  const conflictsBox = document.getElementById('conflictsBox');
  if (data.conflicts && data.conflicts.length > 0) {
    conflictsBox.classList.remove('hidden');
    conflictsBox.innerHTML = `<strong>⚠️ Hinweise / Konflikte:</strong><ul style="margin-top:.5rem; padding-left:1.25rem;">` +
      data.conflicts.map(c => `<li>${escHtml(c)}</li>`).join('') +
      '</ul>';
  } else {
    conflictsBox.classList.add('hidden');
  }

  // Calendar
  renderCalendar(document.getElementById('calendarWrap'), data);

  // Summary table
  const tbody = document.getElementById('summaryBody');
  if (data.summary) {
    tbody.innerHTML = data.summary.map(e => {
      const diff = e.assignedHours - e.targetHours;
      const diffStr = diff >= 0
        ? `<span style="color:var(--success)">+${diff}h</span>`
        : `<span style="color:var(--danger)">${diff}h</span>`;
      return `
        <tr>
          <td>${escHtml(e.name)}</td>
          <td>${typeBadge(e.employmentType)}</td>
          <td><strong>${e.assignedHours}h</strong></td>
          <td>${e.targetHours}h &nbsp;${diffStr}</td>
        </tr>
      `;
    }).join('');
  }
}

// ── Delete submission ─────────────────────────────────────────────────────────

async function deleteSubmission(id, name) {
  if (!confirm(`Einreichung von "${name}" wirklich löschen?`)) return;
  try {
    const res = await fetch(`/api/admin/submissions/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Löschen fehlgeschlagen');
      return;
    }
    loadSubmissions();
  } catch (err) {
    alert('Netzwerkfehler');
  }
}

// ── Generate shift plan ───────────────────────────────────────────────────────

async function handleGenerate() {
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Wird generiert…';
  try {
    const res = await fetch('/api/admin/generate', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Generierung fehlgeschlagen');
      return;
    }
    renderShiftPlan(data);
  } catch (err) {
    alert('Netzwerkfehler');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Dienstplan generieren';
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

async function handleReset() {
  if (!confirm('Wirklich ALLE Einreichungen und den Dienstplan löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
  try {
    const res = await fetch('/api/admin/reset', { method: 'POST' });
    if (!res.ok) { alert('Zurücksetzen fehlgeschlagen'); return; }
    document.getElementById('shiftPlanCard').classList.add('hidden');
    loadDashboard();
  } catch {
    alert('Netzwerkfehler');
  }
}

// ── HTML escape ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('generateBtn').addEventListener('click', handleGenerate);
  document.getElementById('refreshBtn').addEventListener('click', loadDashboard);
  document.getElementById('resetBtn').addEventListener('click', handleReset);

  // Check if already logged in (session still valid)
  fetch('/api/admin/submissions')
    .then(res => { if (res.ok) showDashboard(); })
    .catch(() => {});
});
