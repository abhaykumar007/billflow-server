const { HttpError } = require('./httpError');
const { INT32_MAX } = require('./money');

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PHONE_RE = /^[+]?[0-9 ()-]{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^[0-9]{6}$/;

const trimOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// Validates the optional contact / tax fields shared by customers and suppliers.
// Returns only the fields that were actually provided (undefined = untouched).
function parseParty(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (has('name') || !partial) {
    const name = trimOrNull(body.name);
    if (!name) throw new HttpError(400, 'Name is required', 'VALIDATION');
    if (name.length > 120) throw new HttpError(400, 'Name is too long (max 120)', 'VALIDATION');
    out.name = name;
  }
  if (has('phone')) {
    const phone = trimOrNull(body.phone);
    if (phone && !PHONE_RE.test(phone)) throw new HttpError(400, 'Enter a valid phone number', 'VALIDATION');
    out.phone = phone;
  }
  if (has('email')) {
    const email = trimOrNull(body.email);
    if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address', 'VALIDATION');
    out.email = email ? email.toLowerCase() : null;
  }
  if (has('gstin')) {
    const gstin = trimOrNull(body.gstin)?.toUpperCase() || null;
    if (gstin && !GSTIN_RE.test(gstin)) throw new HttpError(400, 'Enter a valid 15-character GSTIN', 'VALIDATION');
    out.gstin = gstin;
  }
  if (has('pan')) {
    const pan = trimOrNull(body.pan)?.toUpperCase() || null;
    if (pan && !PAN_RE.test(pan)) throw new HttpError(400, 'Enter a valid 10-character PAN', 'VALIDATION');
    out.pan = pan;
  }
  if (has('pincode')) {
    const pin = trimOrNull(body.pincode);
    if (pin && !PIN_RE.test(pin)) throw new HttpError(400, 'Pincode must be 6 digits', 'VALIDATION');
    out.pincode = pin;
  }
  for (const k of ['address', 'city', 'state']) {
    if (has(k)) out[k] = trimOrNull(body[k]);
  }
  return out;
}

// rupees (number or string, may have paise) -> integer paise, validated
function rupeesToPaise(value, field = 'amount', { allowZero = true } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  const paise = Math.round(n * 100);
  if (paise > INT32_MAX) throw new HttpError(400, `${field} is too large`, 'AMOUNT_TOO_LARGE');
  if (!allowZero && paise === 0) throw new HttpError(400, `${field} must be greater than zero`, 'VALIDATION');
  return paise;
}

function pageParams(query, defLimit = 50, maxLimit = 200) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || defLimit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { parseParty, rupeesToPaise, pageParams, trimOrNull, GSTIN_RE, PAN_RE };
