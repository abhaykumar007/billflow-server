// Break-it checks for the barcode API. Registers two throwaway accounts on the server it is pointed at.
//   API=http://localhost:5000 node scripts/barcode-suite.mjs
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const stamp = Date.now();
let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); };

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
async function account(label) {
  const r = await call('POST', '/auth/register', null, { name: `BC ${label}`, email: `bc.${label}.${stamp}@example.com`, password: 'Passw0rd!23', business: { name: `BC Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.accessToken;
}
const item = (t, name, extra = {}) => call('POST', '/products', t, { name: `${name} ${stamp}`, sale_price: 150, tax_rate: 18, ...extra });
const mfr = String(stamp).slice(-12).padStart(12, '0'); // 12 digits, used as a manufacturer-style number

(async () => {
  const A = await account('a');
  const B = await account('b');

  // access control
  for (const [m, p] of [['GET', '/products/by-barcode/12345678'], ['POST', '/products/labels'], ['POST', '/products/x/barcodes/generate']]) {
    check(`no token ${m} ${p} 401`, (await call(m, p)).status === 401);
  }

  // generate
  const p1 = await item(A, 'Keyboard');
  check('item created with empty barcode list', p1.status === 201 && Array.isArray(p1.json.barcodes) && p1.json.barcodes.length === 0, JSON.stringify(p1.json));
  const g1 = await call('POST', `/products/${p1.json.id}/barcodes/generate`, A);
  const own1 = g1.json && g1.json.barcode && g1.json.barcode.code;
  check('generate: 13 digits starting with 2', g1.status === 201 && /^2\d{12}$/.test(own1 || ''), JSON.stringify(g1.json));
  const g2 = await call('POST', `/products/${p1.json.id}/barcodes/generate`, A);
  check('generate again: different code, item now has 2', g2.status === 201 && g2.json.barcode.code !== own1 && g2.json.barcodes.length === 2);

  // lookup
  let r = await call('GET', `/products/by-barcode/${own1}`, A);
  check('scan own code finds the item', r.status === 200 && r.json.id === p1.json.id && r.json.matched_kind === 'own', JSON.stringify(r.json));
  check('lookup returns price and GST in paise/percent', r.json.sale_price === 15000 && r.json.tax_rate === 18, JSON.stringify(r.json));
  r = await call('GET', `/products/by-barcode/${encodeURIComponent(` ${own1}\r\n`)}`, A);
  check('scanner whitespace and line break ignored', r.status === 200 && r.json.id === p1.json.id);
  r = await call('GET', `/products/by-barcode/${own1}`, B);
  check('other business cannot find it (404)', r.status === 404 && r.json.code === 'BARCODE_NOT_FOUND');
  r = await call('GET', '/products/by-barcode/9999999999994', A);
  check('unknown code 404 BARCODE_NOT_FOUND', r.status === 404 && r.json.code === 'BARCODE_NOT_FOUND');
  for (const bad of ['12', encodeURIComponent('<script>alert(1)</script>'), encodeURIComponent("1' OR '1'='1"), 'A'.repeat(60)]) {
    check(`lookup junk refused: ${decodeURIComponent(bad).slice(0, 20)}`, (await call('GET', `/products/by-barcode/${bad}`, A)).status === 400);
  }

  // manufacturer code
  r = await call('POST', `/products/${p1.json.id}/barcodes`, A, { code: mfr });
  check('add manufacturer code', r.status === 201 && r.json.barcode.kind === 'manufacturer', JSON.stringify(r.json));
  r = await call('POST', `/products/${p1.json.id}/barcodes`, A, { code: mfr });
  check('same code on same item 409', r.status === 409 && r.json.code === 'BARCODE_IN_USE');
  const p2 = await item(A, 'Mouse');
  r = await call('POST', `/products/${p2.json.id}/barcodes`, A, { code: mfr });
  check('same code on another item 409 and names owner', r.status === 409 && /Keyboard/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await call('POST', `/products/${p2.json.id}/barcodes`, A, { code: mfr.toLowerCase() });
  check('case-insensitive duplicate 409', r.status === 409);
  const pb = await item(B, 'Other shop item');
  r = await call('POST', `/products/${pb.json.id}/barcodes`, B, { code: mfr });
  check('another business may use the same number', r.status === 201, JSON.stringify(r.json));
  r = await call('POST', `/products/${p1.json.id}/barcodes`, B, { code: '5555555555' });
  check('cannot add a code to another business item (404)', r.status === 404);
  r = await call('POST', `/products/${p1.json.id}/barcodes`, A, { code: '4006381333932' });
  check('bad check digit accepted with a warning', r.status === 201 && r.json.warnings.length === 1, JSON.stringify(r.json));
  for (const body of [{}, { code: '' }, { code: 'abc' }, { code: '<b>1234</b>' }, { code: 12345678 }, { code: ['1234'] }, { code: null }, { code: 'x'.repeat(500) }]) {
    check(`add junk refused: ${JSON.stringify(body).slice(0, 30)}`, (await call('POST', `/products/${p1.json.id}/barcodes`, A, body)).status === 400);
  }

  // the 10-per-item limit
  const p3 = await item(A, 'Limit');
  let last = null;
  for (let i = 0; i < 11; i += 1) last = await call('POST', `/products/${p3.json.id}/barcodes`, A, { code: `LIM-${stamp}-${i}` });
  check('11th code on one item refused', last.status === 400, JSON.stringify(last.json));

  // create with barcode
  const code2 = `NEW-${stamp}`;
  r = await item(A, 'Created with code', { barcode: code2 });
  check('create item with barcode', r.status === 201 && r.json.barcodes[0].code === code2, JSON.stringify(r.json));
  r = await item(A, 'Second with same code', { barcode: code2 });
  check('create with taken barcode 409', r.status === 409 && r.json.code === 'BARCODE_IN_USE');
  r = await call('GET', `/products/by-barcode/${code2}`, A);
  check('lookup finds the created item', r.status === 200 && r.json.name.startsWith('Created with code'));
  r = await item(A, 'Junk barcode item', { barcode: '<x>' });
  check('create with junk barcode 400', r.status === 400);

  // search by barcode in the normal list
  r = await call('GET', `/products?search=${encodeURIComponent(code2)}`, A);
  check('list search finds item by barcode', r.status === 200 && r.json.products.length === 1, JSON.stringify(r.json).slice(0, 200));

  // remove, and deleting an item frees its codes
  const remove = await call('DELETE', `/products/${p1.json.id}/barcodes/${g2.json.barcode.id}`, B);
  check('another business cannot remove a code (404)', remove.status === 404);
  check('owner removes a code', (await call('DELETE', `/products/${p1.json.id}/barcodes/${g2.json.barcode.id}`, A)).status === 200);
  check('removed code no longer scans', (await call('GET', `/products/by-barcode/${g2.json.barcode.code}`, A)).status === 404);
  check('delete item', (await call('DELETE', `/products/${p2.json.id}`, A)).status === 200);
  const p4 = await item(A, 'Reuse');
  r = await call('POST', `/products/${p4.json.id}/barcodes`, A, { code: `LIM-${stamp}-0` });
  check('code of a different live item still refused', r.status === 409);
  check('deleting item with a code frees it', (await call('DELETE', `/products/${p3.json.id}`, A)).status === 200 && (await call('POST', `/products/${p4.json.id}/barcodes`, A, { code: `LIM-${stamp}-0` })).status === 201);

  // labels
  const lay = await call('GET', '/products/label-layouts', A);
  check('layouts listed', lay.status === 200 && lay.json.layouts.length === 4);
  r = await call('POST', '/products/labels', A, { items: [{ product_id: p1.json.id, copies: 30 }, { product_id: p4.json.id }], layout: 'a4-24' });
  check('labels: html with 31 labels on 2 sheets', r.status === 200 && r.json.count === 31 && (r.json.html.match(/class="sheet"/g) || []).length === 2);
  check('labels: page has content rule, no scripts', /Content-Security-Policy/.test(r.json.html) && !/<script/i.test(r.json.html));
  const empty = await item(A, 'No code item');
  r = await call('POST', '/products/labels', A, { items: [{ product_id: empty.json.id }] });
  check('labels: item without a code gives NO_BARCODES', r.status === 400 && r.json.code === 'NO_BARCODES');
  r = await call('POST', '/products/labels', B, { items: [{ product_id: p1.json.id }] });
  check('labels: other business item never printed', r.status === 400);
  for (const body of [{}, { items: [] }, { items: [{ product_id: p1.json.id, copies: 0 }] }, { items: [{ product_id: p1.json.id, copies: 101 }] }, { items: Array.from({ length: 6 }, () => ({ product_id: p1.json.id, copies: 100 })) }]) {
    check(`labels: refused ${JSON.stringify(body).slice(0, 40)}`, (await call('POST', '/products/labels', A, body)).status === 400);
  }
  r = await call('POST', '/products/labels', A, { items: [{ product_id: p1.json.id }], layout: 'thermal-38x25', show_price: false });
  check('labels: thermal layout, price hidden', r.status === 200 && r.json.html.includes('size:38mm 25mm') && !r.json.html.includes('class="p"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
