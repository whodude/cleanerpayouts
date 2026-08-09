// The only file that talks to the ConvertLabs API. Token stays server side, never sent to the browser.
// API reference: convert-labs-api-doc.docx (OpenAPI 3.1, read only, 60 requests/min per account),
// cross checked against the live API on a real account.
//
// NOTE on date filtering: the documented /bookings query params are status, page, per_page,
// sort (service_date|created_at), order, expand. Confirmed against the live API: there is no
// working date filter, an unknown service_date query param is silently ignored. service_date in
// the response is a full ISO timestamp (e.g. "2026-07-08T08:30:00+00:00"), best treated as a
// date string prefix rather than a true UTC instant for "what day is this booking on" purposes.
//
// Since there is no server side date filter, we page through /bookings sorted by service_date
// and filter client side, in both directions (desc for today/upcoming, asc for the recent past),
// each capped, and merge. This is a real limitation, not a guess, revisit if ConvertLabs adds a
// documented range filter.

const { normalizeBookings, normalizeSettings } = require('./normalize');

const BASE_URL = 'https://api.convertlabs.io';
const TOKEN = process.env.CONVERTLABS_TOKEN;
const LOCATION_ID = process.env.CONVERTLABS_LOCATION_ID;

const PAGE_CAP = 5; // 5 pages * 100 = 500 bookings max per direction, per fetch.
const PER_PAGE = 100;
const BOOKINGS_TTL_MS = 45 * 1000; // keeps us well under 60 req/min

const cache = new Map(); // key -> { expiresAt, value }

function isConfigured() {
  return Boolean(TOKEN);
}

function getFromCache(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCache(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

class ConvertLabsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ConvertLabsError';
    this.status = status;
  }
}

async function clRequest(path, query) {
  if (!isConfigured()) {
    throw new ConvertLabsError('CONVERTLABS_TOKEN is not set in .env', 503);
  }

  const url = new URL(BASE_URL + path);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key + '[]', v));
    } else {
      url.searchParams.set(key, value);
    }
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || JSON.stringify(body.errors || body);
    } catch (_) {
      // ignore, use empty detail
    }
    throw new ConvertLabsError(`ConvertLabs ${res.status} on ${path}${detail ? ': ' + detail : ''}`, res.status);
  }

  const body = await res.json();
  return body.data;
}

async function clRequestCached(path, query, ttlMs) {
  const key = path + JSON.stringify(query || {});
  const cached = getFromCache(key);
  if (cached !== undefined) return cached;
  const value = await clRequest(path, query);
  setCache(key, value, ttlMs);
  return value;
}

async function fetchBookingsDirection(direction) {
  const cacheKey = `bookings-raw:${direction}`;
  const cached = getFromCache(cacheKey);
  if (cached !== undefined) return cached;

  const collected = [];
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const rawPage = await clRequest('/bookings', {
      page,
      per_page: PER_PAGE,
      sort: 'service_date',
      order: direction
    });
    if (!Array.isArray(rawPage) || rawPage.length === 0) break;
    collected.push(...rawPage);
    if (rawPage.length < PER_PAGE) break; // last page
  }

  setCache(cacheKey, collected, BOOKINGS_TTL_MS);
  return collected;
}

// Pulls recent bookings from both sort directions (today/upcoming via desc, recent past via
// asc) and merges by id. See file header, this is a workaround for the lack of a date filter.
async function fetchRecentBookingsRaw() {
  const [desc, asc] = await Promise.all([fetchBookingsDirection('desc'), fetchBookingsDirection('asc')]);
  const byId = new Map();
  [...desc, ...asc].forEach((b) => byId.set(b.id, b));
  return Array.from(byId.values());
}

function applyLocationFilter(rawList) {
  if (!LOCATION_ID) return rawList;
  return rawList.filter((b) => String(b.location_id) === String(LOCATION_ID));
}

// Returns normalized bookings for one calendar date (YYYY-MM-DD).
async function getBookingsForDate(date) {
  const raw = await fetchRecentBookingsRaw();
  const filtered = applyLocationFilter(raw).filter((b) => typeof b.service_date === 'string' && b.service_date.slice(0, 10) === date);
  return normalizeBookings(filtered);
}

// Returns normalized bookings within [startDate, endDate] inclusive (YYYY-MM-DD strings).
async function getBookingsForRange(startDate, endDate) {
  const raw = await fetchRecentBookingsRaw();
  const filtered = applyLocationFilter(raw).filter((b) => {
    if (typeof b.service_date !== 'string') return false;
    const d = b.service_date.slice(0, 10);
    return d >= startDate && d <= endDate;
  });
  return normalizeBookings(filtered);
}

// Single booking by its ConvertLabs id. Unlike the list endpoint this one is a genuine direct
// lookup, verified against the live API, so the invoicing tool can pull up a clean from any
// point in history rather than only the ~500 recent bookings the paged fetch above can reach.
// Returns null on a 404 so a mistyped id reads as "not found" instead of a 500.
//
// Deliberately NOT normalized: normalizeBooking() drops summary.adjustment and the raw pricings
// rows, and the invoice needs both to reconstruct the charges. src/invoice.js maps it instead.
async function getBookingRawById(id) {
  const key = `booking:${id}`;
  const cached = getFromCache(key);
  if (cached !== undefined) return cached;
  let data;
  try {
    data = await clRequest(`/bookings/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ConvertLabsError && err.status === 404) return null;
    throw err;
  }
  setCache(key, data, BOOKINGS_TTL_MS);
  return data;
}

async function getSettings() {
  return clRequestCached('/settings', {}, 5 * 60 * 1000).then(normalizeSettings);
}

async function getCompany() {
  return clRequestCached('/company', {}, 30 * 60 * 1000);
}

module.exports = {
  isConfigured,
  getBookingsForDate,
  getBookingsForRange,
  getBookingRawById,
  getSettings,
  getCompany,
  ConvertLabsError
};
