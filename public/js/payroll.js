// Cleaner payroll page.
//
// The pay statement markup is NOT built here any more, it comes from GET /api/payroll/statement
// (src/pay-statement.js). This file only entering amounts, previewing what the server produced,
// and getting it onto the clipboard.
(function () {
  'use strict';

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Local date components, not toISOString, same convention as dashboard.js/ops-console.js.
  function ymdLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function parseLocalYmd(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDaysStr(str, days) {
    const d = parseLocalYmd(str);
    d.setDate(d.getDate() + days);
    return ymdLocal(d);
  }
  function mondayOf(date) {
    const d = new Date(date);
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    return d;
  }
  function formatShort(dateStr) {
    return parseLocalYmd(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function formatStamp(sqlStamp) {
    return new Date(sqlStamp.replace(' ', 'T') + 'Z').toLocaleString();
  }

  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function moneyFmt(n) { return money.format(n || 0); }
  function moneySigned(n) { return (n < 0 ? '-' : '+') + money.format(Math.abs(n || 0)); }

  // "3h 12m" from ConvertLabs' tracked minutes. Only ever shown next to a zero amount, so it
  // stays short enough to sit inside a table cell.
  function formatMinutes(mins) {
    const total = Math.round(Number(mins) || 0);
    if (total < 60) return total + 'm';
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  const els = {
    weekLabel: document.getElementById('weekLabel'),
    paySynced: document.getElementById('paySynced'),
    paySummary: document.getElementById('paySummary'),
    payProgress: document.getElementById('payProgress'),
    payState: document.getElementById('payState'),
    groups: document.getElementById('cleanerGroups'),
    prevBtn: document.getElementById('prevWeekBtn'),
    nextBtn: document.getElementById('nextWeekBtn'),
    thisWeekBtn: document.getElementById('thisWeekBtn'),
    fillAllBtn: document.getElementById('fillAllBtn'),
    batchBtn: document.getElementById('batchBtn'),
    exportBtn: document.getElementById('exportBtn'),
    lockToggleBtn: document.getElementById('lockToggleBtn'),
    lockBanner: document.getElementById('payLockBanner'),
    orphans: document.getElementById('payOrphans'),
    statementModal: document.getElementById('statementModal'),
    statementTitle: document.getElementById('statementModalTitle'),
    statementSub: document.getElementById('statementModalSub'),
    statementToolbar: document.getElementById('statementToolbar'),
    statementBody: document.getElementById('statementBody'),
    statementFoot: document.getElementById('statementFoot'),
    addCleanerBtn: document.getElementById('addCleanerBtn'),
    addCleanerModal: document.getElementById('addCleanerModal'),
    addCleanerBody: document.getElementById('addCleanerBody')
  };

  let currentWeekStart = ymdLocal(mondayOf(new Date()));
  let payload = null;
  // Cards the user collapsed by hand. Everything starts expanded except finished cleaners.
  const collapsed = new Set();

  // ---------- Data ----------

  async function load() {
    els.payState.hidden = false;
    els.payState.textContent = 'Loading payroll for this week.';
    try {
      const res = await fetch(`/api/payroll?week=${currentWeekStart}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      payload = await res.json();
      els.payState.hidden = true;
      render();
    } catch (err) {
      els.payState.hidden = false;
      els.payState.textContent = `Could not load payroll: ${err.message}`;
      els.groups.innerHTML = '';
    }
  }

  function payableCleaners() {
    return payload.cleaners.filter((c) => c.name !== 'Unassigned');
  }

  // ---------- Rendering ----------

  function render() {
    const weekEndDisplay = addDaysStr(payload.weekStart, 6);
    els.weekLabel.textContent = `${formatShort(payload.weekStart)} – ${formatShort(weekEndDisplay)}, ${parseLocalYmd(weekEndDisplay).getFullYear()}`;
    els.paySynced.textContent = 'Synced ' + new Date(payload.generatedAt).toLocaleTimeString();

    els.lockToggleBtn.hidden = false;
    if (payload.locked) {
      els.lockToggleBtn.textContent = 'Unlock to edit';
      els.lockToggleBtn.classList.add('is-locked');
      const lockedWhen = payload.lockedAt ? formatStamp(payload.lockedAt) : '';
      els.lockBanner.hidden = false;
      els.lockBanner.innerHTML = `&#128274; This pay period is locked${payload.lockedByName ? ' by ' + esc(payload.lockedByName) : ''}${lockedWhen ? ' on ' + esc(lockedWhen) : ''}. Pay amounts and adjustments can't be changed until it's unlocked.`;
    } else {
      els.lockToggleBtn.textContent = 'Lock this week';
      els.lockToggleBtn.classList.remove('is-locked');
      els.lockBanner.hidden = true;
    }

    const paid = payableCleaners();
    const totalPayroll = paid.reduce((sum, c) => sum + c.grandTotal, 0);
    const totalJobs = payload.cleaners.reduce((sum, c) => sum + c.jobs.length, 0);

    els.paySummary.innerHTML = `
      <div class="pay-summary-stat"><span class="label">Total payroll</span><span class="value" data-total-payroll>${moneyFmt(totalPayroll)}</span></div>
      <div class="pay-summary-stat"><span class="label">Cleaners</span><span class="value">${paid.length}</span></div>
      <div class="pay-summary-stat"><span class="label">Cleans this week</span><span class="value">${totalJobs}</span></div>
    `;

    renderProgress();
    renderOrphans();

    const fillable = paid.reduce((sum, c) => sum + c.fillableCount, 0);
    els.addCleanerBtn.hidden = payload.locked || !rosterNotOnThisWeek().length;
    els.fillAllBtn.hidden = fillable === 0 || payload.locked;
    els.fillAllBtn.textContent = `Fill ${fillable} empty amount${fillable === 1 ? '' : 's'}`;
    els.batchBtn.hidden = paid.length === 0;

    // Finished cleaners default to collapsed so attention lands on what still needs entering.
    paid.forEach((c) => {
      if (c.ready && c.lastSent && !collapsed.has(c.name)) collapsed.add(c.name);
    });

    if (payload.cleaners.length === 0) {
      els.groups.innerHTML = '<p class="pay-state">No cleans found for this week.</p>';
      return;
    }
    els.groups.innerHTML = payload.cleaners.map(renderGroup).join('');
  }

  // "3 of 4 cleaners ready" plus what is blocking the rest. The old page gave no signal that a
  // cleaner still sat at $0.00 with nothing entered.
  function renderProgress() {
    const paid = payableCleaners();
    if (!paid.length) { els.payProgress.hidden = true; return; }

    // Counts what can actually be sent, not what has its numbers finished. A cleaner with every
    // amount entered and no email on file is not sendable, and counting her made the bar read
    // "5 of 5 ready to send" on a week where only four could go anywhere.
    const sendable = paid.filter((c) => c.sendable).length;
    const missing = paid.reduce((sum, c) => sum + c.missingAmounts, 0);
    const flagged = paid.reduce((sum, c) => sum + c.flaggedCount, 0);
    const zeroWithTime = paid.reduce((sum, c) => sum + (c.zeroWithTimeCount || 0), 0);
    const noEmail = paid.filter((c) => c.ready && !c.email).length;
    const pct = Math.round((sendable / paid.length) * 100);

    const notes = [];
    if (missing) notes.push(`<span class="warn">${missing} amount${missing === 1 ? '' : 's'} not entered</span>`);
    if (flagged) notes.push(`<span class="warn">${flagged} above what the job billed</span>`);
    if (zeroWithTime) notes.push(`<span class="warn">${zeroWithTime} at $0 with hours worked</span>`);
    if (noEmail) notes.push(`<span class="warn">${noEmail} finished but with no email on file</span>`);

    els.payProgress.hidden = false;
    els.payProgress.innerHTML = `
      <div class="progress-track"><span style="width:${pct}%" class="${sendable === paid.length ? 'is-done' : ''}"></span></div>
      <div class="progress-text">
        <strong>${sendable} of ${paid.length}</strong> cleaner${paid.length === 1 ? '' : 's'} ready to send
        ${notes.length ? '<span class="progress-notes">' + notes.join(' &middot; ') + '</span>' : ''}
      </div>`;
  }

  // Pay entered against a clean that has since left the week. Sits under the lock banner because
  // it is money that has silently stopped counting, and nothing else on the page would ever
  // mention it.
  function renderOrphans() {
    const orphans = payload.orphans || [];
    if (!orphans.length) { els.orphans.hidden = true; return; }

    const reasonText = {
      cancelled: 'the clean was cancelled',
      missing: 'the clean no longer exists in ConvertLabs',
      'not-on-schedule': 'the clean is no longer on this week\'s schedule',
      unknown: 'ConvertLabs could not be reached to check why'
    };

    const rows = orphans.map((o) => `
      <div class="orphan-row">
        <span class="orphan-amount">${moneyFmt(o.amount)}</span>
        <span class="orphan-text">
          entered for ${o.cleanerName ? esc(o.cleanerName) : 'a cleaner'} on booking ${esc(String(o.bookingId))},
          but ${esc(reasonText[o.reason] || reasonText.unknown)}${o.detail ? ' (' + esc(o.detail) + ')' : ''}.
        </span>
        <button type="button" class="btn-quiet" data-remove-orphan="${esc(String(o.bookingId))}" ${payload.locked ? 'disabled' : ''}>Remove</button>
      </div>`).join('');

    const total = orphans.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    els.orphans.hidden = false;
    els.orphans.innerHTML = `
      <div class="orphan-head">
        <strong>${orphans.length} pay ${orphans.length === 1 ? 'amount is' : 'amounts are'} stranded${total ? ', ' + moneyFmt(total) + ' in total' : ''}</strong>
        <span>These were entered against cleans that are no longer in this week, so they are not counted in anyone's total. Remove them once you have checked.</span>
      </div>
      ${rows}`;
  }

  function sentStatusHtml(group) {
    if (!group.lastSent) return '';
    const stale = Math.abs(group.lastSent.totalAtSend - group.grandTotal) > 0.001;
    const byWho = group.lastSent.sentByName ? ` by ${esc(group.lastSent.sentByName)}` : '';
    const more = group.sentHistory && group.sentHistory.length > 1
      ? ` <button type="button" class="link-btn" data-history="${esc(group.name)}">${group.sentHistory.length} sends</button>`
      : '';
    return `<div class="sent-status" data-sent-status>Statement sent ${esc(formatStamp(group.lastSent.sentAt))}${byWho} for ${moneyFmt(group.lastSent.totalAtSend)}${stale ? '<span class="stale"> &middot; amounts changed since then</span>' : ''}${more}</div>`;
  }

  function jobStatusPill(job) {
    // Only bookings ConvertLabs has not marked completed are worth calling out, so an amount
    // does not quietly go out for a clean that has not happened yet.
    if (job.status === 'completed') return '';
    return `<span class="job-status-pill ${esc(job.status)}">${esc(job.status)}</span>`;
  }

  function renderGroup(group) {
    const isUnassigned = group.name === 'Unassigned';
    const locked = !!payload.locked;
    const isCollapsed = collapsed.has(group.name);

    const rows = group.jobs.map((job) => `
      <tr data-booking-id="${job.bookingId}"${job.payExceedsRevenue || job.zeroWithTime ? ' class="is-flagged"' : ''}>
        <td class="col-date">${esc(formatShort(job.serviceDateOnly))}</td>
        <td class="col-client">${esc(job.customerFirstName)}${jobStatusPill(job)}</td>
        <td class="col-service">${esc(job.service || '')}<span class="col-address">${esc(job.address || '')}</span></td>
        <td class="col-pay">
          <span class="pay-input-wrap${job.payExceedsRevenue || job.zeroWithTime ? ' is-flagged' : ''}">
            <span class="prefix">$</span>
            <input type="number" class="pay-input" step="0.01" min="0"
                   placeholder="${job.suggestedAmount !== null ? Number(job.suggestedAmount).toFixed(2) : '0.00'}"
                   value="${job.amount !== null ? job.amount : ''}" ${locked ? 'disabled' : ''}
                   aria-label="Pay for ${esc(job.customerFirstName)} on ${esc(formatShort(job.serviceDateOnly))}"
                   data-booking-id="${job.bookingId}" data-cleaner="${esc(group.name)}" data-service="${esc(job.service || '')}" />
          </span>
          ${job.payExceedsRevenue ? '<span class="flag-note" title="This is more than the job billed">above job total</span>' : ''}
          ${job.zeroWithTime ? `<span class="flag-note" title="ConvertLabs recorded time worked on this clean">$0 but ${formatMinutes(job.trackedMinutes)} clocked</span>` : ''}
        </td>
      </tr>`).join('');

    const adjRows = group.adjustments.map((adj) => `
      <div class="adj-row" data-adj-id="${adj.id}">
        <span class="adj-label">${esc(adj.label)}</span>
        <span class="adj-amount ${adj.amount < 0 ? 'negative' : 'positive'}">${moneySigned(adj.amount)}</span>
        <button type="button" class="adj-remove-btn" data-remove-adj="${adj.id}" title="Remove line item" ${locked ? 'disabled' : ''}>&times;</button>
      </div>`).join('');

    // Until a line item is saved this card only exists in the browser. Say so, rather than let a
    // refresh quietly take it away.
    const unsavedNote = group.addedByHand && !group.adjustments.length
      ? '<div class="sent-status is-unsaved">Added by hand &middot; saves once you add a line item below</div>'
      : '';

    // Ready and sendable are separate states. A finished cleaner with no email on file gets her
    // own chip rather than a green Ready sitting next to a red "no email on file", which is what
    // it used to say at the same time.
    const statusChip = isUnassigned ? ''
      : group.missingAmounts
        ? `<span class="ready-chip is-todo">${group.missingAmounts} amount${group.missingAmounts === 1 ? '' : 's'} left</span>`
        : !group.ready ? '<span class="ready-chip is-zero">Nothing to pay</span>'
          : group.sendable ? '<span class="ready-chip is-ready">Ready</span>'
            : '<span class="ready-chip is-blocked">Needs an email</span>';

    return `
      <div class="cleaner-card${isUnassigned ? ' unassigned' : ''}${locked ? ' is-locked' : ''}${isCollapsed ? ' is-collapsed' : ''}" data-cleaner-card="${esc(group.name)}">
        <div class="cleaner-card-head">
          <button type="button" class="card-toggle" data-toggle-card="${esc(group.name)}" aria-expanded="${!isCollapsed}" aria-label="Expand or collapse ${esc(group.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="cleaner-head-main">
            <span class="cleaner-name">${esc(group.name)}<span class="job-count">${group.jobs.length} clean${group.jobs.length === 1 ? '' : 's'}</span>${statusChip}</span>
            <div class="cleaner-totals">
              <span class="mini-total">Jobs <strong data-jobs-total>${moneyFmt(group.jobsTotal)}</strong></span>
              <span class="mini-total">Adjustments <strong data-adj-total>${moneyFmt(group.adjustmentsTotal)}</strong></span>
              ${isUnassigned || !group.yearToDate ? '' : `<span class="mini-total">This year <strong>${moneyFmt(group.yearToDate)}</strong></span>`}
              ${isUnassigned ? '' : `<span class="mini-total email-line">${group.email ? esc(group.email) : '<span class="no-email">No email on file</span>'}</span>`}
            </div>
            ${sentStatusHtml(group)}${unsavedNote}
          </div>
          <div class="cleaner-card-actions">
            <div class="cleaner-grand-total" data-grand-total>${moneyFmt(group.grandTotal)}</div>
            ${isUnassigned ? '' : `
              ${group.fillableCount && !locked ? `<button type="button" class="btn-quiet" data-fill-card="${esc(group.name)}">Fill ${group.fillableCount}</button>` : ''}
              <button type="button" class="btn ${group.ready ? 'btn-primary' : 'btn-secondary'} btn-sm" data-generate-email="${esc(group.name)}">Pay statement</button>
              ${group.lastSent ? '' : `<button type="button" class="btn-quiet" data-mark-sent="${esc(group.name)}">Mark sent</button>`}
            `}
          </div>
        </div>

        <div class="cleaner-card-body">
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Date</th><th>Client</th><th>Service</th><th class="col-pay">Pay</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="4" class="empty-note">No cleans.</td></tr>'}</tbody>
            </table>
          </div>

          <div class="adj-section">
            <button type="button" class="adj-toggle${group.adjustments.length ? ' is-open' : ''}" data-toggle-adj="${esc(group.name)}" aria-expanded="${group.adjustments.length > 0}">
              <svg class="adj-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              <span class="adj-toggle-label">Adjustments${group.adjustments.length ? ` (${group.adjustments.length})` : ''}</span>
              <span class="adj-hint">room turns, missed payments, corrections</span>
              <span class="adj-toggle-action">${group.adjustments.length ? 'Hide' : 'Add'}</span>
            </button>
            <div class="adj-body${group.adjustments.length ? '' : ' is-hidden'}" data-adj-body="${esc(group.name)}">
              <div class="adj-list">${adjRows}</div>
              ${locked || !(payload.adjustmentPresets || []).length ? '' : `
              <div class="adj-presets" aria-label="Common line items">
                ${payload.adjustmentPresets.map((label) => `<button type="button" class="adj-preset" data-preset="${esc(label)}" data-preset-for="${esc(group.name)}">${esc(label)}</button>`).join('')}
              </div>`}
              <form class="adj-add-form${locked ? ' is-disabled' : ''}" data-adj-form="${esc(group.name)}">
                <input type="text" placeholder="Description (e.g. Room turn bonus)" maxlength="200" required ${locked ? 'disabled' : ''} />
                <input type="number" step="0.01" min="0.01" placeholder="Amount" required ${locked ? 'disabled' : ''} />
                <span class="adj-type-toggle">
                  <input type="radio" name="adjType-${esc(group.name)}" id="adjType-add-${esc(group.name)}" value="addition" checked ${locked ? 'disabled' : ''} />
                  <label for="adjType-add-${esc(group.name)}">Addition</label>
                  <input type="radio" name="adjType-${esc(group.name)}" id="adjType-ded-${esc(group.name)}" value="deduction" ${locked ? 'disabled' : ''} />
                  <label for="adjType-ded-${esc(group.name)}">Deduction</label>
                </span>
                <button type="button" class="btn btn-secondary btn-sm" data-submit-adj="${esc(group.name)}" ${locked ? 'disabled' : ''}>Add line item</button>
              </form>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---------- Adding a cleaner with no bookings ----------
  // Room turns and touch-up cleans never get logged in ConvertLabs, so a cleaner can work a week
  // and not appear here at all. Picking them from the roster puts an empty card on the page with
  // only the adjustments section usable, which is the right shape: there are no cleans to price,
  // just amounts to add or deduct. Nothing is written until a line item is saved, and once one is
  // the card comes back on its own, because the server builds a group from adjustment rows too.

  function rosterNotOnThisWeek() {
    if (!payload || !payload.roster) return [];
    const already = new Set(payload.cleaners.map((c) => c.name));
    return payload.roster.filter((r) => !already.has(r.name));
  }

  function blankGroup(entry) {
    return {
      name: entry.name,
      email: entry.email || null,
      jobs: [],
      adjustments: [],
      jobsTotal: 0,
      adjustmentsTotal: 0,
      grandTotal: 0,
      missingAmounts: 0,
      ready: false,
      fillableCount: 0,
      flaggedCount: 0,
      sentHistory: [],
      lastSent: null,
      addedByHand: true
    };
  }

  function openAddCleaner() {
    const options = rosterNotOnThisWeek();
    els.addCleanerBody.innerHTML = `
      <form class="add-cleaner-form" id="addCleanerForm">
        <label for="addCleanerSelect">Cleaner</label>
        <select id="addCleanerSelect">
          ${options.map((o) => `<option value="${esc(o.name)}">${esc(o.name)}${o.status === 'inactive' ? ' (inactive)' : ''}</option>`).join('')}
        </select>
        <p class="add-cleaner-hint">They'll get an empty card with no cleans on it. Add the room turn
          or touch-up as a line item under Adjustments and it saves from there.</p>
        <div class="add-cleaner-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-close-modal>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Add to this week</button>
        </div>
      </form>`;
    openModal(els.addCleanerModal);
    document.getElementById('addCleanerSelect').focus();
  }

  function addCleanerToWeek(name) {
    const entry = (payload.roster || []).find((r) => r.name === name);
    if (!entry || findGroup(name)) return;

    payload.cleaners.push(blankGroup(entry));
    payload.cleaners.sort((a, b) => {
      if (a.name === 'Unassigned') return 1;
      if (b.name === 'Unassigned') return -1;
      return a.name.localeCompare(b.name);
    });

    closeModal(els.addCleanerModal);
    render();
    renderProgress();

    // Drop them straight into the only thing they can do on this card.
    const card = els.groups.querySelector(`[data-cleaner-card="${cssEscape(name)}"]`);
    if (!card) return;
    const body = card.querySelector(`[data-adj-body="${cssEscape(name)}"]`);
    const toggle = card.querySelector(`[data-toggle-adj="${cssEscape(name)}"]`);
    if (body && toggle) setAdjOpen(toggle, body, true);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const firstInput = card.querySelector('.adj-add-form input[type="text"]');
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  els.addCleanerBtn.addEventListener('click', openAddCleaner);
  els.addCleanerModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) closeModal(els.addCleanerModal);
  });
  els.addCleanerModal.addEventListener('submit', (e) => {
    e.preventDefault();
    addCleanerToWeek(document.getElementById('addCleanerSelect').value);
  });

  function findGroup(cleanerName) {
    return payload.cleaners.find((c) => c.name === cleanerName);
  }

  function recomputeGroupTotals(group) {
    const round2 = (n) => Math.round(n * 100) / 100;
    group.jobsTotal = round2(group.jobs.reduce((sum, j) => sum + (j.amount || 0), 0));
    group.adjustmentsTotal = round2(group.adjustments.reduce((sum, a) => sum + a.amount, 0));
    group.grandTotal = round2(group.jobsTotal + group.adjustmentsTotal);
    group.missingAmounts = group.jobs.filter((j) => j.amount === null).length;
    group.ready = group.missingAmounts === 0 && group.grandTotal > 0;
    group.fillableCount = group.jobs.filter((j) => j.amount === null && j.suggestedAmount !== null).length;
  }

  function refreshCardTotals(cleanerName) {
    const group = findGroup(cleanerName);
    if (!group) return;
    recomputeGroupTotals(group);
    const card = els.groups.querySelector(`[data-cleaner-card="${cssEscape(cleanerName)}"]`);
    if (!card) return;
    card.querySelector('[data-jobs-total]').textContent = moneyFmt(group.jobsTotal);
    card.querySelector('[data-adj-total]').textContent = moneyFmt(group.adjustmentsTotal);
    card.querySelector('[data-grand-total]').textContent = moneyFmt(group.grandTotal);

    const sentEl = card.querySelector('[data-sent-status]');
    const freshSentHtml = sentStatusHtml(group);
    if (sentEl) {
      if (freshSentHtml) sentEl.outerHTML = freshSentHtml; else sentEl.remove();
    } else if (freshSentHtml) {
      card.querySelector('.cleaner-totals').insertAdjacentHTML('afterend', freshSentHtml);
    }

    const totalEl = els.paySummary.querySelector('[data-total-payroll]');
    if (totalEl) totalEl.textContent = moneyFmt(payableCleaners().reduce((sum, c) => sum + c.grandTotal, 0));
    renderProgress();
  }

  // Blocks all payroll mutation UI once the server reports a week as locked (e.g. another tab
  // just locked it), refetching so the page matches reality instead of silently failing edits.
  async function handleLockConflict(res) {
    if (res.status !== 409) return false;
    alert('This pay period was locked. The page will refresh to show the current state.');
    await load();
    return true;
  }

  function cssEscape(str) {
    return String(str).replace(/["\\]/g, '\\$&');
  }

  // Opens or closes an adjustments panel and keeps the button telling the truth about which it
  // is. The chevron, the aria state, and the Add/Hide word all have to move together, or the
  // control goes back to looking like a static label, which is what made it easy to miss.
  function setAdjOpen(toggle, body, open) {
    body.classList.toggle('is-hidden', !open);
    toggle.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    const action = toggle.querySelector('.adj-toggle-action');
    if (action) action.textContent = open ? 'Hide' : 'Add';
  }

  // ---------- Job pay editing ----------

  els.groups.addEventListener('change', (e) => {
    const input = e.target.closest('.pay-input');
    if (input) savePay(input);
  });

  // Enter or Down moves to the next pay box so a week can be typed without reaching for the
  // mouse. Enter also commits the current value first.
  els.groups.addEventListener('keydown', (e) => {
    const input = e.target.closest('.pay-input');
    if (!input) return;
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (e.key === 'Enter') input.blur(); // fires change, which saves

    const all = Array.from(els.groups.querySelectorAll('.pay-input:not([disabled])'));
    const index = all.indexOf(input);
    const next = all[e.key === 'ArrowUp' ? index - 1 : index + 1];
    if (next) { next.focus(); next.select(); }
  });

  async function savePay(input) {
    const bookingId = input.dataset.bookingId;
    const cleanerName = input.dataset.cleaner;
    const raw = input.value.trim();
    const amount = parseFloat(raw);
    input.classList.add('unsaved');
    try {
      const res = await fetch('/api/payroll/job-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekStart: payload.weekStart,
          bookingId,
          cleanerName,
          amount: Number.isFinite(amount) ? amount : 0,
          serviceName: input.dataset.service || null
        })
      });
      input.classList.remove('unsaved');
      if (await handleLockConflict(res)) return;
      if (!res.ok) throw new Error('save failed');

      const group = findGroup(cleanerName);
      const job = group && group.jobs.find((j) => String(j.bookingId) === String(bookingId));
      if (job) job.amount = Number.isFinite(amount) ? amount : 0;
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 1200);
      refreshCardTotals(cleanerName);
    } catch (err) {
      input.classList.remove('unsaved');
      alert('Could not save that amount. Check your connection and try again.');
    }
  }

  // ---------- Card clicks ----------

  els.groups.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle-card]');
    if (toggle) {
      const name = toggle.dataset.toggleCard;
      if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
      const card = toggle.closest('.cleaner-card');
      card.classList.toggle('is-collapsed', collapsed.has(name));
      toggle.setAttribute('aria-expanded', String(!collapsed.has(name)));
      return;
    }
    const adjToggle = e.target.closest('[data-toggle-adj]');
    if (adjToggle) {
      const body = els.groups.querySelector(`[data-adj-body="${cssEscape(adjToggle.dataset.toggleAdj)}"]`);
      if (body) setAdjOpen(adjToggle, body, body.classList.contains('is-hidden'));
      return;
    }
    // Fills the description and puts the cursor in the amount, which is the only field left to
    // decide. The label is still editable, these are a shortcut, not a fixed list.
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const form = els.groups.querySelector(`[data-adj-form="${cssEscape(preset.dataset.presetFor)}"]`);
      if (form) {
        const label = form.querySelector('input[type="text"]');
        const amount = form.querySelector('input[type="number"]');
        label.value = preset.dataset.preset;
        amount.focus();
      }
      return;
    }
    const submitBtn = e.target.closest('[data-submit-adj]');
    if (submitBtn) {
      const cleanerName = submitBtn.dataset.submitAdj;
      addAdjustment(cleanerName, els.groups.querySelector(`[data-adj-form="${cssEscape(cleanerName)}"]`));
      return;
    }
    const removeBtn = e.target.closest('[data-remove-adj]');
    if (removeBtn) { removeAdjustment(parseInt(removeBtn.dataset.removeAdj, 10)); return; }

    const fillBtn = e.target.closest('[data-fill-card]');
    if (fillBtn) { fillAmounts(fillBtn.dataset.fillCard); return; }

    const sentBtn = e.target.closest('[data-mark-sent]');
    if (sentBtn) { markSent(sentBtn.dataset.markSent); return; }

    const historyBtn = e.target.closest('[data-history]');
    if (historyBtn) { showHistory(historyBtn.dataset.history); return; }

    const emailBtn = e.target.closest('[data-generate-email]');
    if (emailBtn) openStatement(emailBtn.dataset.generateEmail);
  });

  async function addAdjustment(cleanerName, form) {
    const labelInput = form.querySelector('input[type="text"]');
    const amountInput = form.querySelector('input[type="number"]');
    const typeInput = form.querySelector('input[type="radio"]:checked');
    const label = labelInput.value.trim();
    const amount = Math.abs(parseFloat(amountInput.value));
    const type = typeInput ? typeInput.value : 'addition';
    if (!label || !Number.isFinite(amount) || amount <= 0) {
      alert('Enter a description and a positive amount.');
      return;
    }
    try {
      const res = await fetch('/api/payroll/adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: payload.weekStart, cleanerName, label, amount, type })
      });
      if (await handleLockConflict(res)) return;
      if (!res.ok) throw new Error('add failed');

      const body = await res.json();
      const signedAmount = type === 'deduction' ? -amount : amount;
      const group = findGroup(cleanerName);
      group.adjustments.push(body.row ? { id: body.row.id, label: body.row.label, amount: body.row.amount } : { id: Date.now(), label, amount: signedAmount });
      recomputeGroupTotals(group);
      rerenderGroup(cleanerName);
      renderProgress();
    } catch (err) {
      alert('Could not add that line item. Check your connection and try again.');
    }
  }

  async function removeAdjustment(id) {
    if (!confirm('Remove this line item?')) return;
    const group = payload.cleaners.find((c) => c.adjustments.some((a) => a.id === id));
    try {
      const res = await fetch(`/api/payroll/adjustments/${id}/delete`, { method: 'POST' });
      if (await handleLockConflict(res)) return;
      if (!res.ok) throw new Error('remove failed');

      if (group) {
        group.adjustments = group.adjustments.filter((a) => a.id !== id);
        recomputeGroupTotals(group);
        rerenderGroup(group.name);
        renderProgress();
      }
    } catch (err) {
      alert('Could not remove that line item. Check your connection and try again.');
    }
  }

  function rerenderGroup(cleanerName) {
    const group = findGroup(cleanerName);
    const card = els.groups.querySelector(`[data-cleaner-card="${cssEscape(cleanerName)}"]`);
    if (!group || !card) return;
    card.outerHTML = renderGroup(group);
  }

  // ---------- Fill from what this cleaner was last paid ----------

  async function fillAmounts(cleanerName) {
    try {
      const res = await fetch('/api/payroll/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: payload.weekStart, cleanerName: cleanerName || null })
      });
      if (await handleLockConflict(res)) return;
      if (!res.ok) throw new Error('fill failed');
      const body = await res.json();
      await load();
      if (!body.filled.length) alert('Nothing to fill. An amount is only suggested once this cleaner has been paid for that kind of clean before.');
    } catch (err) {
      alert('Could not fill the amounts. Check your connection and try again.');
    }
  }

  async function markSent(cleanerName) {
    const group = findGroup(cleanerName);
    if (!group) return;
    try {
      const res = await fetch('/api/payroll/mark-sent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: payload.weekStart, cleanerName, totalAtSend: group.grandTotal })
      });
      if (!res.ok) throw new Error('mark-sent failed');
      await load();
    } catch (err) {
      alert('Could not mark this as sent. Check your connection and try again.');
    }
  }

  function showHistory(cleanerName) {
    const group = findGroup(cleanerName);
    if (!group || !group.sentHistory) return;
    const lines = group.sentHistory.map((h) => `${formatStamp(h.sentAt)} · ${moneyFmt(h.totalAtSend)}${h.sentByName ? ' by ' + h.sentByName : ''}`);
    alert(`Send history for ${cleanerName}\n\n${lines.join('\n')}`);
  }

  // ---------- Modals ----------

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }
  function closeModal(modal) {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) {
      const modal = e.target.closest('.pay-modal');
      if (modal) closeModal(modal);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.pay-modal:not([hidden])').forEach(closeModal);
  });

  // ---------- Pay statement ----------

  let statements = [];
  let statementIndex = 0;

  async function fetchStatements(cleanerName) {
    const url = `/api/payroll/statement?week=${payload.weekStart}` + (cleanerName ? `&cleaner=${encodeURIComponent(cleanerName)}` : '');
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const body = await res.json();
    return body.statements;
  }

  async function openStatement(cleanerName) {
    const group = findGroup(cleanerName);
    if (group && group.missingAmounts > 0) {
      const proceed = confirm(`${group.missingAmounts} clean${group.missingAmounts === 1 ? '' : 's'} for ${cleanerName} ${group.missingAmounts === 1 ? "doesn't" : "don't"} have a pay amount entered yet (they'll show as $0.00). Generate the statement anyway?`);
      if (!proceed) return;
    }
    try {
      statements = await fetchStatements(cleanerName);
      statementIndex = 0;
      if (!statements.length) { alert('Nothing to generate for this cleaner.'); return; }
      showStatement();
      openModal(els.statementModal);
    } catch (err) {
      alert(`Could not build the statement: ${err.message}`);
    }
  }

  // Batch: every payable cleaner in one modal, stepped through with Next, so eight cleaners is
  // eight clicks rather than eight popup windows.
  async function openBatch() {
    try {
      statements = await fetchStatements(null);
      statementIndex = 0;
      if (!statements.length) { alert('No cleaners to generate statements for this week.'); return; }
      showStatement();
      openModal(els.statementModal);
    } catch (err) {
      alert(`Could not build the statements: ${err.message}`);
    }
  }

  // Gmail's compose URL only accepts a plain text body, and the whole point of the statement is
  // the formatting, so the body is deliberately left out: the recipient and subject are prefilled
  // and the formatted email arrives by paste. Same link the pricing playbook uses to share a
  // quote. No /u/0 in the path, so it opens in whichever Google account is already active.
  function gmailComposeUrl(st) {
    return 'https://mail.google.com/mail/?view=cm&fs=1&tf=1'
      + '&to=' + encodeURIComponent(st.to || '')
      + '&su=' + encodeURIComponent(st.subject);
  }

  function showStatement() {
    const st = statements[statementIndex];
    const group = findGroup(st.cleanerName);

    els.statementTitle.textContent = `${st.cleanerName} · ${moneyFmt(st.total)}`;
    els.statementSub.textContent = statements.length > 1
      ? `Statement ${statementIndex + 1} of ${statements.length}`
      : 'Copy this, then paste it into a new email.';

    els.statementToolbar.innerHTML = `
      <div class="tb-field">
        <span class="tb-label">To</span>
        <code class="tb-value${st.to ? '' : ' is-missing'}">${st.to ? esc(st.to) : 'No email on file for this cleaner'}</code>
        ${st.to ? `<button type="button" class="btn-quiet" data-copy="to">Copy</button>` : ''}
      </div>
      <div class="tb-field">
        <span class="tb-label">Subject</span>
        <code class="tb-value">${esc(st.subject)}</code>
        <button type="button" class="btn-quiet" data-copy="subject">Copy</button>
      </div>
      <div class="tb-actions">
        <button type="button" class="btn btn-primary btn-sm" data-copy="html">1. Copy formatted email</button>
        <a class="btn btn-secondary btn-sm" href="${gmailComposeUrl(st)}" target="_blank" rel="noopener">2. Open Gmail compose</a>
        <button type="button" class="btn-quiet" data-copy="text">Copy plain text instead</button>
      </div>
      <p class="share-hint">Copy the formatted email, open Gmail, then paste with Ctrl+V.
        ${st.to ? 'The cleaner and subject are filled in for you' : 'The subject is filled in for you'},
        and the formatting comes across with the paste.</p>`;

    // The statement is rendered in an iframe so its own styles and table widths cannot interact
    // with the app's stylesheet, which is exactly how it will be seen in an email client.
    els.statementBody.innerHTML = '<iframe id="statementFrame" title="Pay statement preview"></iframe>';
    const frame = document.getElementById('statementFrame');
    frame.srcdoc = st.html;

    const alreadySent = group && group.lastSent;
    els.statementFoot.innerHTML = `
      ${statements.length > 1 ? `
        <div class="statement-nav">
          <button type="button" class="btn-quiet" data-step="-1" ${statementIndex === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="btn-quiet" data-step="1" ${statementIndex === statements.length - 1 ? 'disabled' : ''}>Next</button>
        </div>` : '<span></span>'}
      <div class="statement-foot-actions">
        <span class="sent-hint">${alreadySent ? 'Already marked sent ' + esc(formatStamp(group.lastSent.sentAt)) : ''}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-modal-mark-sent>Mark as sent</button>
      </div>`;
  }

  async function copyStatementPart(kind) {
    const st = statements[statementIndex];
    try {
      if (kind === 'html') {
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error('no clipboard');
        await navigator.clipboard.write([new window.ClipboardItem({
          // copyHtml, not html: pasting the full document makes Gmail render the <title> as a
          // stray line above the statement. See copyHtml() in src/email-brand.js.
          'text/html': new Blob([st.copyHtml || st.html], { type: 'text/html' }),
          'text/plain': new Blob([st.text], { type: 'text/plain' })
        })]);
      } else {
        const value = kind === 'to' ? st.to : kind === 'subject' ? st.subject : st.text;
        await navigator.clipboard.writeText(value);
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  els.statementModal.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const original = copyBtn.textContent;
      const ok = await copyStatementPart(copyBtn.dataset.copy);
      copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { copyBtn.textContent = original; }, 1600);
      return;
    }
    const stepBtn = e.target.closest('[data-step]');
    if (stepBtn) {
      statementIndex = Math.min(statements.length - 1, Math.max(0, statementIndex + Number(stepBtn.dataset.step)));
      showStatement();
      return;
    }
    if (e.target.closest('[data-modal-mark-sent]')) {
      await markSent(statements[statementIndex].cleanerName);
      showStatement();
    }
  });

  // ---------- Week navigation and top bar ----------

  els.orphans.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-orphan]');
    if (!btn) return;
    const bookingId = btn.dataset.removeOrphan;
    const orphan = (payload.orphans || []).find((o) => String(o.bookingId) === String(bookingId));
    const amount = orphan ? moneyFmt(orphan.amount) : 'this amount';
    if (!confirm(`Remove the ${amount} entered for booking ${bookingId}? The clean is no longer in this week, so nothing on the page changes. This only clears the leftover record.`)) return;

    btn.disabled = true;
    try {
      const res = await fetch('/api/payroll/orphans/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: payload.weekStart, bookingId })
      });
      if (await handleLockConflict(res)) return;
      if (!res.ok) throw new Error('delete failed');
      await load();
    } catch (err) {
      btn.disabled = false;
      alert('Could not remove that. Check your connection and try again.');
    }
  });

  els.prevBtn.addEventListener('click', () => { currentWeekStart = addDaysStr(currentWeekStart, -7); collapsed.clear(); load(); });
  els.nextBtn.addEventListener('click', () => { currentWeekStart = addDaysStr(currentWeekStart, 7); collapsed.clear(); load(); });
  els.thisWeekBtn.addEventListener('click', () => { currentWeekStart = ymdLocal(mondayOf(new Date())); collapsed.clear(); load(); });
  els.fillAllBtn.addEventListener('click', () => fillAmounts(null));
  els.batchBtn.addEventListener('click', openBatch);
  els.exportBtn.addEventListener('click', () => {
    window.location.href = `/api/payroll/export.csv?week=${payload.weekStart}`;
  });

  els.lockToggleBtn.addEventListener('click', async () => {
    const wasLocked = payload.locked;
    const question = wasLocked
      ? 'Unlock this pay period so amounts can be edited again?'
      : 'Lock this pay period? Pay amounts and adjustments can\'t be changed until you unlock it again.';
    if (!confirm(question)) return;
    try {
      await fetch(`/api/payroll/${wasLocked ? 'unlock' : 'lock'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: payload.weekStart })
      });
      await load();
    } catch (err) {
      alert('Could not update the lock. Check your connection and try again.');
    }
  });

  // ---------- Init ----------

  load();
})();
