// Business time is IST (UTC+05:30, no DST). The server runs in UTC on Render,
// so "today" / "this month" must be computed explicitly, never via local time.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function istParts(date = new Date()) {
  const t = new Date(date.getTime() + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

function istDayStart(date = new Date()) {
  const { y, m, d } = istParts(date);
  return new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
}

function istMonthStart(date = new Date()) {
  const { y, m } = istParts(date);
  return new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS);
}

// ── Calendar-date convention ────────────────────────────────────────────────
// Invoice / payment / expense dates are CALENDAR dates: the browser sends
// 'YYYY-MM-DD' and we store that day at 00:00 UTC (this is also how existing data
// was stored, and how financial-year bounds are stored). Range filters use the
// same convention, so a record dated 2026-04-01 is always inside 2026-04-01.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Today's IST calendar date as a Date at 00:00 UTC. Use instead of `new Date()` for default dates.
function todayDate(now = new Date()) {
  const { y, m, d } = istParts(now);
  return new Date(Date.UTC(y, m, d));
}

// First day of the current IST month as a calendar date
function monthStartDate(now = new Date()) {
  const { y, m } = istParts(now);
  return new Date(Date.UTC(y, m, 1));
}

function parseDayStart(value) {
  if (value instanceof Date) return value;
  if (DATE_ONLY.test(String(value))) {
    const [y, m, d] = String(value).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date(value);
}

function parseDayEnd(value) {
  if (DATE_ONLY.test(String(value))) {
    return new Date(parseDayStart(value).getTime() + DAY_MS - 1);
  }
  const d = new Date(value);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function isValidDate(d) {
  return d instanceof Date && !isNaN(d.getTime());
}

module.exports = {
  IST_OFFSET_MS, DAY_MS, istParts, istDayStart, istMonthStart,
  todayDate, monthStartDate, parseDayStart, parseDayEnd, isValidDate,
};
