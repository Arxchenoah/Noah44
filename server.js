'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const EMPLOYEE_COUNT = parseInt(process.env.EMPLOYEE_COUNT || '11', 10);

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const SHIFT_PLAN_FILE = path.join(DATA_DIR, 'shift-plan.json');

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_FILE)) fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify({ submissions: [] }, null, 2));
if (!fs.existsSync(SHIFT_PLAN_FILE)) fs.writeFileSync(SHIFT_PLAN_FILE, JSON.stringify({}, null, 2));

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ─── File helpers ──────────────────────────────────────────────────────────────

function readSubmissions() {
  return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
}

function writeSubmissions(data) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2));
}

function readShiftPlan() {
  return JSON.parse(fs.readFileSync(SHIFT_PLAN_FILE, 'utf8'));
}

function writeShiftPlan(data) {
  fs.writeFileSync(SHIFT_PLAN_FILE, JSON.stringify(data, null, 2));
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// ─── Scheduling Algorithm ─────────────────────────────────────────────────────

const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKEND_DAYS = new Set(['Samstag', 'Sonntag']);
const DOUBLE_STAFF_DAYS = new Set(['Montag', 'Mittwoch', 'Donnerstag']);

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  const h = Math.floor(m / 60).toString().padStart(2, '0');
  const min = (m % 60).toString().padStart(2, '0');
  return `${h}:${min}`;
}

function buildSlotsForDay(day) {
  const isWeekend = WEEKEND_DAYS.has(day);
  const isDouble = DOUBLE_STAFF_DAYS.has(day);

  // Coverage: weekday 06:00-23:00, weekend 07:00-22:00
  const slots = [];

  if (isWeekend) {
    // Früh: 07:00–15:00, Mittel: 11:00–19:00, Spät: 14:00–22:00
    slots.push({ label: 'Frühschicht',  from: '07:00', to: '15:00' });
    slots.push({ label: 'Mittelschicht', from: '11:00', to: '19:00' });
    slots.push({ label: 'Spätschicht',  from: '14:00', to: '22:00' });
  } else {
    // Früh: 06:00–14:00, Mittel: 11:00–19:00, Spät: 15:00–23:00
    slots.push({ label: 'Frühschicht',  from: '06:00', to: '14:00' });
    slots.push({ label: 'Mittelschicht', from: '11:00', to: '19:00' });
    slots.push({ label: 'Spätschicht',  from: '15:00', to: '23:00' });
    if (isDouble) {
      // Extra slot to ensure double-coverage 17:00–20:00
      slots.push({ label: 'Doppelbesetzung (17–20 Uhr)', from: '17:00', to: '20:00', doubleRequired: true });
    }
  }

  return slots;
}

function employeeCanCoverSlot(employee, day, slot) {
  const avail = employee.availability[day];
  if (!avail || !avail.available) return false;

  const availFrom = timeToMinutes(avail.from);
  const availTo = timeToMinutes(avail.to);
  const slotFrom = timeToMinutes(slot.from);
  const slotTo = timeToMinutes(slot.to);

  return availFrom <= slotFrom && availTo >= slotTo;
}

function getShiftDuration(slot) {
  return (timeToMinutes(slot.to) - timeToMinutes(slot.from)) / 60;
}

function generateShiftPlan(submissions) {
  const conflicts = [];
  const plan = {};

  // Employee state tracking
  const employees = submissions.map(s => ({
    ...s,
    assignedHours: 0,
    assignedDays: new Set(),
    weeklyTarget: s.employmentType === 'Vollzeit' ? 40
                : s.employmentType === 'Teilzeit' ? 25
                : (s.desiredHoursPerWeek || 10),
    maxHours: s.employmentType === 'Minijobler'
      ? (s.desiredHoursPerWeek || 10)
      : (s.employmentType === 'Vollzeit' ? 48 : 35),
    strictHours: s.employmentType === 'Minijobler'
  }));

  // Process double-staff days first
  const orderedDays = [
    ...DAYS.filter(d => DOUBLE_STAFF_DAYS.has(d)),
    ...DAYS.filter(d => !DOUBLE_STAFF_DAYS.has(d))
  ];

  for (const day of orderedDays) {
    plan[day] = [];
    const slots = buildSlotsForDay(day);
    const assignedToday = new Set(); // employee IDs assigned today

    for (const slot of slots) {
      const duration = getShiftDuration(slot);

      // Find eligible employees
      const candidates = employees
        .filter(e => {
          if (assignedToday.has(e.id) && !slot.doubleRequired) return false;
          if (!employeeCanCoverSlot(e, day, slot)) return false;
          if (e.assignedHours + duration > e.maxHours) return false;
          return true;
        })
        .sort((a, b) => {
          // Prefer Minijobler for short slots, balance hours otherwise
          if (slot.doubleRequired) {
            // For double-staffing slot: prefer someone already assigned today
            const aToday = assignedToday.has(a.id) ? 0 : 1;
            const bToday = assignedToday.has(b.id) ? 0 : 1;
            if (aToday !== bToday) return aToday - bToday;
          }
          // Prefer Minijobler (their hours are hard-constrained, assign them first)
          const aIsMini = a.employmentType === 'Minijobler' ? 0 : 1;
          const bIsMini = b.employmentType === 'Minijobler' ? 0 : 1;
          if (aIsMini !== bIsMini) return aIsMini - bIsMini;
          // Balance: fewer assigned hours = higher priority
          return a.assignedHours - b.assignedHours;
        });

      if (candidates.length === 0) {
        plan[day].push({
          label: slot.label,
          from: slot.from,
          to: slot.to,
          name: 'UNBESETZT',
          employmentType: null,
          unassigned: true,
          doubleRequired: slot.doubleRequired || false
        });
        conflicts.push(`Kein Mitarbeiter verfügbar: ${day} ${slot.from}–${slot.to} (${slot.label})`);
        continue;
      }

      const chosen = candidates[0];
      chosen.assignedHours += duration;
      chosen.assignedDays.add(day);
      if (!slot.doubleRequired) {
        assignedToday.add(chosen.id);
      }

      plan[day].push({
        label: slot.label,
        from: slot.from,
        to: slot.to,
        name: chosen.name,
        employeeId: chosen.id,
        employmentType: chosen.employmentType,
        unassigned: false,
        doubleRequired: slot.doubleRequired || false
      });
    }

    // Validate double-staffing for Mo/Mi/Do
    if (DOUBLE_STAFF_DAYS.has(day)) {
      const doubleSlot = plan[day].find(s => s.doubleRequired);
      if (doubleSlot && doubleSlot.unassigned) {
        // Already recorded as conflict
      } else if (doubleSlot) {
        // Check that at least one OTHER person is also covering 17:00-20:00
        const covering = plan[day].filter(s => {
          if (s.unassigned) return false;
          const sFrom = timeToMinutes(s.from);
          const sTo = timeToMinutes(s.to);
          return sFrom <= timeToMinutes('17:00') && sTo >= timeToMinutes('20:00');
        });
        if (covering.length < 2) {
          conflicts.push(`Doppelbesetzung nicht erfüllt: ${day} 17:00–20:00 (nur ${covering.length} Person(en) eingeplant)`);
        }
      }
    }
  }

  // Check weekly hours for each employee
  for (const emp of employees) {
    if (emp.employmentType === 'Vollzeit' && emp.assignedHours < 30) {
      conflicts.push(`${emp.name} (Vollzeit) hat nur ${emp.assignedHours}h/Woche zugeteilt bekommen`);
    }
    if (emp.employmentType === 'Teilzeit' && emp.assignedHours < 15) {
      conflicts.push(`${emp.name} (Teilzeit) hat nur ${emp.assignedHours}h/Woche zugeteilt bekommen`);
    }
    if (emp.strictHours && emp.assignedHours > emp.maxHours) {
      conflicts.push(`${emp.name} (Minijobler) überschreitet gewünschte Stunden: ${emp.assignedHours}h > ${emp.maxHours}h`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    plan,
    conflicts,
    summary: employees.map(e => ({
      name: e.name,
      employmentType: e.employmentType,
      assignedHours: e.assignedHours,
      targetHours: e.weeklyTarget
    }))
  };
}

// ─── Public API Routes ────────────────────────────────────────────────────────

// GET /api/status – submission progress
app.get('/api/status', (req, res) => {
  const data = readSubmissions();
  res.json({
    count: data.submissions.length,
    total: EMPLOYEE_COUNT,
    names: data.submissions.map(s => s.name)
  });
});

// POST /api/submit – employee submits availability
app.post('/api/submit', (req, res) => {
  const { name, employmentType, desiredHoursPerWeek, availability } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  if (!['Vollzeit', 'Teilzeit', 'Minijobler'].includes(employmentType)) {
    return res.status(400).json({ error: 'Ungültiger Beschäftigungstyp' });
  }
  if (!availability || typeof availability !== 'object') {
    return res.status(400).json({ error: 'Verfügbarkeit fehlt' });
  }

  const data = readSubmissions();

  // Check for duplicate name
  const duplicate = data.submissions.find(
    s => s.name.toLowerCase().trim() === name.toLowerCase().trim()
  );
  if (duplicate) {
    return res.status(400).json({ error: `"${name}" hat bereits eine Einreichung abgegeben. Bitte Admin kontaktieren, falls eine Korrektur nötig ist.` });
  }

  if (data.submissions.length >= EMPLOYEE_COUNT) {
    return res.status(400).json({ error: 'Alle Plätze sind bereits belegt. Der Dienstplan wurde bereits erstellt.' });
  }

  const submission = {
    id: uuidv4(),
    submittedAt: new Date().toISOString(),
    name: name.trim(),
    employmentType,
    desiredHoursPerWeek: employmentType === 'Minijobler' ? (parseInt(desiredHoursPerWeek) || 10) : null,
    availability
  };

  data.submissions.push(submission);
  writeSubmissions(data);

  // Auto-generate when all submitted
  if (data.submissions.length === EMPLOYEE_COUNT) {
    try {
      const result = generateShiftPlan(data.submissions);
      writeShiftPlan(result);
    } catch (err) {
      console.error('Auto-generate failed:', err);
    }
  }

  res.json({ success: true, count: data.submissions.length, total: EMPLOYEE_COUNT });
});

// ─── Admin API Routes ─────────────────────────────────────────────────────────

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });

  // Timing-safe comparison
  const inputBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(ADMIN_PASSWORD);
  const match = inputBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(inputBuf, expectedBuf);

  if (!match) return res.status(401).json({ error: 'Falsches Passwort' });

  req.session.isAdmin = true;
  res.json({ success: true });
});

// POST /api/admin/logout
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/admin/submissions
app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const data = readSubmissions();
  res.json({ submissions: data.submissions, count: data.submissions.length, total: EMPLOYEE_COUNT });
});

// POST /api/admin/generate
app.post('/api/admin/generate', requireAdmin, (req, res) => {
  const data = readSubmissions();
  if (data.submissions.length === 0) {
    return res.status(400).json({ error: 'Keine Einreichungen vorhanden' });
  }
  const result = generateShiftPlan(data.submissions);
  writeShiftPlan(result);
  res.json(result);
});

// GET /api/admin/shift-plan
app.get('/api/admin/shift-plan', requireAdmin, (req, res) => {
  const plan = readShiftPlan();
  if (!plan.generatedAt) return res.status(404).json({ error: 'Noch kein Dienstplan generiert' });
  res.json(plan);
});

// DELETE /api/admin/submissions/:id
app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const data = readSubmissions();
  const before = data.submissions.length;
  data.submissions = data.submissions.filter(s => s.id !== req.params.id);
  if (data.submissions.length === before) {
    return res.status(404).json({ error: 'Einreichung nicht gefunden' });
  }
  writeSubmissions(data);
  res.json({ success: true, count: data.submissions.length });
});

// POST /api/admin/reset
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  writeSubmissions({ submissions: [] });
  writeShiftPlan({});
  res.json({ success: true });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Dienstplan Ersteller läuft auf http://localhost:${PORT}`);
  console.log(`Admin-Dashboard: http://localhost:${PORT}/admin.html`);
});
