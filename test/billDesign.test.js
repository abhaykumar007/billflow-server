const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { amountInWords } = require('../src/utils/words');
const { sanitizeDesign, effectiveDesign, DEFAULT_DESIGN, validateImage, validateUpi, GST_LOCKED } = require('../src/services/billDesign');
const { renderBill, sampleInvoice } = require('../src/services/billRenderer');
const { loadApp, start } = require('./helpers');

const biz = (over = {}) => ({ id: 'b1', name: 'Acme Traders', state: 'Maharashtra', gstin: '27AAAAA0000A1Z5', upi_id: 'acme@okbank', ...over });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('amount in words (Indian system)', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(123456), 'Rupees One Thousand Two Hundred Thirty Four and Fifty Six Paise Only');
  assert.equal(amountInWords(10000000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1500000000), 'Rupees One Crore Fifty Lakh Only');
  assert.equal(amountInWords(250000000000), 'Rupees Two Hundred Fifty Crore Only');
  assert.equal(amountInWords(-5000), 'Rupees Fifty Only');
});

test('design: unknown keys dropped, bad values fall back to defaults', () => {
  const d = sanitizeDesign({ layout: 'nope', accent: 'red', font: 'comic', paper: 'a3', evil: '<script>', header: { logo_size: 'huge', name: 'yes' }, labels: { title_sale: '  Bill\u0007  ', bogus: 'x' } }, biz({ gstin: null }));
  assert.equal(d.layout, DEFAULT_DESIGN.layout);
  assert.equal(d.accent, DEFAULT_DESIGN.accent);
  assert.equal(d.font, 'sans');
  assert.equal(d.paper, 'a4');
  assert.equal(d.header.logo_size, 'medium');
  assert.equal(d.header.name, true);
  assert.equal(d.labels.title_sale, 'Bill');
  assert.equal('evil' in d, false);
  assert.equal('bogus' in d.labels, false);
});

test('design: valid choices are kept, accent is lower-cased', () => {
  const d = sanitizeDesign({ layout: 'modern', accent: '#AA00FF', font: 'serif', paper: 't80', columns: { hsn: true, discount: false }, extras: { upi_qr: true, footer_text: 'Thanks' } }, biz({ gstin: null }));
  assert.equal(d.layout, 'modern'); assert.equal(d.accent, '#aa00ff'); assert.equal(d.font, 'serif'); assert.equal(d.paper, 't80');
  assert.equal(d.columns.hsn, true); assert.equal(d.columns.discount, false);
  assert.equal(d.extras.upi_qr, true); assert.equal(d.extras.footer_text, 'Thanks');
});

test('design: GST-registered business cannot hide required fields; others can', () => {
  const off = { header: { name: false, address: false, gstin: false }, party: { gstin: false }, columns: { tax_rate: false }, totals: { tax_breakup: false } };
  const locked = sanitizeDesign(off, biz());
  assert.equal(locked.header.name, true); assert.equal(locked.header.address, true); assert.equal(locked.header.gstin, true);
  assert.equal(locked.party.gstin, true); assert.equal(locked.columns.tax_rate, true); assert.equal(locked.totals.tax_breakup, true);
  assert.equal(GST_LOCKED.length, 6);
  const free = sanitizeDesign(off, biz({ gstin: null }));
  assert.equal(free.header.gstin, false); assert.equal(free.columns.tax_rate, false); assert.equal(free.totals.tax_breakup, false);
});

test('design: footer and labels are length limited', () => {
  const d = sanitizeDesign({ extras: { footer_text: 'x'.repeat(500), signatory_text: 'y'.repeat(500) }, labels: { bill_to: 'z'.repeat(200) } }, biz());
  assert.equal(d.extras.footer_text.length, 200); assert.equal(d.extras.signatory_text.length, 60); assert.equal(d.labels.bill_to.length, 40);
});

test('images and UPI ids are validated', () => {
  assert.equal(validateImage(PNG), true);
  assert.equal(validateImage('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(validateImage('data:image/png;base64,AAAA" onerror="x'), false);
  assert.equal(validateImage('https://x.test/a.png'), false);
  assert.equal(validateImage(`data:image/png;base64,${'A'.repeat(400001)}`), false);
  assert.equal(validateUpi('shop@okbank'), true);
  assert.equal(validateUpi('a b@okbank'), false);
  assert.equal(validateUpi('shop@ok bank'), false);
  assert.equal(validateUpi('upi://pay?x=1'), false);
});

test('render: user text is escaped everywhere', async () => {
  const inv = sampleInvoice(biz());
  inv.items[0].description = '<img src=x onerror=alert(1)>';
  inv.notes = '<script>alert(1)</script>';
  inv.customer.name = '"><svg onload=alert(2)>';
  const html = await renderBill({ invoice: inv, business: biz({ name: '<b>Evil</b>' }), design: { extras: { footer_text: '<script>x</script>', signatory_text: '</div><i>' } } });
  assert.equal(/<script/i.test(html), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<svg onload'), false);
  assert.equal(html.includes('<b>Evil'), false);
  assert.ok(html.includes('&lt;b&gt;Evil'));
});

test('render: logo/signature only from valid images; svg and tricks are ignored', async () => {
  const inv = sampleInvoice(biz());
  const ok = await renderBill({ invoice: inv, business: biz({ logo_data: PNG, signature_data: PNG }) });
  assert.ok(ok.includes(PNG));
  const bad = await renderBill({ invoice: inv, business: biz({ logo_data: 'data:image/svg+xml;base64,PHN2Zz4=', signature_data: 'javascript:alert(1)', logo_url: 'javascript:alert(1)' }) });
  assert.equal(bad.includes('svg+xml'), false);
  assert.equal(bad.includes('javascript:'), false);
});

test('render: columns, labels, title and layout follow the design', async () => {
  const inv = sampleInvoice(biz());
  const html = await renderBill({ invoice: inv, business: biz({ gstin: null }), design: { layout: 'modern', accent: '#aa00ff', columns: { hsn: true, discount: false, unit: false, serial: false }, labels: { title_sale: 'Cash Memo', col_hsn: 'HSN Code' } } });
  assert.ok(html.includes('Cash Memo'));
  assert.ok(html.includes('HSN Code'));
  assert.ok(html.includes('8471'));
  assert.equal(html.includes('>Disc%<'), false);
  assert.equal(html.includes('>Unit<'), false);
  assert.ok(html.includes('#aa00ff'));
});

test('render: tax split is CGST+SGST within the state and IGST across states', async () => {
  const intra = await renderBill({ invoice: sampleInvoice(biz()), business: biz() });
  assert.ok(intra.includes('CGST (9%)') && intra.includes('SGST (9%)') && !intra.includes('IGST'));
  const inv = sampleInvoice(biz()); inv.customer.state = 'Karnataka';
  const inter = await renderBill({ invoice: inv, business: biz() });
  assert.ok(inter.includes('IGST (18%)') && inter.includes('IGST (12%)') && !inter.includes('CGST'));
});

test('render: amount in words, balance and paid stamp', async () => {
  const inv = sampleInvoice(biz());
  const html = await renderBill({ invoice: inv, business: biz() });
  assert.ok(html.includes('Amount in words'));
  assert.ok(html.includes('Balance Due'));
  assert.equal(html.includes('class="stamp"'), false);
  inv.status = 'paid'; inv.amount_paid = inv.total_amount; inv.balance_due = 0;
  assert.ok((await renderBill({ invoice: inv, business: biz() })).includes('class="stamp"'));
  assert.equal((await renderBill({ invoice: inv, business: biz(), design: { extras: { paid_stamp: false } } })).includes('class="stamp"'), false);
});

test('render: UPI QR only for unpaid sales with a valid UPI id and the option on', async () => {
  const inv = sampleInvoice(biz());
  const on = { extras: { upi_qr: true } };
  const withQr = await renderBill({ invoice: inv, business: biz(), design: on });
  assert.ok(withQr.includes('<svg') && withQr.includes('Scan to pay'));
  assert.equal((await renderBill({ invoice: inv, business: biz() })).includes('Scan to pay'), false);
  assert.equal((await renderBill({ invoice: inv, business: biz({ upi_id: 'not valid' }), design: on })).includes('Scan to pay'), false);
  assert.equal((await renderBill({ invoice: inv, business: biz({ upi_id: null }), design: on })).includes('Scan to pay'), false);
  inv.balance_due = 0; inv.status = 'paid';
  assert.equal((await renderBill({ invoice: inv, business: biz(), design: on })).includes('Scan to pay'), false);
  const pur = sampleInvoice(biz()); pur.voucher_type = 'PURCHASE';
  assert.equal((await renderBill({ invoice: pur, business: biz(), design: on })).includes('Scan to pay'), false);
});

test('render: bank block only on sales and estimates, and only when chosen', async () => {
  const bank = { account_name: 'Acme', bank_name: 'HDFC', account_number: '1234567890', ifsc_code: 'HDFC0001234' };
  const inv = sampleInvoice(biz());
  const shown = await renderBill({ invoice: inv, business: biz(), design: { extras: { bank: true } }, bank });
  assert.ok(shown.includes('HDFC0001234') && shown.includes('1234567890'));
  assert.equal((await renderBill({ invoice: inv, business: biz(), design: {}, bank })).includes('HDFC0001234'), false);
  const pur = sampleInvoice(biz()); pur.voucher_type = 'PURCHASE';
  assert.equal((await renderBill({ invoice: pur, business: biz(), design: { extras: { bank: true } }, bank })).includes('HDFC0001234'), false);
});

test('render: all paper sizes produce a page; thermal is a narrow single column', async () => {
  const inv = sampleInvoice(biz());
  for (const paper of ['a4', 'a5', 't80', 't58']) {
    const html = await renderBill({ invoice: inv, business: biz(), paper });
    assert.ok(html.startsWith('<!doctype html>'), paper);
    assert.ok(html.includes('Acme Traders'), paper);
    assert.ok(html.includes('INV-2627-0001'), paper);
  }
  const t = await renderBill({ invoice: inv, business: biz(), paper: 't58' });
  assert.ok(t.includes('size:58mm auto') && t.includes('48mm'));
  assert.equal(t.includes('<table class="items">'), false);
});

test('render: a long bill keeps every row and repeats the header across pages', async () => {
  const inv = sampleInvoice(biz());
  inv.items = Array.from({ length: 150 }, (_, i) => ({ ...inv.items[0], id: `i${i}`, description: `Item number ${i + 1}` }));
  const html = await renderBill({ invoice: inv, business: biz() });
  assert.equal((html.match(/Item number \d+/g) || []).length, 150);
  assert.ok(html.includes('table-header-group'));
});

test('render: estimates and returns get their own titles; returns show the linked invoice', async () => {
  const inv = sampleInvoice(biz()); inv.voucher_type = 'ESTIMATE'; inv.valid_until = new Date();
  assert.ok((await renderBill({ invoice: inv, business: biz() })).includes('Estimate'));
  const ret = sampleInvoice(biz()); ret.voucher_type = 'SALE_RETURN'; ret.linked_invoice = { invoice_number: 'INV-1', invoice_date: new Date() };
  const html = await renderBill({ invoice: ret, business: biz() });
  assert.ok(html.includes('Credit Note') && html.includes('Against: INV-1'));
});

// ── routes ────────────────────────────────────────────────────────────────────
const token = (role = 'owner') => jwt.sign({ userId: 'u1', businessId: 'b1', role }, process.env.JWT_SECRET, { expiresIn: '5m' });
const hdr = (role) => ({ authorization: `Bearer ${token(role)}`, 'content-type': 'application/json' });
async function withApp(overrides, fn) {
  const srv = await start(loadApp(overrides));
  try { await fn(srv.base); } finally { await srv.close(); }
}

test('routes: need a sign-in; staff cannot change the design or assets', async () => {
  const state = { business: biz({ bill_design: null }) };
  const stub = { business: { findUnique: async () => state.business, update: async ({ data }) => Object.assign(state.business, data) }, bankAccount: { findMany: async () => [] } };
  await withApp(stub, async (base) => {
    assert.equal((await fetch(`${base}/api/bill-design`)).status, 401);
    assert.equal((await fetch(`${base}/api/bill-design`, { method: 'PUT', headers: hdr('staff'), body: JSON.stringify({ design: {} }) })).status, 403);
    assert.equal((await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr('staff'), body: JSON.stringify({ upi_id: 'a@b' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/bill-design`, { headers: hdr('staff') })).status, 200);
  });
});

test('routes: save is cleaned, assets validated, preview returns a page', async () => {
  const state = { business: biz({ bill_design: null, logo_data: null }) };
  const stub = { business: { findUnique: async () => state.business, update: async ({ data }) => Object.assign(state.business, data) }, bankAccount: { findMany: async () => [], findFirst: async () => null } };
  await withApp(stub, async (base) => {
    let r = await fetch(`${base}/api/bill-design`, { method: 'PUT', headers: hdr(), body: JSON.stringify({ design: { layout: 'compact', accent: 'javascript:1', header: { name: false } } }) });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.design.layout, 'compact'); assert.equal(saved.design.accent, '#1e3a8a'); assert.equal(saved.design.header.name, true);
    assert.deepEqual(saved.locked, GST_LOCKED);
    assert.deepEqual(state.business.bill_design.labels, {}); // standard wording is not stored
    assert.equal(saved.design.labels.col_rate, 'Rate (₹)'); // but is still returned
    assert.equal((await fetch(`${base}/api/bill-design`, { method: 'PUT', headers: hdr(), body: JSON.stringify({}) })).status, 400);
    assert.equal((await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr(), body: JSON.stringify({ logo_data: 'data:image/svg+xml;base64,PHN2Zz4=' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr(), body: JSON.stringify({ upi_id: 'bad id' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr(), body: JSON.stringify({}) })).status, 400);
    r = await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr(), body: JSON.stringify({ logo_data: PNG, upi_id: 'shop@okbank' }) });
    assert.equal(r.status, 200);
    assert.equal(state.business.logo_data, PNG);
    r = await fetch(`${base}/api/bill-design/preview`, { method: 'POST', headers: hdr(), body: JSON.stringify({ design: { layout: 'modern', extras: { upi_qr: true } }, paper: 'a5' }) });
    const p = await r.json();
    assert.equal(r.status, 200); assert.ok(p.html.includes('Acme Traders') && p.html.includes('Scan to pay')); assert.equal(p.paper, 'a5');
    r = await fetch(`${base}/api/bill-design/assets`, { method: 'PUT', headers: hdr(), body: JSON.stringify({ logo_data: null }) });
    assert.equal(state.business.logo_data, null);
  });
});

test('routes: print is scoped to the business and honours the saved design', async () => {
  const inv = sampleInvoice(biz()); inv.id = 'inv1';
  let askedBusiness = null;
  const stub = {
    invoice: { findFirst: async ({ where }) => { askedBusiness = where.business_id; return where.id === 'inv1' ? inv : null; } },
    business: { findUnique: async () => biz({ bill_design: { layout: 'compact', labels: { title_sale: 'Cash Memo' } } }) },
    bankAccount: { findFirst: async () => null },
  };
  await withApp(stub, async (base) => {
    assert.equal((await fetch(`${base}/api/invoices/inv1/print`)).status, 401);
    const r = await fetch(`${base}/api/invoices/inv1/print?paper=t80`, { headers: hdr() });
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(askedBusiness, 'b1'); assert.equal(j.paper, 't80'); assert.ok(j.html.includes('Cash Memo'));
    const bad = await fetch(`${base}/api/invoices/inv1/print?paper=poster`, { headers: hdr() });
    assert.equal((await bad.json()).paper, 'a4');
    assert.equal((await fetch(`${base}/api/invoices/other/print`, { headers: hdr() })).status, 404);
  });
});

test('effectiveDesign: nothing saved gives the defaults', () => {
  const d = effectiveDesign(null, biz({ gstin: null }));
  assert.deepEqual(d, JSON.parse(JSON.stringify(DEFAULT_DESIGN)));
});

test('routes: paper=thermal uses the business thermal width, else 80 mm', async () => {
  const inv = sampleInvoice(biz()); inv.id = 'inv1';
  for (const [saved, expected] of [['t58', 't58'], ['a4', 't80'], ['t80', 't80']]) {
    const stub = { invoice: { findFirst: async () => inv }, business: { findUnique: async () => biz({ bill_design: { paper: saved } }) }, bankAccount: { findFirst: async () => null } };
    await withApp(stub, async (base) => {
      const j = await (await fetch(`${base}/api/invoices/inv1/print?paper=thermal`, { headers: hdr() })).json();
      assert.equal(j.paper, expected, saved);
    });
  }
});
