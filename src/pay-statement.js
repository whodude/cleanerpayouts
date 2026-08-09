// Builds a cleaner's weekly pay statement: the HTML that gets pasted into an email, the subject
// line, and a plain text alternative. Nothing here talks to the database or ConvertLabs, it is a
// pure function of the group object src/payroll.js already returns.

// Email clients strip <style> blocks and external CSS, so every rule below is inline on purpose.
// Outlook's Word rendering engine also ignores border-radius and box-shadow, which is accepted
// here (the statement squares off there rather than breaking).

const { COMPANY_NAME, CLEANER_PHONE_LINE, PUBLIC_BASE_URL, C, FONT, esc, money, moneySigned, copyHtml } = require('./email-brand');

function parseLocalYmd(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(str, days) {
  const d = parseLocalYmd(str);
  d.setDate(d.getDate() + days);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function formatShort(str) {
  return parseLocalYmd(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function periodLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  return `${formatShort(weekStart)} - ${formatShort(weekEnd)}, ${parseLocalYmd(weekEnd).getFullYear()}`;
}

function greetingName(cleanerTitle) {
  return (cleanerTitle || '').trim().split(/\s+/)[0] || cleanerTitle || '';
}

// Trims a full street address down to "Street name, City" (drops the house number and any
// apt/subdivision detail) so the emailed statement, a channel outside our control, carries less
// precise location data than the admin-facing payroll table needs. Falls back to whatever
// formatted address string we have if the raw components aren't available.
function lightAddress(addressRaw, fallbackFull) {
  if (!addressRaw) return fallbackFull || '';
  const street = (addressRaw.street_address || '').replace(/^\d+\s*/, '').trim();
  const city = addressRaw.city || '';
  if (street && city) return `${street}, ${city}`;
  return city || street || fallbackFull || '';
}

function buildSubject(group, weekStart) {
  return `Your MaidThis pay statement for ${periodLabel(weekStart)}`;
}

// The line most inboxes show next to the subject. Without one, the preview read "WEEKLY PAY
// STATEMENT", which wastes the most valuable line in the list view.
function buildPreheader(group, weekStart) {
  const count = group.jobs.length;
  const forWhat = count ? ` for ${count} clean${count === 1 ? '' : 's'}` : '';
  return `Your pay for ${periodLabel(weekStart)} is ${money(group.grandTotal)}${forWhat}.`;
}

function buildPlainText(group, weekStart) {
  const name = greetingName(group.name);
  const lines = [];
  lines.push(`Hi ${name},`);
  lines.push('');
  lines.push(`Here is your pay for the week of ${periodLabel(weekStart)}.`);
  lines.push('');
  lines.push(`YOU EARNED ${money(group.grandTotal)}`);
  lines.push('');
  lines.push('CLEANS');
  if (group.jobs.length) {
    group.jobs.forEach((j) => {
      lines.push(`  ${formatShort(j.serviceDateOnly)}  ${j.service || 'Cleaning'} - ${j.customerFirstName}, ${lightAddress(j.addressRaw, j.address)}`);
      lines.push(`      ${money(j.amount || 0)}`);
    });
  } else {
    lines.push('  No cleans this period.');
  }
  lines.push('');
  lines.push(`  Cleans subtotal: ${money(group.jobsTotal)}`);
  if (group.adjustments.length) {
    lines.push('');
    lines.push('ADJUSTMENTS');
    group.adjustments.forEach((a) => {
      lines.push(`  ${a.label}: ${moneySigned(a.amount)}`);
    });
    lines.push('');
    lines.push(`  Adjustments subtotal: ${moneySigned(group.adjustmentsTotal)}`);
  }
  lines.push('');
  lines.push(`TOTAL: ${money(group.grandTotal)}`);
  lines.push('');
  lines.push('Please review before payment is sent. Check that every clean above is yours and');
  lines.push('the amounts look right. Reply to this email to confirm it is all correct. If');
  lines.push('anything looks off, let us know as soon as possible so we can fix it before your');
  lines.push('direct deposit goes out.');
  lines.push('');
  lines.push(`Thank you for the great work this week.`);
  lines.push(COMPANY_NAME);
  if (CLEANER_PHONE_LINE) lines.push(CLEANER_PHONE_LINE.replace(' &middot; ', ' - '));
  return lines.join('\n');
}

function jobRowsHtml(jobs) {
  if (!jobs.length) {
    return `<tr><td style="padding:16px 0;text-align:center;color:${C.muted};font-style:italic;font-family:${FONT};font-size:13px;">No cleans this period.</td></tr>`;
  }
  return jobs.map((j) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid ${C.line};font-family:${FONT};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:${C.ink};font-weight:bold;">${esc(formatShort(j.serviceDateOnly))} &middot; ${esc(j.service || 'Cleaning')}</td>
              <td align="right" style="font-size:15px;color:${C.ink};font-weight:bold;white-space:nowrap;">${money(j.amount || 0)}</td>
            </tr>
            <tr>
              <td colspan="2" style="font-size:12.5px;color:${C.muted};padding-top:3px;">${esc(j.customerFirstName)} &middot; ${esc(lightAddress(j.addressRaw, j.address))}</td>
            </tr>
          </table>
        </td>
      </tr>`).join('');
}

// A subtotal row. The statement used to show only one grand total, which left a cleaner checking
// their own pay unable to see the jobs versus adjustments split, exactly the thing they'd query.
function subtotalRowHtml(label, value, opts) {
  const strong = opts && opts.strong;
  return `
      <tr>
        <td style="padding:${strong ? '14px 0 0' : '12px 0 0'};font-family:${FONT};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:${strong ? '14px' : '12.5px'};color:${strong ? C.ink : C.body};${strong ? 'font-weight:bold;' : ''}">${esc(label)}</td>
              <td align="right" style="font-size:${strong ? '16px' : '13px'};color:${strong ? C.ink : C.body};font-weight:bold;white-space:nowrap;">${value}</td>
            </tr>
          </table>
        </td>
      </tr>`;
}

function adjustmentsHtml(adjustments, adjustmentsTotal) {
  if (!adjustments.length) return '';
  return `
      <tr>
        <td style="padding:18px 0 4px;font-family:${FONT};">
          <p style="margin:0;font-size:10.5px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">Adjustments</p>
        </td>
      </tr>
      ${adjustments.map((a) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:${C.ink};">${esc(a.label)}</td>
              <td align="right" style="font-size:14px;font-weight:bold;white-space:nowrap;color:${a.amount < 0 ? C.red : C.ink};">${moneySigned(a.amount)}</td>
            </tr>
          </table>
        </td>
      </tr>`).join('')}
      ${subtotalRowHtml('Adjustments subtotal', moneySigned(adjustmentsTotal))}`;
}

function buildHtml(group, weekStart) {
  const name = greetingName(group.name);
  const period = periodLabel(weekStart);
  const logoUrl = `${PUBLIC_BASE_URL}/assets/maidthis-primary.png`;
  const jobs = group.jobs;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MaidThis Pay Statement - ${esc(name)}</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};">
<div id="mt-copy-root">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(buildPreheader(group, weekStart))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:32px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(44,62,80,0.08);">

        <tr>
          <td style="background:${C.page};padding:28px 32px;border-bottom:3px solid ${C.teal};">
            <img src="${logoUrl}" alt="MaidThis" height="30" style="display:block;border:0;" />
          </td>
        </tr>

        <tr>
          <td style="padding:32px 32px 0;">
            <p style="margin:0;font-size:11px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:${C.teal};font-family:${FONT};">Weekly Pay Statement</p>
            <h1 style="margin:8px 0 0;font-size:22px;color:${C.ink};font-family:${FONT};">Hi ${esc(name)},</h1>
            <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:${C.body};font-family:${FONT};">
              Here's your pay for the week of <strong style="color:${C.ink};">${esc(period)}</strong>.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.tealPale};border-radius:12px;">
              <tr>
                <td align="center" style="padding:22px 18px;">
                  <p style="margin:0;font-size:11px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:${C.tealDark};font-family:${FONT};">You Earned</p>
                  <p style="margin:6px 0 0;font-size:34px;font-weight:bold;color:${C.tealDark};font-family:${FONT};">${money(group.grandTotal)}</p>
                  <p style="margin:6px 0 0;font-size:12.5px;color:${C.tealMid};font-family:${FONT};">${jobs.length ? `for ${jobs.length} clean${jobs.length === 1 ? '' : 's'} this week` : 'for work this week'} &middot; direct deposit sent shortly after this statement</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 32px 0;">
            <p style="margin:0 0 4px;font-size:10.5px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};font-family:${FONT};">Cleans</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${jobRowsHtml(jobs)}
              ${subtotalRowHtml('Cleans subtotal', money(group.jobsTotal))}
              ${adjustmentsHtml(group.adjustments, group.adjustmentsTotal)}
              <tr><td style="padding-top:14px;border-top:2px solid ${C.line};"></td></tr>
              ${subtotalRowHtml('Total', money(group.grandTotal), { strong: true })}
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border:1px solid ${C.line};border-radius:10px;">
              <tr>
                <td style="padding:14px 18px;font-size:12.5px;line-height:1.6;color:${C.body};font-family:${FONT};">
                  <strong style="color:${C.ink};">Please review before payment is sent.</strong> Check that every clean above is yours and the amounts look right.
                  Reply to this email to confirm it's all correct. If anything looks off, let us know as soon as possible so we can fix it
                  before your direct deposit goes out.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 32px 4px;">
            <p style="margin:0;font-size:14px;line-height:1.6;color:${C.body};font-family:${FONT};">
              ${/* A cleaner can be paid for room turns or touch-ups with no booked cleans at all,
                    so the count has to drop out rather than read "all 0 cleans this week". */
                jobs.length > 1
                  ? `Thank you for the great work on all ${jobs.length} cleans this week!`
                  : 'Thank you for the great work this week!'}<br />
              <strong style="color:${C.ink};">${COMPANY_NAME}</strong>
            </p>
          </td>
        </tr>

        ${CLEANER_PHONE_LINE ? `
        <tr>
          <td style="padding:20px 32px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};">
              <tr>
                <td style="padding-top:16px;font-size:11px;line-height:1.6;color:${C.muted};font-family:${FONT};">
                  ${CLEANER_PHONE_LINE}
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}

      </table>
    </td>
  </tr>
</table>
</div>
</body>
</html>`;
}

// The one entry point. Returns everything needed to send this statement by any means, today by
// copy and paste, later by an automated job.
function buildStatement(group, weekStart) {
  const html = buildHtml(group, weekStart);
  return {
    cleanerName: group.name,
    to: group.email || null,
    subject: buildSubject(group, weekStart),
    preheader: buildPreheader(group, weekStart),
    html,
    copyHtml: copyHtml(html),
    text: buildPlainText(group, weekStart),
    total: group.grandTotal
  };
}

module.exports = { buildStatement, buildSubject, buildPlainText, buildHtml, periodLabel, PUBLIC_BASE_URL };
