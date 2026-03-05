'use strict';

const DAYS = [
  { key: 'Montag',     default: { from: '06:00', to: '23:00' } },
  { key: 'Dienstag',   default: { from: '06:00', to: '23:00' } },
  { key: 'Mittwoch',   default: { from: '06:00', to: '23:00' } },
  { key: 'Donnerstag', default: { from: '06:00', to: '23:00' } },
  { key: 'Freitag',    default: { from: '06:00', to: '23:00' } },
  { key: 'Samstag',    default: { from: '07:00', to: '22:00' } },
  { key: 'Sonntag',    default: { from: '07:00', to: '22:00' } }
];

// ── Build availability table ──────────────────────────────────────────────────

function buildAvailTable() {
  const tbody = document.getElementById('availBody');
  DAYS.forEach(day => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="day-label">${day.key}</td>
      <td style="text-align:center;">
        <input type="checkbox" id="avail_${day.key}" data-day="${day.key}" class="avail-check" />
      </td>
      <td>
        <input type="time" id="from_${day.key}" data-day="${day.key}"
               value="${day.default.from}" disabled min="04:00" max="23:00" />
      </td>
      <td>
        <input type="time" id="to_${day.key}" data-day="${day.key}"
               value="${day.default.to}" disabled min="04:00" max="23:59" />
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Toggle time inputs when checkbox changes
  document.querySelectorAll('.avail-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const day = cb.dataset.day;
      const fromInput = document.getElementById(`from_${day}`);
      const toInput = document.getElementById(`to_${day}`);
      fromInput.disabled = !cb.checked;
      toInput.disabled = !cb.checked;
    });
  });
}

// ── Fetch and display progress ────────────────────────────────────────────────

async function loadProgress() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const { count, total, names } = data;
    const pct = Math.round((count / total) * 100);

    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressText').textContent =
      `${count} von ${total} Mitarbeitern haben ihre Verfügbarkeit eingetragen`;

    if (count >= total) {
      document.getElementById('allDoneMsg').classList.remove('hidden');
      document.getElementById('formCard').classList.add('hidden');
    }
  } catch (e) {
    document.getElementById('progressText').textContent = 'Fortschritt nicht verfügbar';
  }
}

// ── Collect form data ─────────────────────────────────────────────────────────

function collectFormData() {
  const name = document.getElementById('empName').value.trim();
  const empTypeEl = document.querySelector('input[name="employmentType"]:checked');
  const employmentType = empTypeEl ? empTypeEl.value : null;
  const desiredHoursEl = document.getElementById('desiredHours');
  const desiredHoursPerWeek = employmentType === 'Minijobler'
    ? parseInt(desiredHoursEl.value, 10) || null
    : null;

  const availability = {};
  DAYS.forEach(day => {
    const cb = document.getElementById(`avail_${day.key}`);
    if (cb.checked) {
      const from = document.getElementById(`from_${day.key}`).value;
      const to = document.getElementById(`to_${day.key}`).value;
      availability[day.key] = { available: true, from, to };
    } else {
      availability[day.key] = { available: false, from: null, to: null };
    }
  });

  return { name, employmentType, desiredHoursPerWeek, availability };
}

// ── Validate ─────────────────────────────────────────────────────────────────

function validate(data) {
  if (!data.name) return 'Bitte geben Sie Ihren Namen ein.';
  if (!data.employmentType) return 'Bitte wählen Sie Ihre Beschäftigungsart aus.';
  if (data.employmentType === 'Minijobler' && !data.desiredHoursPerWeek) {
    return 'Bitte geben Sie Ihre gewünschten Stunden pro Woche an.';
  }

  const anyAvail = Object.values(data.availability).some(a => a.available);
  if (!anyAvail) return 'Bitte wählen Sie mindestens einen verfügbaren Tag aus.';

  for (const [day, avail] of Object.entries(data.availability)) {
    if (!avail.available) continue;
    if (!avail.from || !avail.to) return `Bitte geben Sie die Uhrzeiten für ${day} an.`;
    if (avail.from >= avail.to) return `Die Startzeit für ${day} muss vor der Endzeit liegen.`;
  }

  return null;
}

// ── Show error ────────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError() {
  const el = document.getElementById('formError');
  el.textContent = '';
  el.classList.add('hidden');
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function handleSubmit(e) {
  e.preventDefault();
  clearError();

  const data = collectFormData();
  const error = validate(data);
  if (error) { showError(error); return; }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Wird gesendet…';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();

    if (!res.ok) {
      showError(result.error || 'Ein Fehler ist aufgetreten.');
      btn.disabled = false;
      btn.textContent = '✅ Verfügbarkeit einreichen';
      return;
    }

    // Show success
    document.getElementById('formCard').classList.add('hidden');
    const successCard = document.getElementById('successCard');
    successCard.classList.remove('hidden');
    const updateNote = result.updated ? ' (Deine Angaben wurden aktualisiert.)' : '';
    document.getElementById('successText').textContent =
      `${result.count} von ${result.total} Mitarbeitern haben jetzt eingereicht.${updateNote}` +
      (result.count >= result.total
        ? ' Der Dienstplan wird automatisch erstellt!'
        : ' Sobald alle eingetragen haben, wird der Dienstplan erstellt.');

    // Update progress
    loadProgress();

  } catch (err) {
    showError('Netzwerkfehler. Bitte versuchen Sie es erneut.');
    btn.disabled = false;
    btn.textContent = '✅ Verfügbarkeit einreichen';
  }
}

// ── Employment type toggle ────────────────────────────────────────────────────

function setupEmploymentToggle() {
  document.querySelectorAll('input[name="employmentType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isMini = radio.value === 'Minijobler';
      document.getElementById('minijobFields').classList.toggle('hidden', !isMini);
      document.getElementById('desiredHours').required = isMini;
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  buildAvailTable();
  loadProgress();
  setupEmploymentToggle();
  document.getElementById('availabilityForm').addEventListener('submit', handleSubmit);
});
