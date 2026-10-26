const test = require('node:test');
const assert = require('node:assert/strict');
const { computeInvoiceTotals, parsePaise } = require('../src/utils/money');
const { todayDate, parseDayStart, parseDayEnd, istMonthStart } = require('../src/utils/time');

test('totals: line discount, invoice discount apportioned, GST on post-discount value', () => {
  const t = computeInvoiceTotals([
    { description: 'a', quantity: 3, rate: 10000, discount_percent: 10, tax_rate: 18 },
    { description: 'b', quantity: 1, rate: 5000, tax_rate: 5 },
  ], 2000);
  assert.equal(t.subtotal, 32000);
  assert.equal(t.discount_amount, 2000);
  assert.deepEqual(t.lines.map((l) => l.tax_amount), [4556, 234]);
  assert.equal(t.tax_amount, 4790);
  assert.equal(t.total_amount, 32000 - 2000 + 4790);
});

test('totals: client-supplied amounts are ignored', () => {
  const t = computeInvoiceTotals([{ description: 'x', quantity: 1, rate: 10000, tax_rate: 18, amount: 1, tax_amount: 0, total_amount: 1 }], 0);
  assert.equal(t.lines[0].amount, 10000);
  assert.equal(t.total_amount, 11800);
});

test('totals: rejects bad input', () => {
  const bad = (items, d) => assert.throws(() => computeInvoiceTotals(items, d), (e) => e.status === 400);
  bad([], 0);
  bad([{ description: '', quantity: 1, rate: 1 }], 0);
  bad([{ description: 'x', quantity: -1, rate: 1 }], 0);
  bad([{ description: 'x', quantity: 1, rate: 100, discount_percent: 120 }], 0);
  bad([{ description: 'x', quantity: 1, rate: 100, tax_rate: 500 }], 0);
  bad([{ description: 'x', quantity: 1, rate: 100 }], 101);
  bad([{ description: 'x', quantity: 1, rate: 2000000000, tax_rate: 28 }], 0); // overflows int32
});

test('totals: fractional quantity and full discount', () => {
  const t = computeInvoiceTotals([{ description: 'rice', quantity: 2.5, rate: 4000, tax_rate: 5 }], 10000);
  assert.equal(t.subtotal, 10000);
  assert.equal(t.total_amount, 0);
});

test('parsePaise only accepts positive whole paise', () => {
  assert.equal(parsePaise(500), 500);
  for (const v of [0, -5, 1.5, 'abc', null, 3e10]) assert.throws(() => parsePaise(v), (e) => e.status === 400);
});

test('IST calendar dates', () => {
  // 2026-10-25 23:30 UTC is already 2026-10-26 05:00 IST
  assert.equal(todayDate(new Date('2026-10-25T23:30:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(todayDate(new Date('2026-10-25T10:00:00Z')).toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(parseDayStart('2026-04-01').toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(parseDayEnd('2026-04-01').toISOString(), '2026-04-01T23:59:59.999Z');
  assert.equal(istMonthStart(new Date('2026-10-31T20:00:00Z')).toISOString(), '2026-10-31T18:30:00.000Z');
});
