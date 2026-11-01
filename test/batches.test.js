const test = require('node:test');
const assert = require('node:assert/strict');
const { computeInvoiceTotals, normalizeBatchNo } = require('../src/utils/money');
const { isExpired, unitCostOf } = require('../src/services/stock');

const L = (o) => ({ description: 'Item', quantity: 1, rate: 0, tax_rate: 18, ...o });

test('exclusive maths is unchanged by the new code', () => {
  const t = computeInvoiceTotals([L({ rate: 10000, quantity: 2 }), L({ rate: 5000, tax_rate: 5 })], 3000);
  assert.equal(t.subtotal, 25000);
  assert.equal(t.discount_amount, 3000);
  assert.equal(t.discount_incl, null);
  assert.equal(t.total_amount, t.subtotal - t.discount_amount + t.tax_amount);
});

test('GST-inclusive: a price of 118.00 at 18% is 100.00 plus 18.00', () => {
  const t = computeInvoiceTotals([L({ rate: 11800 })], 0, { inclusive: true });
  assert.deepEqual([t.subtotal, t.tax_amount, t.total_amount, t.discount_amount], [10000, 1800, 11800, 0]);
});

test('GST-inclusive discount: typed as it is paid, stored GST-exclusive, identity holds', () => {
  const t = computeInvoiceTotals([L({ rate: 11800 })], 1180, { inclusive: true });
  assert.equal(t.total_amount, 10620);
  assert.equal(t.discount_incl, 1180);
  assert.equal(t.discount_amount, 1000); // the GST-free part of the discount
  assert.equal(t.subtotal - t.discount_amount + t.tax_amount, t.total_amount);
});

test('GST-inclusive equals GST-exclusive for the same goods (within rounding), and the identity always holds', () => {
  let seed = 7; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let n = 0; n < 500; n += 1) {
    const rates = [0, 5, 12, 18, 28]; const count = 1 + Math.floor(rnd() * 4);
    const lines = Array.from({ length: count }, () => ({ description: 'x', quantity: 1 + Math.floor(rnd() * 5), rate: 100 + Math.floor(rnd() * 90000), discount_percent: Math.floor(rnd() * 3) * 5, tax_rate: rates[Math.floor(rnd() * 5)] }));
    const incl = computeInvoiceTotals(lines, 0, { inclusive: true });
    const exLines = lines.map((l) => ({ ...l, rate: (l.rate * 100) / (100 + l.tax_rate) }));
    const ex = computeInvoiceTotals(exLines, 0);
    assert.equal(incl.subtotal - incl.discount_amount + incl.tax_amount, incl.total_amount, `identity ${JSON.stringify(lines)}`);
    assert.ok(Math.abs(incl.total_amount - ex.total_amount) <= count * 6, `total ${incl.total_amount} vs ${ex.total_amount}`);
    const withDiscount = computeInvoiceTotals(lines, Math.floor(incl.total_amount / 10), { inclusive: true });
    assert.equal(withDiscount.subtotal - withDiscount.discount_amount + withDiscount.tax_amount, withDiscount.total_amount, 'identity with discount');
    assert.equal(withDiscount.total_amount, computeInvoiceTotals(lines, 0, { inclusive: true }).total_amount - Math.floor(incl.total_amount / 10));
  }
});

test('GST-inclusive: a discount larger than the bill is refused', () => {
  assert.throws(() => computeInvoiceTotals([L({ rate: 11800 })], 20000, { inclusive: true }), /Discount cannot exceed/);
});

test('batch fields on a line: cleaned, validated, optional', () => {
  const t = computeInvoiceTotals([L({ rate: 1000, batch_no: ' ab 12 ', expiry_date: '2027-03-31', mfg_date: '2025-04-01', mrp: 12000, free_qty: '2', batch_sale_price: 11000, expired_override_reason: ' reason ' })]);
  const l = t.lines[0];
  assert.equal(l.batch_no, 'AB 12'); assert.equal(l.expiry_date.toISOString().slice(0, 10), '2027-03-31'); assert.equal(l.mrp, 12000); assert.equal(l.free_qty, 2);
  assert.equal(l.batch_sale_price, 11000); assert.equal(l.expired_override_reason, 'reason');
  const plain = computeInvoiceTotals([L({ rate: 1000 })]).lines[0];
  assert.deepEqual([plain.batch_id, plain.batch_no, plain.expiry_date, plain.mrp, plain.free_qty], [null, null, null, null, 0]);
});

test('batch fields: bad values are refused', () => {
  for (const bad of [{ batch_no: '<b>' }, { batch_no: 'x'.repeat(60) }, { expiry_date: '2027-02-30' }, { expiry_date: 'soon' }, { mfg_date: '1999-01-01' }, { mrp: -1 }, { mrp: 'abc' }, { free_qty: -1 }, { free_qty: 'x' }]) {
    assert.throws(() => computeInvoiceTotals([L({ rate: 1000, ...bad })]), /Invalid|Batch number/, JSON.stringify(bad));
  }
  assert.equal(normalizeBatchNo('bt-23/a'), 'BT-23/A');
  assert.throws(() => normalizeBatchNo('  '));
});

test('expired means before today: the last day is still sellable', () => {
  const today = new Date(Date.UTC(2026, 10, 1));
  assert.equal(isExpired(new Date(Date.UTC(2026, 9, 31)), today), true);
  assert.equal(isExpired(new Date(Date.UTC(2026, 10, 1)), today), false);
  assert.equal(isExpired(new Date(Date.UTC(2027, 0, 1)), today), false);
  assert.equal(isExpired(null, today), false);
});

test('cost of one piece counts free pieces: buy 10 + 2 free for 1000.00 -> 83.33 each', () => {
  assert.equal(unitCostOf({ quantity: 10, free_qty: 2, amount: 100000 }), 8333);
  assert.equal(unitCostOf({ quantity: 10, amount: 100000 }), 10000);
  assert.equal(unitCostOf({ quantity: 0.0001, free_qty: 0, amount: 0 }), 0);
});
