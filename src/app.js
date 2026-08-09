// The Express app: middleware, views, and every route. No app.listen() here, that differs
// between local dev (server.js) and Vercel's serverless model (api/index.js), both of which
// just require this file and use the exported app differently.
//
// No login and no roster in this version, see CLAUDE.md: every route below is public. Before
// locking this down later, add auth back the way maidthis-nwsa-app does it.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const db = require('./db');
const asyncHandler = require('./async-handler');
const payroll = require('./payroll');
const payStatement = require('./pay-statement');

const app = express();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every request waits for the one-time DB setup (schema) to finish. Free after the first
// request, since db.ready is a cached Promise.
app.use((req, res, next) => {
  db.ready.then(() => next(), next);
});

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Page routes ----------

app.get('/', (req, res) => res.redirect('/payroll'));

app.get('/payroll', (req, res) => {
  res.render('payroll', { active: 'payroll' });
});

// ---------- API routes ----------

app.get('/api/payroll', asyncHandler(async (req, res) => {
  const week = req.query.week;
  if (!week || !DATE_RE.test(week)) {
    return res.status(400).json({ error: 'week query param is required in YYYY-MM-DD format' });
  }
  try {
    const data = await payroll.getPayrollWeek(week);
    res.json(data);
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    res.status(status).json({ error: err.message });
  }
}));

// Shared guard for the three mutating routes below: once a week is locked (money's already
// gone out), further edits are rejected until someone deliberately unlocks it.
async function rejectIfLocked(res, weekStart) {
  const lock = await payroll.getWeekLock(weekStart);
  if (lock) {
    res.status(409).json({ error: 'This pay period is locked. Unlock it first to make changes.' });
    return true;
  }
  return false;
}

app.post('/api/payroll/job-pay', asyncHandler(async (req, res) => {
  const { weekStart, bookingId, cleanerName, amount, serviceName } = req.body;
  const bookingIdNum = parseInt(bookingId, 10);
  if (!weekStart || !DATE_RE.test(weekStart) || !Number.isFinite(bookingIdNum) || !cleanerName) {
    return res.status(400).json({ error: 'weekStart (YYYY-MM-DD), bookingId, and cleanerName are required' });
  }
  if (await rejectIfLocked(res, weekStart)) return;

  const { row } = await payroll.upsertJobPay({ weekStart, bookingId: bookingIdNum, cleanerName, amount, serviceName });
  res.json({ row });
}));

app.post('/api/payroll/adjustments', asyncHandler(async (req, res) => {
  const { weekStart, cleanerName, label, amount, type } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart) || !cleanerName || !label || !String(label).trim()) {
    return res.status(400).json({ error: 'weekStart (YYYY-MM-DD), cleanerName, and label are required' });
  }
  const magnitude = Math.abs(Number(amount));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (await rejectIfLocked(res, weekStart)) return;

  const signedAmount = type === 'deduction' ? -magnitude : magnitude;
  const row = await payroll.addAdjustment({ weekStart, cleanerName, label, amount: signedAmount });
  res.json({ row });
}));

app.post('/api/payroll/adjustments/:id/delete', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid adjustment id' });

  const existing = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Adjustment not found' });
  if (await rejectIfLocked(res, existing.week_start)) return;

  await payroll.removeAdjustment(id);
  res.json({ ok: true });
}));

app.post('/api/payroll/lock', asyncHandler(async (req, res) => {
  const { weekStart } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart)) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) is required' });
  await payroll.lockWeek(weekStart);
  res.json({ ok: true });
}));

app.post('/api/payroll/unlock', asyncHandler(async (req, res) => {
  const { weekStart } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart)) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) is required' });
  await payroll.unlockWeek(weekStart);
  res.json({ ok: true });
}));

// The pay statement itself. Rendered server side (src/pay-statement.js). Omit `cleaner` to get
// every payable cleaner's statement in one response, which is what the batch stepper uses.
app.get('/api/payroll/statement', asyncHandler(async (req, res) => {
  const week = req.query.week;
  if (!week || !DATE_RE.test(week)) {
    return res.status(400).json({ error: 'week query param is required in YYYY-MM-DD format' });
  }
  const data = await payroll.getPayrollWeek(week);
  const payable = data.cleaners.filter((c) => c.name !== 'Unassigned');
  const wanted = req.query.cleaner ? payable.filter((c) => c.name === req.query.cleaner) : payable;
  if (req.query.cleaner && wanted.length === 0) {
    return res.status(404).json({ error: 'No such cleaner in this pay period' });
  }
  res.json({
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    statements: wanted.map((group) => payStatement.buildStatement(group, data.weekStart))
  });
}));

app.get('/api/payroll/export.csv', asyncHandler(async (req, res) => {
  const week = req.query.week;
  if (!week || !DATE_RE.test(week)) {
    return res.status(400).json({ error: 'week query param is required in YYYY-MM-DD format' });
  }
  const data = await payroll.getPayrollWeek(week);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${data.weekStart}.csv"`);
  res.send(payroll.toCsv(data));
}));

// Prefills empty pay boxes from what this cleaner was last paid for the same service. Never
// touches an amount that has already been entered.
app.post('/api/payroll/fill', asyncHandler(async (req, res) => {
  const { weekStart, cleanerName } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart)) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) is required' });
  if (await rejectIfLocked(res, weekStart)) return;

  const filled = await payroll.fillEmptyAmounts({ weekStart, cleanerName: cleanerName || null });
  res.json({ filled });
}));

// Clears a pay row whose clean is no longer in the week.
app.post('/api/payroll/orphans/delete', asyncHandler(async (req, res) => {
  const { weekStart, bookingId } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart)) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) is required' });
  const id = parseInt(bookingId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bookingId' });

  const lock = await payroll.getWeekLock(weekStart);
  if (lock) return res.status(409).json({ error: 'This pay period is locked. Unlock it first.' });

  const removed = await payroll.removeOrphanPay({ weekStart, bookingId: id });
  if (!removed) return res.status(404).json({ error: 'That pay row is already gone.' });

  res.json({ ok: true, removed });
}));

app.post('/api/payroll/mark-sent', asyncHandler(async (req, res) => {
  const { weekStart, cleanerName, totalAtSend } = req.body;
  if (!weekStart || !DATE_RE.test(weekStart) || !cleanerName) {
    return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) and cleanerName are required' });
  }
  const row = await payroll.markSent({ weekStart, cleanerName, totalAtSend });
  res.json({ row });
}));

module.exports = app;
