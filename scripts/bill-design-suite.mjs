// Break-it checks for the bill design API. Registers two throwaway accounts on the server it is pointed at.
//   API=http://localhost:5000 node scripts/bill-design-suite.mjs
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const stamp = Date.now();
let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); };

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
async function account(label, gstin) {
  const r = await call('POST', '/auth/register', null, { name: `BD ${label}`, email: `bd.${label}.${stamp}@example.com`, password: 'Passw0rd!23', business: { name: `BD Biz ${label}`, state: 'Karnataka', city: 'Bengaluru', ...(gstin ? { gstin } : {}) }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.accessToken;
}
async function invoiceFor(token, label) {
  const c = await call('POST', '/customers', token, { name: `Customer ${label}`, state: 'Karnataka' });
  const i = await call('POST', '/invoices', token, { voucher_type: 'SALE', status: 'sent', customer_id: c.json.id, invoice_date: new Date().toISOString().slice(0, 10), items: [{ description: `Item for ${label}`, quantity: 2, unit: 'pcs', rate: 100000, discount_percent: 0, tax_rate: 18 }], discount_amount: 0 }, { 'idempotency-key': `bd-${label}-${stamp}` });
  return i.json;
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const A = await account('a', '29AAAAA0000A1Z5');
  const B = await account('b');
  const invA = await invoiceFor(A, 'a');
  check('setup: account A has an invoice', !!invA.id, JSON.stringify(invA));

  // access control
  check('no token: GET design 401', (await call('GET', '/bill-design')).status === 401);
  check('no token: preview 401', (await call('POST', '/bill-design/preview', null, {})).status === 401);
  check('no token: print 401', (await call('GET', `/invoices/${invA.id}/print`)).status === 401);
  check('garbage token 401', (await call('GET', '/bill-design', 'not.a.token')).status === 401);

  // tenant isolation
  await call('PUT', '/bill-design', A, { design: { layout: 'modern', accent: '#b91c1c', extras: { footer_text: 'A-ONLY-FOOTER' } } });
  await call('PUT', '/bill-design/assets', A, { upi_id: 'secret-a@okbank', logo_data: PNG });
  const bd = await call('GET', '/bill-design', B);
  check('B sees its own default design, not A\'s', bd.json.design.layout === 'classic' && bd.json.design.extras.footer_text === '' && !bd.json.upi_id && !bd.json.logo_data, JSON.stringify(bd.json).slice(0, 200));
  const pr = await call('GET', `/invoices/${invA.id}/print`, B);
  check('B cannot print A\'s invoice (404)', pr.status === 404, String(pr.status));
  const pv = await call('POST', '/bill-design/preview', B, { design: {} });
  check('B preview contains none of A\'s data', pv.status === 200 && !pv.json.html.includes('A-ONLY') && !pv.json.html.includes('secret-a') && !pv.json.html.includes('BD Biz a'));
  const own = await call('GET', `/invoices/${invA.id}/print`, A);
  check('A can print its invoice with its design', own.status === 200 && own.json.html.includes('A-ONLY-FOOTER') && own.json.html.includes('Item for a'));
  check('B cannot overwrite A\'s design (writes only touch B)', (await call('PUT', '/bill-design', B, { design: { layout: 'compact' } })).status === 200 && (await call('GET', '/bill-design', A)).json.design.layout === 'modern');

  // hostile design input
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'`';
  const saveEvil = await call('PUT', '/bill-design', A, { design: { labels: { title_sale: evil, col_rate: evil }, extras: { footer_text: evil, signatory_text: evil } } });
  check('script text in labels is accepted as plain text', saveEvil.status === 200, String(saveEvil.status));
  const html = (await call('GET', `/invoices/${invA.id}/print`, A)).json.html;
  check('printed page has no live script or event handler', !/<script/i.test(html) && !/<img src=x/i.test(html) && !/onerror=/i.test(html.replace(/&lt;[^>]*?onerror=[^&]*?&gt;/gi, '')));
  check('printed page shows it escaped', html.includes('&lt;script&gt;'));
  for (const bad of [
    { design: [] }, { design: 'x' }, { design: 5 }, { design: null }, {}, [], 'text',
  ]) check(`invalid body ${JSON.stringify(bad).slice(0, 30)} is 400 not 500`, (await call('PUT', '/bill-design', A, bad)).status === 400);
  const weird = await call('PUT', '/bill-design', A, { design: { layout: { a: 1 }, accent: 123, font: ['x'], paper: null, header: 'str', columns: [1], labels: 'x', totals: 5, extras: { bank_account_id: '../../x', footer_text: 99 } } });
  check('wrong types fall back to defaults (200)', weird.status === 200 && weird.json.design.layout === 'classic' && weird.json.design.accent === '#1e3a8a' && weird.json.design.extras.bank_account_id === null, JSON.stringify(weird.json).slice(0, 150));
  const proto = await call('PUT', '/bill-design', A, '{"design":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"layout":"compact"}}');
  check('__proto__ / constructor keys are harmless', proto.status === 200 && ({}).polluted === undefined && proto.json.design.layout === 'compact');
  let deep = {}; let cur = deep; for (let i = 0; i < 3000; i++) { cur.a = {}; cur = cur.a; }
  const deepRes = await call('PUT', '/bill-design', A, { design: { header: deep } });
  check('deeply nested JSON does not crash (no 5xx)', deepRes.status < 500, String(deepRes.status));
  const big = await call('PUT', '/bill-design', A, { design: { extras: { footer_text: 'x'.repeat(2_000_000) } } });
  check('over-size body is refused (413)', big.status === 413, String(big.status));
  const longLabel = await call('PUT', '/bill-design', A, { design: { labels: { title_sale: 'y'.repeat(100000) } } });
  check('very long label is trimmed to 40', longLabel.status === 200 && longLabel.json.design.labels.title_sale.length === 40);

  // GST locks through the API
  const hide = await call('PUT', '/bill-design', A, { design: { header: { name: false, address: false, gstin: false }, party: { gstin: false }, columns: { tax_rate: false }, totals: { tax_breakup: false } } });
  const d = hide.json.design;
  check('GST business: required fields cannot be switched off', d.header.name && d.header.address && d.header.gstin && d.party.gstin && d.columns.tax_rate && d.totals.tax_breakup && hide.json.locked.length === 6);
  const hideB = await call('PUT', '/bill-design', B, { design: { header: { gstin: false }, columns: { tax_rate: false } } });
  check('non-GST business can hide them', hideB.json.design.header.gstin === false && hideB.json.design.columns.tax_rate === false && hideB.json.locked.length === 0);

  // images
  const bads = ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 'javascript:alert(1)', 'https://evil.example/x.png', 'data:image/png;base64,AAAA"onerror="x', 'data:image/png;base64,', 123, {}, 'x'.repeat(1000)];
  for (const b of bads) check(`logo rejects ${String(typeof b === 'string' ? b.slice(0, 28) : typeof b)}`, (await call('PUT', '/bill-design/assets', A, { logo_data: b })).status === 400);
  const hugeImg = await call('PUT', '/bill-design/assets', A, { logo_data: `data:image/png;base64,${'A'.repeat(450000)}` });
  check('image over the size limit is refused (400)', hugeImg.status === 400, String(hugeImg.status));
  const wayHuge = await call('PUT', '/bill-design/assets', A, { logo_data: `data:image/png;base64,${'A'.repeat(1500000)}` });
  check('image over the body limit is refused (413)', wayHuge.status === 413, String(wayHuge.status));
  const okLogo = await call('PUT', '/bill-design/assets', A, { logo_data: PNG, signature_data: PNG });
  check('valid logo and signature saved', okLogo.status === 200 && okLogo.json.logo_data === PNG && okLogo.json.signature_data === PNG);
  check('logo appears on the printed bill', (await call('GET', `/invoices/${invA.id}/print`, A)).json.html.includes(PNG));
  const clear = await call('PUT', '/bill-design/assets', A, { logo_data: null, signature_data: '' });
  check('logo and signature can be removed', clear.json.logo_data === null && clear.json.signature_data === null);
  check('empty assets body is 400', (await call('PUT', '/bill-design/assets', A, {})).status === 400);

  // UPI
  const upiBad = ['', ' ', 'a b@okbank', 'upi://pay?pa=x@y', 'x@', '@y', 'x@y z', 'a'.repeat(10000) + '@okbank', 'x@y"><script>', 'x@y\nz', 12345, [], 'a@b@c'];
  let upiOk = true; const upiFailed = [];
  for (const u of upiBad) { const r = await call('PUT', '/bill-design/assets', A, { upi_id: u }); const expect400 = !(u === '' ); if (u === '' ? r.status !== 200 : r.status !== 400) { upiOk = false; upiFailed.push(`${String(u).slice(0, 12)}:${r.status}`); } void expect400; }
  check('bad UPI ids are refused (empty clears)', upiOk, upiFailed.join(' '));
  check('good UPI id saved and trimmed', (await call('PUT', '/bill-design/assets', A, { upi_id: '  shop.a@okbank ' })).json.upi_id === 'shop.a@okbank');
  await call('PUT', '/bill-design', A, { design: { extras: { upi_qr: true, upi_with_amount: true } } });
  const qr = (await call('GET', `/invoices/${invA.id}/print`, A)).json.html;
  check('UPI QR with the amount due is on an unpaid sale', qr.includes('Scan to pay') && qr.includes('<svg'));

  // print endpoint edges
  for (const p of ['a4', 'a5', 't80', 't58', 'thermal', 'poster', '../../etc/passwd', '<x>', '']) {
    const r = await call('GET', `/invoices/${invA.id}/print?paper=${encodeURIComponent(p)}`, A);
    check(`print paper=${p || '(empty)'} returns a page`, r.status === 200 && r.json.html.startsWith('<!doctype html>') && ['a4', 'a5', 't80', 't58'].includes(r.json.paper));
  }
  check('print unknown id 404', (await call('GET', '/invoices/nope/print', A)).status === 404);
  check('print id with quotes 404', (await call('GET', `/invoices/${encodeURIComponent("' OR 1=1 --")}/print`, A)).status === 404);

  // preview with hostile body and load
  check('preview ignores junk paper', (await call('POST', '/bill-design/preview', A, { design: {}, paper: '<b>' })).status === 200);
  check('preview with no body works', (await call('POST', '/bill-design/preview', A, {})).status === 200);
  const burst = await Promise.all(Array.from({ length: 30 }, () => call('POST', '/bill-design/preview', A, { design: { layout: 'modern' }, paper: 'a4' })));
  check('30 parallel previews all succeed', burst.every((r) => r.status === 200), burst.map((r) => r.status).join(','));

  // long bill
  const items = Array.from({ length: 120 }, (_, i) => ({ description: `Bulk line ${i + 1}`, quantity: 1, unit: 'pcs', rate: 1000 + i, discount_percent: 0, tax_rate: 12 }));
  const cust = await call('POST', '/customers', A, { name: 'Bulk Buyer', state: 'Karnataka' });
  const bulk = await call('POST', '/invoices', A, { voucher_type: 'SALE', status: 'sent', customer_id: cust.json.id, invoice_date: new Date().toISOString().slice(0, 10), items, discount_amount: 0 }, { 'idempotency-key': `bulk-${stamp}` });
  const bulkPrint = bulk.json.id ? await call('GET', `/invoices/${bulk.json.id}/print`, A) : { status: 0, json: { html: '' } };
  check('a 120-line bill prints every line', bulkPrint.status === 200 && (bulkPrint.json.html.match(/Bulk line \d+/g) || []).length === 120, `${bulk.status} ${bulkPrint.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(2); });
