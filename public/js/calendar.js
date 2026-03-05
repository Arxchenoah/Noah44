'use strict';

/**
 * Renders the weekly shift plan into a given container element.
 * @param {HTMLElement} container
 * @param {Object} planData  - The full plan object from /api/admin/shift-plan
 */
function renderCalendar(container, planData) {
  const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const DOUBLE_DAYS = new Set(['Montag', 'Mittwoch', 'Donnerstag']);
  const plan = planData.plan || {};

  const table = document.createElement('table');
  table.className = 'calendar-table';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  // Empty corner
  const cornerTh = document.createElement('th');
  cornerTh.textContent = 'Schicht';
  headerRow.appendChild(cornerTh);

  DAYS.forEach(day => {
    const th = document.createElement('th');
    th.textContent = day;
    if (DOUBLE_DAYS.has(day)) {
      th.className = 'double-day';
      th.title = 'Doppelbesetzung 17–20 Uhr erforderlich';
      th.textContent = day + ' ★';
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Collect unique slot labels across all days
  const allLabels = new Set();
  DAYS.forEach(day => {
    (plan[day] || []).forEach(s => allLabels.add(s.label));
  });

  const tbody = document.createElement('tbody');

  allLabels.forEach(label => {
    const tr = document.createElement('tr');

    // Row header
    const labelTd = document.createElement('td');
    labelTd.style.fontWeight = '600';
    labelTd.style.fontSize = '.8rem';
    labelTd.style.color = 'var(--text-muted)';
    labelTd.style.background = 'var(--bg)';
    labelTd.textContent = label;
    tr.appendChild(labelTd);

    DAYS.forEach(day => {
      const td = document.createElement('td');
      const dayShifts = (plan[day] || []).filter(s => s.label === label);

      if (dayShifts.length === 0) {
        td.style.background = '#fafafa';
        tr.appendChild(td);
        return;
      }

      dayShifts.forEach(shift => {
        const block = document.createElement('div');
        block.className = 'shift-block';

        if (shift.unassigned) {
          block.classList.add('shift-block--unassigned');
        } else if (shift.doubleRequired) {
          block.classList.add('shift-block--double');
        } else {
          const type = (shift.employmentType || '').toLowerCase();
          if (type === 'vollzeit')   block.classList.add('shift-block--vollzeit');
          else if (type === 'teilzeit')   block.classList.add('shift-block--teilzeit');
          else if (type === 'minijobler') block.classList.add('shift-block--minijobler');
          else block.classList.add('shift-block--vollzeit');
        }

        block.innerHTML = `
          <div class="shift-block__time">${shift.from} – ${shift.to}</div>
          <div class="shift-block__name">${shift.name}</div>
        `;
        td.appendChild(block);
      });

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}
