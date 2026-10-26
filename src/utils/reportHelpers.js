const { parseDayStart, parseDayEnd, todayDate } = require('./time');

// { gte, lte } for a from/to pair; falls back to the financial year's bounds.
// Dates are calendar dates (see utils/time.js), never local-time midnights.
function dateRange(from, to, fy = null) {
  const f = from || (fy ? fy.start_date : null);
  const t = to || (fy ? fy.end_date : null);
  const range = {};
  if (f) range.gte = parseDayStart(f);
  if (t) range.lte = parseDayEnd(t);
  return range;
}

function invoiceDateWhere(from, to, fy) {
  const r = dateRange(from, to, fy);
  return Object.keys(r).length ? { invoice_date: r } : {};
}

const ymd = (d) => (d ? new Date(d).toISOString().split('T')[0] : null);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Split tax into CGST/SGST/IGST. Inter-state only when both states are known and differ.
// (Invoices do not store a place of supply, so the party's registered state is the best signal.)
function splitTax(tax, businessState, partyState) {
  const inter = norm(businessState) && norm(partyState) && norm(businessState) !== norm(partyState);
  if (inter) return { cgst: 0, sgst: 0, igst: tax };
  const half = Math.floor(tax / 2);
  return { cgst: half, sgst: tax - half, igst: 0 };
}

const isReturn = (vt) => vt === 'SALE_RETURN' || vt === 'PURCHASE_RETURN';

// Flatten invoices (with items + party) into GST lines. Item.amount is tax-exclusive and
// BEFORE the invoice-level discount, so the discount is apportioned to get the taxable value.
// Returns are negative so sums are net of credit/debit notes.
function gstLines(invoices, businessState) {
  const rows = [];
  for (const inv of invoices) {
    const sign = isReturn(inv.voucher_type) ? -1 : 1;
    const party = inv.customer || inv.supplier || {};
    const base = inv.subtotal || 0;
    for (const it of inv.items) {
      const disc = base > 0 ? Math.round(((inv.discount_amount || 0) * it.amount) / base) : 0;
      const taxable = it.amount - disc;
      const split = splitTax(it.tax_amount, businessState, party.state);
      rows.push({
        inv, sign, rate: it.tax_rate || 0, item: it,
        taxable: sign * taxable,
        cgst: sign * split.cgst, sgst: sign * split.sgst, igst: sign * split.igst,
        tax: sign * it.tax_amount,
      });
    }
  }
  return rows;
}

const sumBy = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

module.exports = { dateRange, invoiceDateWhere, ymd, splitTax, gstLines, sumBy, isReturn, todayDate };
