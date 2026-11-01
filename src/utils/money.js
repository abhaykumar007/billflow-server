// Server-side invoice maths. The server is the single source of truth: totals
// sent by the client are ignored. All amounts are integer paise.
//
// Per line:   gross   = round(rate * qty)
//             amount  = gross - round(gross * disc% / 100)          (tax-exclusive)
// Invoice:    subtotal = Σ amount
//             the invoice-level discount is apportioned across lines in
//             proportion to line amount, and GST is charged on the
//             post-discount taxable value of each line (as GST law requires).
//             total = subtotal - discount + Σ tax
const { HttpError } = require('./httpError');

const INT32_MAX = 2147483647;

function num(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  }
  return n;
}

function assertInt32(value, field) {
  if (!Number.isInteger(value) || Math.abs(value) > INT32_MAX) {
    throw new HttpError(400, `${field} exceeds the maximum supported amount`, 'AMOUNT_TOO_LARGE');
  }
  return value;
}

// Optional per-line batch details (medical / FMCG). Shape only: whether they are required, and which batch is real, is decided
// by the invoice route (services/stock.js) because that needs the product and the database.
const BATCH_NO_RE = /^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/;
function normalizeBatchNo(raw) {
  const v = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!BATCH_NO_RE.test(v)) throw new HttpError(400, 'Batch number can have letters, numbers and . _ / - (up to 40 characters)', 'VALIDATION');
  return v;
}
function parseDay(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  const d = new Date(t);
  if (!m || Number.isNaN(t) || d.getUTCMonth() !== +m[2] - 1 || +m[1] < 2000 || +m[1] > 2100) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  return d;
}
function parseBatchFields(it, i) {
  const optInt = (v, field) => (v === undefined || v === null || v === '' ? null : Math.round(num(v, `${field} (item ${i + 1})`, { min: 0, max: INT32_MAX })));
  const reason = it.expired_override_reason == null ? '' : String(it.expired_override_reason).trim().slice(0, 200);
  return {
    batch_id: it.batch_id ? String(it.batch_id).slice(0, 40) : null,
    batch_no: it.batch_no ? normalizeBatchNo(it.batch_no) : null,
    expiry_date: parseDay(it.expiry_date, `expiry date (item ${i + 1})`),
    mfg_date: parseDay(it.mfg_date, `manufacturing date (item ${i + 1})`),
    mrp: optInt(it.mrp, 'MRP'),
    free_qty: it.free_qty === undefined || it.free_qty === null || it.free_qty === '' ? 0 : num(it.free_qty, `free quantity (item ${i + 1})`, { min: 0, max: 1e9 }),
    batch_sale_price: optInt(it.batch_sale_price, 'selling price'),
    expired_override_reason: reason || null,
  };
}

// opts.inclusive: the rates (and the invoice discount) include GST, as with MRP-style pricing. The stored figures are still the
// usual GST-exclusive ones, so reports do not change: amount/subtotal are ex-GST, tax_amount is the GST inside the price, and
// subtotal - discount_amount + tax_amount = total holds exactly. discount_incl keeps the discount as it was typed.
function computeInvoiceTotals(rawItems, rawDiscount = 0, opts = {}) {
  const inclusive = !!opts.inclusive;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'At least one item is required', 'VALIDATION');
  }
  if (rawItems.length > 200) throw new HttpError(400, 'Too many line items (max 200)', 'VALIDATION');

  const lines = rawItems.map((it, i) => {
    const description = String(it.description || '').trim();
    if (!description) throw new HttpError(400, `Item ${i + 1}: description is required`, 'VALIDATION');
    const quantity = num(it.quantity, `quantity (item ${i + 1})`, { min: 0.0001, max: 1e9 });
    const rate = Math.round(num(it.rate ?? 0, `rate (item ${i + 1})`, { min: 0, max: INT32_MAX }));
    const discount_percent = num(it.discount_percent ?? 0, `discount % (item ${i + 1})`, { min: 0, max: 100 });
    const tax_rate = num(it.tax_rate ?? 0, `GST % (item ${i + 1})`, { min: 0, max: 100 });
    const gross = Math.round(rate * quantity);
    const afterLine = gross - Math.round((gross * discount_percent) / 100); // GST-inclusive when inclusive
    const amount = inclusive ? Math.round((afterLine * 100) / (100 + tax_rate)) : afterLine;
    return {
      product_id: it.product_id || null,
      description: description.slice(0, 500),
      quantity,
      unit: String(it.unit || 'pcs').slice(0, 20),
      rate,
      discount_percent,
      tax_rate,
      amount,
      tax_amount: 0,
      ...parseBatchFields(it, i),
      _incl: afterLine,
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  let discount_amount; let discount_incl = null; let tax_amount; let total_amount;

  if (!inclusive) {
    discount_amount = Math.round(num(rawDiscount || 0, 'discount', { min: 0 }));
    if (discount_amount > subtotal) {
      throw new HttpError(400, 'Discount cannot exceed the subtotal', 'VALIDATION');
    }
    let remaining = discount_amount;
    lines.forEach((l, i) => {
      let share = 0;
      if (discount_amount > 0 && subtotal > 0) {
        share = i === lines.length - 1
          ? remaining
          : Math.round((discount_amount * l.amount) / subtotal);
        share = Math.max(0, Math.min(share, l.amount, remaining));
        remaining -= share;
      }
      l.tax_amount = Math.round(((l.amount - share) * l.tax_rate) / 100);
    });
    tax_amount = lines.reduce((s, l) => s + l.tax_amount, 0);
    total_amount = subtotal - discount_amount + tax_amount;
  } else {
    const inclSum = lines.reduce((s, l) => s + l._incl, 0);
    discount_incl = Math.round(num(rawDiscount || 0, 'discount', { min: 0 }));
    if (discount_incl > inclSum) throw new HttpError(400, 'Discount cannot exceed the bill amount', 'VALIDATION');
    let remaining = discount_incl; let taxableNet = 0;
    lines.forEach((l, i) => {
      let share = 0;
      if (discount_incl > 0 && inclSum > 0) {
        share = i === lines.length - 1 ? remaining : Math.round((discount_incl * l._incl) / inclSum);
        share = Math.max(0, Math.min(share, l._incl, remaining));
        remaining -= share;
      }
      const netIncl = l._incl - share;
      const taxable = Math.round((netIncl * 100) / (100 + l.tax_rate));
      l.tax_amount = netIncl - taxable; // the GST inside what the customer pays for this line
      taxableNet += taxable;
    });
    tax_amount = lines.reduce((s, l) => s + l.tax_amount, 0);
    discount_amount = subtotal - taxableNet; // the GST-exclusive part of the discount, so subtotal - discount + tax = total
    total_amount = inclSum - discount_incl;
  }
  lines.forEach((l) => { delete l._incl; });

  assertInt32(subtotal, 'Subtotal');
  assertInt32(total_amount, 'Invoice total');

  return { lines, subtotal, discount_amount, discount_incl, tax_amount, total_amount };
}

// Positive integer paise, validated. Use for every amount a client sends.
function parsePaise(value, field = 'amount') {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `${field} must be a positive whole number of paise`, 'VALIDATION');
  }
  return assertInt32(n, field);
}

module.exports = { computeInvoiceTotals, parsePaise, assertInt32, normalizeBatchNo, INT32_MAX };
