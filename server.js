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

// Returns list of uncovered 30-min slots in [coverStart, coverEnd)
function findCoverageGaps(assignments, coverStart, coverEnd) {
  const gaps = [];
  for (let t = coverStart; t < coverEnd; t += 30) {
    const covered = assignments.some(a => {
      const f = timeToMinutes(a.from);
      const e = timeToMinutes(a.to);
      return f <= t && e > t;
    });
    if (!covered) gaps.push(minutesToTime(t));
  }
  return gaps;
}

function generateShiftPlan(submissions) {
  const conflicts = [];
  const plan = {};

  const employees = submissions.map(s => ({
    ...s,
    assignedHours: 0,
    weeklyTarget: s.employmentType === 'Vollzeit' ? 40
                : s.employmentType === 'Teilzeit' ? 25
                : (s.desiredHoursPerWeek || 10),
    maxHours: s.employmentType === 'Minijobler'
      ? (s.desiredHoursPerWeek || 10)
      : 99 // no hard cap for Vollzeit/Teilzeit
  }));

  for (const day of DAYS) {
    plan[day] = [];
    const isWeekend = WEEKEND_DAYS.has(day);
    const coverStart = isWeekend ? 7 * 60 : 6 * 60;
    const coverEnd   = isWeekend ? 22 * 60 : 23 * 60;

    for (const emp of employees) {
      const avail = emp.availability[day];
      if (!avail || !avail.available) continue;

      const duration = (timeToMinutes(avail.to) - timeToMinutes(avail.from)) / 60;
      if (duration <= 0) continue;

      // For Minijobler: skip this day if adding it would exceed their hour limit
      if (emp.employmentType === 'Minijobler' &&
          emp.assignedHours + duration > emp.maxHours) {
        continue;
      }

      emp.assignedHours += duration;
      plan[day].push({
        from: avail.from,
        to: avail.to,
        name: emp.name,
        employeeId: emp.id,
        employmentType: emp.employmentType
      });
    }

    // Check full-day coverage
    const gaps = findCoverageGaps(plan[day], coverStart, coverEnd);
    if (gaps.length > 0) {
      // Group consecutive gaps into ranges for a readable message
      const rangeStart = gaps[0];
      const rangeEnd = minutesToTime(timeToMinutes(gaps[gaps.length - 1]) + 30);
      conflicts.push(`Lücke in der Abdeckung: ${day} – niemand verfügbar zwischen ${rangeStart} und ${rangeEnd} Uhr`);
    }

    // Check double staffing Mo/Mi/Do 17:00–20:00
    if (DOUBLE_STAFF_DAYS.has(day)) {
      // Find all employees who cover the entire 17–20 window
      const covering = plan[day].filter(a => {
        return timeToMinutes(a.from) <= 17 * 60 && timeToMinutes(a.to) >= 20 * 60;
      });
      if (covering.length < 2) {
        conflicts.push(
          `Doppelbesetzung nicht erfüllt: ${day} 17:00–20:00 ` +
          `(${covering.length} von 2 benötigten Personen verfügbar)`
        );
      }
    }
  }

  // Warn if a Minijobler got fewer hours than desired
  for (const emp of employees) {
    if (emp.employmentType === 'Minijobler' &&
        emp.assignedHours < emp.maxHours) {
      conflicts.push(
        `${emp.name} (Minijobler): ${emp.assignedHours}h eingeplant, ` +
        `gewünscht ${emp.maxHours}h – nicht genug Verfügbarkeit angegeben`
      );
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

// ─── Validation helpers ───────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateTimeString(t) {
  return typeof t === 'string' && TIME_RE.test(t);
}

function validateAvailability(availability) {
  const VALID_DAYS = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
  for (const day of VALID_DAYS) {
    const a = availability[day];
    if (!a) continue;
    if (a.available) {
      if (!validateTimeString(a.from)) return `Ungültige Von-Zeit für ${day}`;
      if (!validateTimeString(a.to))   return `Ungültige Bis-Zeit für ${day}`;
      if (timeToMinutes(a.from) >= timeToMinutes(a.to))
        return `Beginn muss vor Ende liegen (${day})`;
    }
  }
  return null;
}

// ─── Rate limiter for login ───────────────────────────────────────────────────

const loginAttempts = new Map(); // ip → { count, lockedUntil }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) {
    const secs = Math.ceil((entry.lockedUntil - now) / 1000);
    return `Zu viele Fehlversuche. Bitte ${secs}s warten.`;
  }
  return null;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = now + 15 * 60 * 1000; // 15-min lockout
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
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

// POST /api/submit – employee submits (or updates) availability
app.post('/api/submit', (req, res) => {
  const { name, employmentType, desiredHoursPerWeek, availability } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  if (!['Vollzeit', 'Teilzeit', 'Minijobler'].includes(employmentType)) {
    return res.status(400).json({ error: 'Ungültiger Beschäftigungstyp' });
  }
  if (!availability || typeof availability !== 'object') {
    return res.status(400).json({ error: 'Verfügbarkeit fehlt' });
  }

  const availError = validateAvailability(availability);
  if (availError) return res.status(400).json({ error: availError });

  if (employmentType === 'Minijobler') {
    const hours = parseInt(desiredHoursPerWeek);
    if (isNaN(hours) || hours < 1 || hours > 40) {
      return res.status(400).json({ error: 'Gewünschte Stunden müssen zwischen 1 und 40 liegen' });
    }
  }

  const data = readSubmissions();

  // If name already exists → UPDATE the existing entry
  const existingIdx = data.submissions.findIndex(
    s => s.name.toLowerCase().trim() === name.toLowerCase().trim()
  );

  if (existingIdx >= 0) {
    data.submissions[existingIdx] = {
      ...data.submissions[existingIdx],
      updatedAt: new Date().toISOString(),
      employmentType,
      desiredHoursPerWeek: employmentType === 'Minijobler' ? parseInt(desiredHoursPerWeek) : null,
      availability
    };
    writeSubmissions(data);
    return res.json({ success: true, updated: true, count: data.submissions.length, total: EMPLOYEE_COUNT });
  }

  if (data.submissions.length >= EMPLOYEE_COUNT) {
    return res.status(400).json({ error: 'Alle Plätze sind bereits belegt.' });
  }

  const submission = {
    id: uuidv4(),
    submittedAt: new Date().toISOString(),
    name: name.trim(),
    employmentType,
    desiredHoursPerWeek: employmentType === 'Minijobler' ? parseInt(desiredHoursPerWeek) : null,
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

  res.json({ success: true, updated: false, count: data.submissions.length, total: EMPLOYEE_COUNT });
});

// ─── Admin API Routes ─────────────────────────────────────────────────────────

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Passwort erforderlich' });

  const ip = req.ip || 'unknown';
  const rateLimitError = checkLoginRateLimit(ip);
  if (rateLimitError) return res.status(429).json({ error: rateLimitError });

  // Timing-safe comparison
  const inputBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(ADMIN_PASSWORD);
  const match = inputBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(inputBuf, expectedBuf);

  if (!match) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Falsches Passwort' });
  }

  clearLoginFailures(ip);
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

// PUT /api/admin/submissions/:id – admin edits a submission
app.put('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const { employmentType, desiredHoursPerWeek, availability } = req.body;

  if (employmentType && !['Vollzeit', 'Teilzeit', 'Minijobler'].includes(employmentType)) {
    return res.status(400).json({ error: 'Ungültiger Beschäftigungstyp' });
  }
  if (availability) {
    const availError = validateAvailability(availability);
    if (availError) return res.status(400).json({ error: availError });
  }
  if (employmentType === 'Minijobler' && desiredHoursPerWeek !== undefined) {
    const hours = parseInt(desiredHoursPerWeek);
    if (isNaN(hours) || hours < 1 || hours > 40) {
      return res.status(400).json({ error: 'Gewünschte Stunden müssen zwischen 1 und 40 liegen' });
    }
  }

  const data = readSubmissions();
  const idx = data.submissions.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Einreichung nicht gefunden' });

  const updated = { ...data.submissions[idx], updatedAt: new Date().toISOString() };
  if (employmentType)  updated.employmentType = employmentType;
  if (desiredHoursPerWeek !== undefined) {
    updated.desiredHoursPerWeek = updated.employmentType === 'Minijobler'
      ? parseInt(desiredHoursPerWeek) : null;
  }
  if (availability)    updated.availability = availability;

  data.submissions[idx] = updated;
  writeSubmissions(data);
  res.json({ success: true, submission: updated });
});

// POST /api/admin/reset
app.post('/api/admin/reset', requireAdmin, (req, res) => {
  writeSubmissions({ submissions: [] });
  writeShiftPlan({});
  res.json({ success: true });
});

// GET /api/admin/shift-plan/export/csv
app.get('/api/admin/shift-plan/export/csv', requireAdmin, (req, res) => {
  const plan = readShiftPlan();
  if (!plan.generatedAt) return res.status(404).json({ error: 'Noch kein Dienstplan generiert' });

  const DAYS = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
  const rows = [['Tag','Von','Bis','Mitarbeiter','Beschäftigungsart']];

  for (const day of DAYS) {
    const entries = plan.plan[day] || [];
    if (entries.length === 0) {
      rows.push([day,'','','(niemand)','']);
    } else {
      entries.forEach(e => rows.push([day, e.from, e.to, e.name, e.employmentType || '']));
    }
  }

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dienstplan.csv"');
  res.send('\uFEFF' + csv); // BOM for Excel compatibility
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Dienstplan Ersteller läuft auf http://localhost:${PORT}`);
  console.log(`Admin-Dashboard: http://localhost:${PORT}/admin.html`);
});
