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

function computeInvoiceTotals(rawItems, rawDiscount = 0) {
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
    const amount = gross - Math.round((gross * discount_percent) / 100);
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
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const discount_amount = Math.round(num(rawDiscount || 0, 'discount', { min: 0 }));
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

  const tax_amount = lines.reduce((s, l) => s + l.tax_amount, 0);
  const total_amount = subtotal - discount_amount + tax_amount;

  assertInt32(subtotal, 'Subtotal');
  assertInt32(total_amount, 'Invoice total');

  return { lines, subtotal, discount_amount, tax_amount, total_amount };
}

// Positive integer paise, validated. Use for every amount a client sends.
function parsePaise(value, field = 'amount') {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `${field} must be a positive whole number of paise`, 'VALIDATION');
  }
  return assertInt32(n, field);
}

module.exports = { computeInvoiceTotals, parsePaise, assertInt32, INT32_MAX };
