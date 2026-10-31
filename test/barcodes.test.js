const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { normalizeCode, codeProblem, gs1CheckDigit, hasValidGs1Check, checkDigitWarning, ownCodeFor, barcodeFormat } = require('../src/utils/barcode');
const { renderLabels, LAYOUTS } = require('../src/services/labelRenderer');
const { loadApp, start } = require('./helpers');

test('normalize: spaces, line breaks and case from a scanner are removed', () => {
  assert.equal(normalizeCode(' 4006381333931\r\n'), '4006381333931');
  assert.equal(normalizeCode('shop-001 '), 'SHOP-001');
  assert.equal(normalizeCode('12 34\t56'), '123456');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(12345), '');
  assert.equal(normalizeCode({ a: 1 }), '');
});

test('code rules: 4 to 48 safe characters', () => {
  for (const ok of ['1234', '4006381333931', 'SHOP-0001', 'A.B_C/D-1']) assert.equal(codeProblem(ok), null, ok);
  for (const bad of ['', '123', 'A'.repeat(49), '-1234', '12<34>', '12"34', "12'34", '12;34', 'ÀBCD1', '12 34']) assert.ok(codeProblem(bad), bad);
});

test('check digit: real EAN-13, UPC-A and EAN-8 numbers', () => {
  assert.equal(gs1CheckDigit('400638133393'), 1);
  assert.equal(hasValidGs1Check('4006381333931'), true);
  assert.equal(hasValidGs1Check('036000291452'), true);
  assert.equal(hasValidGs1Check('96385074'), true);
  assert.equal(hasValidGs1Check('4006381333932'), false);
  assert.equal(hasValidGs1Check('ABC12345'), false);
  assert.equal(checkDigitWarning('4006381333932') !== null, true);
  assert.equal(checkDigitWarning('4006381333931'), null);
  assert.equal(checkDigitWarning('123456789'), null); // not a standard length: nothing to check
  assert.equal(checkDigitWarning('SHOP-0001'), null);
});

test('own codes: EAN-13 starting with 2, valid check digit, unique per number', () => {
  const seen = new Set();
  for (const n of [1, 2, 9, 10, 99, 12345, 99999999999]) {
    const c = ownCodeFor(n);
    assert.equal(c.length, 13); assert.equal(c[0], '2'); assert.equal(hasValidGs1Check(c), true, c);
    assert.equal(seen.has(c), false); seen.add(c);
  }
  assert.throws(() => ownCodeFor(100000000000));
});

test('format: standard retail types when the digits allow, Code 128 otherwise', () => {
  assert.equal(barcodeFormat('4006381333931'), 'ean13');
  assert.equal(barcodeFormat('036000291452'), 'upca');
  assert.equal(barcodeFormat('96385074'), 'ean8');
  assert.equal(barcodeFormat('4006381333932'), 'code128');
  assert.equal(barcodeFormat('SHOP-0001'), 'code128');
});

test('labels: copies, sheets, escaping and the content rule', () => {
  const labels = Array.from({ length: 30 }, (_, i) => ({ name: i === 0 ? '<img src=x onerror=alert(1)>"\'' : `Item ${i}`, code: i % 2 ? ownCodeFor(i) : 'SHOP-0001', price: 150000 }));
  const html = renderLabels({ labels, layout: 'a4-24' });
  assert.equal((html.match(/class="sheet"/g) || []).length, 2); // 24 per sheet
  assert.equal((html.match(/class="lbl"/g) || []).length, 30);
  assert.ok(html.includes('http-equiv="Content-Security-Policy"') && html.includes("default-src 'none'"));
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img src=x'));
  assert.equal(/<script/i.test(html), false);
  const thermal = renderLabels({ labels: labels.slice(0, 3), layout: 'thermal-50x25' });
  assert.ok(thermal.includes('size:50mm 25mm') && (thermal.match(/class="lbl"/g) || []).length === 3);
  assert.ok(renderLabels({ labels: labels.slice(0, 2), layout: 'nonsense' }).includes('class="sheet"')); // unknown layout falls back
  assert.ok(renderLabels({ labels: labels.slice(1, 2), layout: 'a4-65', show_price: false, show_name: false }).includes('class="lbl"'));
  assert.equal(Object.keys(LAYOUTS).length, 4);
});

// ── routes ────────────────────────────────────────────────────────────────────
const token = (businessId = 'b1') => jwt.sign({ userId: 'u1', businessId, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const hdr = (businessId) => ({ authorization: `Bearer ${token(businessId)}`, 'content-type': 'application/json' });
async function withApp(overrides, fn) {
  const srv = await start(loadApp(overrides));
  try { await fn(srv.base); } finally { await srv.close(); }
}
const PRODUCT = { id: 'p1', business_id: 'b1', name: 'Wireless Keyboard', sale_price: 150000, tax_rate: 18, unit: 'pcs', is_active: true, is_deleted: false, barcodes: [] };

test('routes: sign-in is required for every barcode endpoint', async () => {
  await withApp({}, async (base) => {
    for (const [m, p] of [['GET', '/api/products/by-barcode/123456'], ['POST', '/api/products/labels'], ['GET', '/api/products/label-layouts'], ['GET', '/api/products/p1/barcodes'], ['POST', '/api/products/p1/barcodes'], ['POST', '/api/products/p1/barcodes/generate'], ['DELETE', '/api/products/p1/barcodes/x']]) {
      assert.equal((await fetch(base + p, { method: m })).status, 401, `${m} ${p}`);
    }
  });
});

test('routes: lookup is scoped to the business, cleans scanner input and refuses junk', async () => {
  const asked = [];
  const stub = { productBarcode: { findFirst: async ({ where }) => { asked.push(where); return where.code === '4006381333931' && where.business_id === 'b1' ? { kind: 'manufacturer', product: { ...PRODUCT, barcodes: [{ id: 'x', code: '4006381333931', kind: 'manufacturer' }] } } : null; } } };
  await withApp(stub, async (base) => {
    let r = await fetch(`${base}/api/products/by-barcode/${encodeURIComponent(' 4006381333931\r\n')}`, { headers: hdr('b1') });
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.name, 'Wireless Keyboard'); assert.equal(j.matched_code, '4006381333931'); assert.equal(j.sale_price, 150000);
    assert.equal(asked[0].business_id, 'b1'); assert.equal(asked[0].product.is_deleted, false);
    r = await fetch(`${base}/api/products/by-barcode/4006381333931`, { headers: hdr('someone-else') });
    assert.equal(r.status, 404); assert.equal((await r.json()).code, 'BARCODE_NOT_FOUND');
    for (const bad of ['12', encodeURIComponent('<script>'), encodeURIComponent("1' OR '1'='1"), 'A'.repeat(60)]) {
      assert.equal((await fetch(`${base}/api/products/by-barcode/${bad}`, { headers: hdr('b1') })).status, 400, bad);
    }
  });
});

test('routes: adding a code refuses duplicates and names the item that owns it', async () => {
  let created = null;
  const stub = {
    product: { findFirst: async () => PRODUCT },
    productBarcode: {
      count: async () => 0,
      findFirst: async ({ where }) => (where.code === '8901234567890' ? { id: 'z', product_id: 'p2', product: { id: 'p2', name: 'Red Pen', is_deleted: false } } : null),
      create: async ({ data }) => { created = data; return { id: 'n1', code: data.code, kind: data.kind }; },
      findMany: async () => (created ? [{ id: 'n1', code: created.code, kind: 'manufacturer' }] : []),
    },
  };
  await withApp(stub, async (base) => {
    let r = await fetch(`${base}/api/products/p1/barcodes`, { method: 'POST', headers: hdr(), body: JSON.stringify({ code: '8901234567890' }) });
    let j = await r.json();
    assert.equal(r.status, 409); assert.equal(j.code, 'BARCODE_IN_USE'); assert.ok(j.error.includes('Red Pen'));
    r = await fetch(`${base}/api/products/p1/barcodes`, { method: 'POST', headers: hdr(), body: JSON.stringify({ code: ' 4006381333932 ' }) });
    j = await r.json();
    assert.equal(r.status, 201); assert.equal(created.business_id, 'b1'); assert.equal(created.code, '4006381333932'); assert.equal(j.warnings.length, 1);
    for (const body of [{}, { code: '' }, { code: 'ab' }, { code: '<b>1234</b>' }, { code: 5 }, { code: ['1234'] }]) {
      assert.equal((await fetch(`${base}/api/products/p1/barcodes`, { method: 'POST', headers: hdr(), body: JSON.stringify(body) })).status, 400, JSON.stringify(body));
    }
  });
});

test('routes: generate makes an own EAN-13 from the business counter, limits per item', async () => {
  let counter = 5; let made = null; let count = 0;
  const stub = {
    product: { findFirst: async () => PRODUCT },
    business: { update: async () => ({ barcode_next_number: ++counter }) },
    productBarcode: {
      count: async () => count, findFirst: async () => null,
      create: async ({ data }) => { made = data; return { id: 'n', code: data.code, kind: data.kind }; },
      findMany: async () => (made ? [{ id: 'n', code: made.code, kind: 'own' }] : []),
    },
  };
  await withApp(stub, async (base) => {
    let r = await fetch(`${base}/api/products/p1/barcodes/generate`, { method: 'POST', headers: hdr() });
    const j = await r.json();
    assert.equal(r.status, 201); assert.equal(made.kind, 'own'); assert.equal(made.code, ownCodeFor(5)); // counter was 5, moves to 6, this item takes 5 assert.equal(hasValidGs1Check(j.barcode.code), true);
    count = 10;
    r = await fetch(`${base}/api/products/p1/barcodes/generate`, { method: 'POST', headers: hdr() });
    assert.equal(r.status, 400);
  });
});

test('routes: label sheets validate input, skip items without a code and cap the size', async () => {
  const stub = {
    product: {
      findMany: async ({ where }) => [
        { ...PRODUCT, id: 'p1', barcodes: [{ id: 'a', code: '2000000000017', kind: 'own' }] },
        { ...PRODUCT, id: 'p2', name: 'No Code', barcodes: [] },
      ].filter((p) => where.id.in.includes(p.id) && where.business_id === 'b1'),
    },
  };
  await withApp(stub, async (base) => {
    const post = (body) => fetch(`${base}/api/products/labels`, { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    let r = await post({ items: [{ product_id: 'p1', copies: 3 }, { product_id: 'p2' }, { product_id: 'ghost' }], layout: 'thermal-50x25' });
    let j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.count, 3); assert.equal(j.skipped.length, 2); assert.ok(j.html.includes('Wireless Keyboard') && j.html.includes('2000000000017'));
    r = await post({ items: [{ product_id: 'p2' }] });
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'NO_BARCODES');
    for (const bad of [{}, { items: [] }, { items: 'x' }, { items: [{ product_id: 'p1', copies: 0 }] }, { items: [{ product_id: 'p1', copies: 101 }] }, { items: [{ product_id: 'p1', copies: 1.5 }] }, { items: [{}] }, { items: Array.from({ length: 101 }, () => ({ product_id: 'p1' })) }, { items: Array.from({ length: 6 }, () => ({ product_id: 'p1', copies: 100 })) }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    r = await fetch(`${base}/api/products/labels`, { method: 'POST', headers: hdr('other-business'), body: JSON.stringify({ items: [{ product_id: 'p1' }] }) });
    assert.equal(r.status, 400); // nothing of this business's: no leak of another business's item
    r = await fetch(`${base}/api/products/label-layouts`, { headers: hdr() });
    assert.equal((await r.json()).layouts.length, 4);
  });
});

test('routes: removing a code only works inside the business', async () => {
  let deleted = null;
  const stub = { productBarcode: { findFirst: async ({ where }) => (where.business_id === 'b1' && where.id === 'bc1' ? { id: 'bc1' } : null), delete: async ({ where }) => { deleted = where.id; } } };
  await withApp(stub, async (base) => {
    assert.equal((await fetch(`${base}/api/products/p1/barcodes/bc1`, { method: 'DELETE', headers: hdr('other') })).status, 404);
    assert.equal(deleted, null);
    assert.equal((await fetch(`${base}/api/products/p1/barcodes/bc1`, { method: 'DELETE', headers: hdr('b1') })).status, 200);
    assert.equal(deleted, 'bc1');
  });
});
