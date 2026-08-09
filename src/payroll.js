// Builds the weekly Cleaner Payroll payload: that week's ConvertLabs bookings grouped by
// assigned cleaner, merged with whatever pay amounts and adjustments have been entered by hand
// for that week (see src/schema.sql, payroll_job_pay / payroll_adjustments). ConvertLabs has no
// payout data in its API, so the per-job amount a cleaner is actually paid is manual entry.

const db = require('./db');
const convertlabs = require('./convertlabs');

function round2(n) {
  return Math.round(n * 100) / 100;
}

// The first assigned team member's short title (e.g. "Gina T.") is the join key against
// cleaners.name.
function matchCleanerNameFromBooking(booking) {
  if (!booking.teams || booking.teams.length === 0) return null;
  return booking.teams[0].title || booking.teams[0].fullName || null;
}

// Snaps any date to the Monday of its week so a stray non-Monday query param can't split a
// week's data across two payroll periods.
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  date.setDate(date.getDate() + (dow === 0 ? -6 : 1 - dow));
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Common labels offered under the adjustment form. Real ones typed before rank above these, see
// adjustmentPresets below, this is only what a brand new week starts with.
const DEFAULT_ADJUSTMENT_LABELS = [
  'Review bonus',
  'Room turn',
  'Drive time',
  'Supplies reimbursement',
  'Missed payment correction'
];

async function adjustmentPresets() {
  const rows = await db.prepare(`
    SELECT label, COUNT(*)::int AS uses
    FROM   payroll_adjustments
    WHERE  label <> ''
    GROUP  BY label
    HAVING COUNT(*) > 1
    ORDER  BY uses DESC, MAX(id) DESC
    LIMIT  8
  `).all();

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.label.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.label.trim());
  }
  for (const label of DEFAULT_ADJUSTMENT_LABELS) {
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out.slice(0, 8);
}

async function getPayrollWeek(rawWeekStart) {
  const weekStart = mondayOf(rawWeekStart);
  const weekEnd = addDays(weekStart, 6);

  const bookings = await convertlabs.getBookingsForRange(weekStart, weekEnd);
  const activeBookings = bookings.filter((b) => b.status !== 'cancelled');
  const activeIds = activeBookings.map((b) => Number(b.id)).filter((n) => Number.isFinite(n));

  const [payRows, adjustmentRows, lockRow, sentRows, lastPaidRows, cleanerRows, presets, ytdRows] = await Promise.all([
    db.prepare('SELECT booking_id, amount, week_start FROM payroll_job_pay WHERE week_start = ? OR booking_id = ANY(?)')
      .all(weekStart, activeIds),
    db.prepare('SELECT id, cleaner_name, label, amount FROM payroll_adjustments WHERE week_start = ? ORDER BY id').all(weekStart),
    db.prepare('SELECT locked_at, locked_by FROM payroll_week_locks WHERE week_start = ?').get(weekStart),
    db.prepare(`
      SELECT cleaner_name, sent_at, total_at_send, sent_by
      FROM payroll_sent_log
      WHERE week_start = ? ORDER BY sent_at DESC
    `).all(weekStart),
    db.prepare(`
      SELECT DISTINCT ON (cleaner_name, service_name) cleaner_name, service_name, amount
      FROM   payroll_job_pay
      WHERE  service_name IS NOT NULL AND week_start <> ?
      ORDER  BY cleaner_name, service_name, updated_at DESC
    `).all(weekStart),
    db.prepare('SELECT name, email, status FROM cleaners ORDER BY name').all(),
    adjustmentPresets(),
    db.prepare(`
      SELECT cleaner_name, SUM(amount)::float8 AS total FROM (
        SELECT cleaner_name, amount FROM payroll_job_pay     WHERE week_start >= ?
        UNION ALL
        SELECT cleaner_name, amount FROM payroll_adjustments WHERE week_start >= ?
      ) paid
      GROUP BY cleaner_name
    `).all(weekStart.slice(0, 4) + '-01-01', weekStart.slice(0, 4) + '-01-01')
  ]);
  const activeIdSet = new Set(activeIds.map(String));
  const payByBookingId = new Map(
    payRows.filter((r) => activeIdSet.has(String(r.booking_id))).map((r) => [String(r.booking_id), r.amount])
  );
  const emailByName = new Map(cleanerRows.map((r) => [r.name, r.email || null]));
  const ytdByCleaner = new Map(ytdRows.map((r) => [r.cleaner_name, round2(r.total)]));

  // A booking rescheduled into this week drags a pay row still stamped with its old week. Correct
  // it here rather than leave it stranded.
  const misfiled = payRows.filter((r) => activeIdSet.has(String(r.booking_id)) && r.week_start !== weekStart);
  for (const row of misfiled) {
    await db.prepare('UPDATE payroll_job_pay SET week_start = ? WHERE booking_id = ?').run(weekStart, row.booking_id);
  }

  const lastPaidKey = (cleaner, service) => `${cleaner || '*'} ${service || ''}`;
  const lastPaid = new Map(lastPaidRows.map((r) => [lastPaidKey(r.cleaner_name, r.service_name), r.amount]));

  function suggestFor(cleanerName, serviceName) {
    if (!serviceName) return { amount: null, source: null };
    const previous = lastPaid.get(lastPaidKey(cleanerName, serviceName));
    if (previous !== undefined) return { amount: previous, source: 'last-paid' };
    return { amount: null, source: null };
  }

  // sentRows is newest-first, so the first row seen per cleaner is their most recent send.
  const lastSentByCleaner = new Map();
  const sentHistoryByCleaner = new Map();
  for (const row of sentRows) {
    const entry = { sentAt: row.sent_at, totalAtSend: row.total_at_send, sentByName: row.sent_by };
    if (!lastSentByCleaner.has(row.cleaner_name)) lastSentByCleaner.set(row.cleaner_name, entry);
    if (!sentHistoryByCleaner.has(row.cleaner_name)) sentHistoryByCleaner.set(row.cleaner_name, []);
    sentHistoryByCleaner.get(row.cleaner_name).push(entry);
  }

  const byCleaner = new Map();
  function getGroup(name) {
    if (!byCleaner.has(name)) byCleaner.set(name, { name, jobs: [], adjustments: [] });
    return byCleaner.get(name);
  }

  for (const b of activeBookings) {
    const cleanerName = matchCleanerNameFromBooking(b) || 'Unassigned';
    const group = getGroup(cleanerName);
    const serviceName = b.service ? b.service.name : null;
    const amount = payByBookingId.has(String(b.id)) ? payByBookingId.get(String(b.id)) : null;
    const suggestion = suggestFor(cleanerName, serviceName);

    const grandTotal = b.pricing.total ?? b.pricing.calculatedTotal ?? 0;
    const revenue = round2(grandTotal - (b.pricing.tip || 0));

    const trackedMinutes = (b.teams || []).reduce(
      (sum, member) => sum + (member.timeTracking && member.timeTracking.trackedDurationMinutes ? member.timeTracking.trackedDurationMinutes : 0),
      0
    );

    group.jobs.push({
      bookingId: b.id,
      serviceDateOnly: b.serviceDateOnly,
      status: b.status,
      customerFirstName: (b.customer && b.customer.firstName) || 'Unknown',
      address: b.address,
      addressRaw: b.addressRaw,
      service: serviceName,
      frequencyName: b.frequency ? b.frequency.name : null,
      amount,
      suggestedAmount: suggestion.amount,
      suggestedSource: suggestion.source,
      trackedMinutes: trackedMinutes || null,
      payExceedsRevenue: amount !== null && revenue > 0 && amount > revenue,
      zeroWithTime: amount === 0 && trackedMinutes > 0
    });
  }

  for (const row of adjustmentRows) {
    const group = getGroup(row.cleaner_name);
    group.adjustments.push({ id: row.id, label: row.label, amount: row.amount });
  }

  const cleaners = Array.from(byCleaner.values())
    .map((group) => {
      group.jobs.sort((a, b) => a.serviceDateOnly.localeCompare(b.serviceDateOnly));
      const jobsTotal = round2(group.jobs.reduce((sum, j) => sum + (j.amount || 0), 0));
      const adjustmentsTotal = round2(group.adjustments.reduce((sum, a) => sum + a.amount, 0));
      const missingAmounts = group.jobs.filter((j) => j.amount === null).length;
      return {
        ...group,
        email: emailByName.get(group.name) || null,
        jobsTotal,
        adjustmentsTotal,
        grandTotal: round2(jobsTotal + adjustmentsTotal),
        missingAmounts,
        ready: missingAmounts === 0 && round2(jobsTotal + adjustmentsTotal) > 0,
        sendable: missingAmounts === 0 && round2(jobsTotal + adjustmentsTotal) > 0 && !!emailByName.get(group.name),
        fillableCount: group.jobs.filter((j) => j.amount === null && j.suggestedAmount !== null).length,
        flaggedCount: group.jobs.filter((j) => j.payExceedsRevenue).length,
        zeroWithTimeCount: group.jobs.filter((j) => j.zeroWithTime).length,
        yearToDate: ytdByCleaner.get(group.name) || 0,
        sentHistory: sentHistoryByCleaner.get(group.name) || [],
        lastSent: lastSentByCleaner.get(group.name) || null
      };
    })
    .sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return a.name.localeCompare(b.name);
    });

  // Pay rows still filed under this week whose clean is no longer in it.
  const orphans = [];
  const stranded = payRows.filter((r) => r.week_start === weekStart && !activeIdSet.has(String(r.booking_id)));
  for (const row of stranded) {
    let reason = 'missing';
    let detail = null;
    try {
      const raw = await convertlabs.getBookingRawById(row.booking_id);
      if (raw) {
        const when = typeof raw.service_date === 'string' ? raw.service_date.slice(0, 10) : null;
        if (raw.status === 'cancelled') {
          reason = 'cancelled';
          detail = when;
        } else if (when && (when < weekStart || when > weekEnd)) {
          await db.prepare('UPDATE payroll_job_pay SET week_start = ? WHERE booking_id = ?').run(mondayOf(when), row.booking_id);
          continue;
        } else {
          reason = 'not-on-schedule';
          detail = when;
        }
      }
    } catch (err) {
      reason = 'unknown';
    }

    const payRow = await db.prepare('SELECT cleaner_name, amount FROM payroll_job_pay WHERE booking_id = ?').get(row.booking_id);
    orphans.push({
      bookingId: row.booking_id,
      cleanerName: payRow ? payRow.cleaner_name : null,
      amount: payRow ? payRow.amount : row.amount,
      reason,
      detail
    });
  }

  return {
    weekStart,
    weekEnd,
    cleaners,
    orphans,
    adjustmentPresets: presets,
    roster: cleanerRows
      .filter((r) => r.status === 'active' || r.status === 'inactive')
      .map((r) => ({ name: r.name, email: r.email || null, status: r.status })),
    locked: !!lockRow,
    lockedAt: lockRow ? lockRow.locked_at : null,
    lockedByName: lockRow ? lockRow.locked_by : null,
    generatedAt: new Date().toISOString()
  };
}

async function getWeekLock(weekStart) {
  const monday = mondayOf(weekStart);
  return db.prepare('SELECT locked_at, locked_by FROM payroll_week_locks WHERE week_start = ?').get(monday);
}

async function lockWeek(weekStart) {
  const monday = mondayOf(weekStart);
  await db.prepare(`
    INSERT INTO payroll_week_locks (week_start)
    VALUES (?)
    ON CONFLICT (week_start) DO UPDATE SET locked_at = sqlite_now()
  `).run(monday);
}

async function unlockWeek(weekStart) {
  const monday = mondayOf(weekStart);
  await db.prepare('DELETE FROM payroll_week_locks WHERE week_start = ?').run(monday);
}

async function upsertJobPay({ weekStart, bookingId, cleanerName, amount, serviceName }) {
  const monday = mondayOf(weekStart);
  const numericAmount = Number(amount);
  const safeAmount = Number.isFinite(numericAmount) ? round2(numericAmount) : 0;

  const existing = await db.prepare('SELECT amount FROM payroll_job_pay WHERE booking_id = ?').get(bookingId);
  const oldAmount = existing ? existing.amount : null;

  const result = await db.prepare(`
    INSERT INTO payroll_job_pay (week_start, booking_id, cleaner_name, amount, service_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (booking_id) DO UPDATE SET
      amount = EXCLUDED.amount,
      cleaner_name = EXCLUDED.cleaner_name,
      week_start = EXCLUDED.week_start,
      service_name = COALESCE(EXCLUDED.service_name, payroll_job_pay.service_name),
      updated_at = sqlite_now()
  `).run(monday, bookingId, cleanerName, safeAmount, serviceName || null);
  return { row: result.row, oldAmount };
}

// Writes suggested amounts into the empty pay boxes only. An amount already entered is never
// overwritten, the suggestion is a typing shortcut and the typed number always wins.
async function fillEmptyAmounts({ weekStart, cleanerName }) {
  const monday = mondayOf(weekStart);
  const week = await getPayrollWeek(monday);
  const groups = cleanerName
    ? week.cleaners.filter((c) => c.name === cleanerName)
    : week.cleaners.filter((c) => c.name !== 'Unassigned');

  const filled = [];
  for (const group of groups) {
    for (const job of group.jobs) {
      if (job.amount !== null || job.suggestedAmount === null) continue;
      await upsertJobPay({
        weekStart: monday,
        bookingId: job.bookingId,
        cleanerName: group.name,
        amount: job.suggestedAmount,
        serviceName: job.service
      });
      filled.push({ bookingId: job.bookingId, cleanerName: group.name, amount: job.suggestedAmount, source: job.suggestedSource });
    }
  }
  return filled;
}

// Flat one-row-per-clean export for whoever does the books. Adjustments come out as their own
// rows so the file's Amount column sums to exactly the week's payroll total.
function toCsv(week) {
  const rows = [['Week start', 'Week end', 'Cleaner', 'Date', 'Type', 'Client', 'Service', 'Description', 'Amount']];
  week.cleaners.forEach((group) => {
    group.jobs.forEach((job) => {
      rows.push([week.weekStart, week.weekEnd, group.name, job.serviceDateOnly, 'Clean',
        job.customerFirstName, job.service || '', '', (job.amount || 0).toFixed(2)]);
    });
    group.adjustments.forEach((adj) => {
      rows.push([week.weekStart, week.weekEnd, group.name, '', 'Adjustment', '', '', adj.label, adj.amount.toFixed(2)]);
    });
  });

  return rows.map((row) => row.map((cell) => {
    const value = String(cell === null || cell === undefined ? '' : cell);
    const needsQuote = /[",\n]/.test(value) || /^[=+\-@]/.test(value);
    return needsQuote ? '"' + value.replace(/"/g, '""') + '"' : value;
  }).join(',')).join('\r\n');
}

async function addAdjustment({ weekStart, cleanerName, label, amount }) {
  const monday = mondayOf(weekStart);
  const numericAmount = Number(amount);
  const safeAmount = Number.isFinite(numericAmount) ? round2(numericAmount) : 0;
  const cleanLabel = (label || '').trim().slice(0, 200);
  const result = await db.prepare(
    'INSERT INTO payroll_adjustments (week_start, cleaner_name, label, amount) VALUES (?, ?, ?, ?)'
  ).run(monday, cleanerName, cleanLabel, safeAmount);
  return result.row;
}

async function removeAdjustment(id) {
  const existing = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(id);
  if (!existing) return null;
  await db.prepare('DELETE FROM payroll_adjustments WHERE id = ?').run(id);
  return existing;
}

async function removeOrphanPay({ weekStart, bookingId }) {
  const monday = mondayOf(weekStart);
  const existing = await db.prepare('SELECT * FROM payroll_job_pay WHERE booking_id = ? AND week_start = ?').get(bookingId, monday);
  if (!existing) return null;
  await db.prepare('DELETE FROM payroll_job_pay WHERE booking_id = ? AND week_start = ?').run(bookingId, monday);
  return existing;
}

// Two identical "sent" clicks inside a minute for the same amount is one click, not two
// decisions, so the repeat is swallowed and the original returned.
const SENT_DEDUPE_MS = 60 * 1000;

async function markSent({ weekStart, cleanerName, totalAtSend }) {
  const monday = mondayOf(weekStart);
  const numericTotal = Number(totalAtSend);
  const safeTotal = Number.isFinite(numericTotal) ? round2(numericTotal) : 0;

  const previous = await db.prepare(`
    SELECT * FROM payroll_sent_log
    WHERE week_start = ? AND cleaner_name = ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(monday, cleanerName);

  if (previous && round2(previous.total_at_send) === safeTotal) {
    const previousMs = Date.parse(previous.sent_at.replace(' ', 'T') + 'Z');
    if (Number.isFinite(previousMs) && Date.now() - previousMs < SENT_DEDUPE_MS) return previous;
  }

  const result = await db.prepare(
    'INSERT INTO payroll_sent_log (week_start, cleaner_name, total_at_send) VALUES (?, ?, ?)'
  ).run(monday, cleanerName, safeTotal);
  return result.row;
}

module.exports = {
  getPayrollWeek,
  getWeekLock,
  lockWeek,
  unlockWeek,
  upsertJobPay,
  fillEmptyAmounts,
  toCsv,
  addAdjustment,
  removeAdjustment,
  removeOrphanPay,
  markSent,
  mondayOf,
  addDays
};
