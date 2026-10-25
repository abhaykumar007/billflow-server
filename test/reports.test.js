const test = require('node:test');
const assert = require('node:assert');
const { gstLines, splitTax, dateRange, sumBy } = require('../src/utils/reportHelpers');

test('splitTax: intra-state splits CGST/SGST, inter-state is IGST', () => {
  assert.deepStrictEqual(splitTax(181, 'Karnataka', 'karnataka'), { cgst: 90, sgst: 91, igst: 0 });
  assert.deepStrictEqual(splitTax(180, 'Karnataka', 'Delhi'), { cgst: 0, sgst: 0, igst: 180 });
  assert.deepStrictEqual(splitTax(100, 'Karnataka', null), { cgst: 50, sgst: 50, igst: 0 });
});

test('gstLines: discount is apportioned, returns are negative', () => {
  const sale = { voucher_type: 'SALE', subtotal: 1000, discount_amount: 100, customer: { state: 'X' },
    items: [{ amount: 600, tax_amount: 54, tax_rate: 18 }, { amount: 400, tax_amount: 0, tax_rate: 0 }] };
  const ret = { voucher_type: 'SALE_RETURN', subtotal: 500, discount_amount: 0, customer: { state: 'X' },
    items: [{ amount: 500, tax_amount: 90, tax_rate: 18 }] };
  const rows = gstLines([sale, ret], 'X');
  assert.strictEqual(rows[0].taxable, 540);
  assert.strictEqual(rows[1].taxable, 360);
  assert.strictEqual(sumBy(rows, 'taxable'), 540 + 360 - 500);
  assert.strictEqual(sumBy(rows, 'tax'), 54 - 90);
});

test('dateRange uses calendar dates, not local time', () => {
  const r = dateRange('2026-04-01', '2026-04-30');
  assert.strictEqual(r.gte.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.strictEqual(r.lte.toISOString(), '2026-04-30T23:59:59.999Z');
});
