// Shared brand constants and helpers for the cleaner pay statement email (src/pay-statement.js).
//
// Email clients strip <style> blocks and external CSS, so everything is applied inline at the
// point of use; this file only holds the values. Outlook's Word rendering engine ignores
// border-radius and box-shadow, which is accepted rather than worked around with VML.

const COMPANY_NAME = 'MaidThis Cleaning of Alexandria';
// Phone numbers left blank until the owner confirms what should show here. Nothing renders a
// broken "undefined" in their place, see CLEANER_PHONE_LINE below.
const CLEANER_PHONE = '';
const COMPANY_EMAIL = '';
// Line under the statement footer, phone + email joined with a middot when both are present.
// Kept as one helper so pay-statement.js doesn't have to know either value might be blank.
const CLEANER_PHONE_LINE = [CLEANER_PHONE, COMPANY_EMAIL].filter(Boolean).join(' &middot; ');

// Where images in a sent email are fetched from once it is sitting in somebody's inbox. Must be
// absolute and publicly reachable, or a message generated on a dev machine carries a localhost
// image URL no recipient could load.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// The franchisor teal/white/black system, same tokens as public/css/brand.css. Never recolour or
// redraw the logo.
const C = {
  ink: '#2C3E50',
  body: '#546778',
  muted: '#8A9AAB',
  teal: '#5AB3C9',
  tealDark: '#2B7387',
  tealMid: '#3E95AC',
  tealPale: '#EAF6F9',
  ocean: '#0C85C2',
  line: '#E6F1F4',
  page: '#F6FAFB',
  green: '#7CCA5B',
  greenDark: '#3F7D22',
  gold: '#FFB600',
  goldDark: '#7A4F00',
  red: '#E5484D',
  white: '#FFFFFF'
};

const FONT = 'Arial,Helvetica,sans-serif';

const LOGO_URL = PUBLIC_BASE_URL + '/assets/maidthis-primary.png';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  return '$' + Math.abs(Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Adjustments can go either way, so the sign carries the meaning: a bonus reads "+$25.00" and a
// deduction "-$25.00". money() alone drops the sign, which made a deduction look like a payment.
function moneySigned(n) {
  return (Number(n) < 0 ? '-' : '+') + money(n);
}

// What actually goes on the clipboard. Pasting a whole document into Gmail makes it render the
// <title> as a stray line of text at the top of the message, because its sanitiser drops <head>
// but keeps the text inside it. So the copy flavour is the #mt-copy-root fragment only,
// re-wrapped in a div carrying the page background and font that were on <body>.
function copyHtml(fullHtml) {
  const open = '<div id="mt-copy-root">';
  const start = fullHtml.indexOf(open);
  const end = fullHtml.lastIndexOf('</div>');
  if (start === -1 || end <= start) return fullHtml;
  const inner = fullHtml.slice(start + open.length, end);
  return `<div style="background:${C.page};font-family:${FONT};">${inner}</div>`;
}

module.exports = {
  COMPANY_NAME,
  CLEANER_PHONE,
  COMPANY_EMAIL,
  CLEANER_PHONE_LINE,
  PUBLIC_BASE_URL,
  LOGO_URL,
  C,
  FONT,
  esc,
  money,
  moneySigned,
  copyHtml
};
