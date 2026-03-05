'use strict';

/**
 * Renders the weekly shift plan into a given container element.
 * Each column = one day. Each cell lists the employees working that day.
 */
function renderCalendar(container, planData) {
  const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const DOUBLE_DAYS = new Set(['Montag', 'Mittwoch', 'Donnerstag']);
  const plan = planData.plan || {};

  const table = document.createElement('table');
  table.className = 'calendar-table';

  // ── Header ──────────────────────────────────────────────────────────────────
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  DAYS.forEach(day => {
    const th = document.createElement('th');
    if (DOUBLE_DAYS.has(day)) {
      th.className = 'double-day';
      th.title = 'Doppelbesetzung 17–20 Uhr erforderlich';
      th.innerHTML = `${day}<br><span style="font-size:.72rem;font-weight:400;">★ Doppelbesetzung 17–20h</span>`;
    } else {
      th.textContent = day;
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // ── Body: one row per "position" (1st employee of day, 2nd, …) ─────────────
  const maxPerDay = Math.max(...DAYS.map(d => (plan[d] || []).length), 0);

  const tbody = document.createElement('tbody');

  if (maxPerDay === 0) {
    const tr = document.createElement('tr');
    DAYS.forEach(() => {
      const td = document.createElement('td');
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-muted)';
      td.style.padding = '1rem';
      td.textContent = '–';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  } else {
    for (let i = 0; i < maxPerDay; i++) {
      const tr = document.createElement('tr');

      DAYS.forEach(day => {
        const td = document.createElement('td');
        const dayEntries = plan[day] || [];
        const entry = dayEntries[i];

        if (!entry) {
          td.style.background = '#fafafa';
          tr.appendChild(td);
          return;
        }

        const block = document.createElement('div');
        block.className = 'shift-block';

        const type = (entry.employmentType || '').toLowerCase();
        if (type === 'vollzeit')        block.classList.add('shift-block--vollzeit');
        else if (type === 'teilzeit')   block.classList.add('shift-block--teilzeit');
        else if (type === 'minijobler') block.classList.add('shift-block--minijobler');
        else                            block.classList.add('shift-block--vollzeit');

        // Highlight if this person covers the double-staffing window
        const isDoubleDay = DOUBLE_DAYS.has(day);
        const coversDouble = isDoubleDay &&
          toMin(entry.from) <= 17 * 60 &&
          toMin(entry.to)   >= 20 * 60;

        block.innerHTML = `
          <div class="shift-block__time">${entry.from} – ${entry.to} Uhr</div>
          <div class="shift-block__name">${escHtml(entry.name)}</div>
          ${coversDouble ? '<div class="shift-block__label">✔ 17–20h abgedeckt</div>' : ''}
        `;
        td.appendChild(block);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
