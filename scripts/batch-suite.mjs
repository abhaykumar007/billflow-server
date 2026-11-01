// Break-it checks for batches, MRP, expiry and GST-inclusive bills. Registers throwaway accounts on the server it is pointed at.
//   DATABASE_URL=... API=http://localhost:5000 node scripts/batch-suite.mjs   (DATABASE_URL is used to put the test account on the Pro plan)
import { execSync } from 'node:child_process';
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const stamp = Date.now();
let pass = 0; let fail = 0; let n = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); };
const nm = (p) => `${p} ${stamp}-${++n}`;
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const today = () => day(0);

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
async function account(label) {
  const email = `bt.${label}.${stamp}@example.com`;
  const r = await call('POST', '/auth/register', null, { name: `BT ${label}`, email, password: 'Passw0rd!23', business: { name: `BT Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, token: r.json.accessToken };
}
const upgrade = (email) => execSync(`node scripts/upgrade-test-plan.cjs ${email.toLowerCase()}`, { stdio: 'ignore', env: process.env });

const product = (t, extra = {}) => call('POST', '/products', t, { name: nm('Rice'), sale_price: 150, purchase_price: 100, tax_rate: 5, ...extra }).then((r) => r.json);
const customer = (t) => call('POST', '/customers', t, { name: nm('Cust'), state: 'Karnataka' }).then((r) => r.json);
const supplier = (t) => call('POST', '/suppliers', t, { name: nm('Supp'), state: 'Karnataka' }).then((r) => r.json);
const line = (p, quantity, rate, extra = {}) => ({ product_id: p.id, description: p.name, quantity, unit: 'pcs', rate, discount_percent: 0, tax_rate: p.tax_rate ?? 5, ...extra });
const bill = (t, o) => call('POST', '/invoices', t, { voucher_type: 'SALE', status: 'sent', invoice_date: today(), discount_amount: 0, ...o }, { 'Idempotency-Key': `bt-${stamp}-${++n}-${Math.random().toString(36).slice(2)}` });
const stockOf = async (t, id) => (await call('GET', `/products/${id}`, t)).json.stock_quantity;
const batchesOf = async (t, id, all = true) => (await call('GET', `/products/${id}/batches${all ? '?all=1' : ''}`, t)).json.batches;
const sumBatches = (bs) => bs.reduce((s, b) => s + b.quantity, 0);

(async () => {
  const A = await account('a'); const B = await account('b'); const M = await account('med'); const G = await account('gst');
  [A, M, G].forEach((x) => upgrade(x.email));
  const staffEmail = `bt.staff.${stamp}@example.com`;
  const inv = await call('POST', '/settings/users/invite', A.token, { name: 'Staffer', email: staffEmail, password: 'Passw0rd!23', role: 'staff' });
  const staff = (await call('POST', '/auth/login', null, { email: staffEmail, password: 'Passw0rd!23' })).json.accessToken;
  check('setup: owner, staff, other business', inv.status === 201 && !!staff);

  // ── business settings ───────────────────────────────────────────────────────
  let r = await call('GET', '/settings/industry', A.token);
  check('industry defaults: general, GST extra, 90 days', r.status === 200 && r.json.business_type === 'general' && r.json.rates_include_gst === false && r.json.near_expiry_days === 90, JSON.stringify(r.json));
  r = await call('PUT', '/settings/industry', A.token, { business_type: 'medical', drug_license_20: 'KA-B1-20/1234', drug_license_21: 'KA-B1-21/1234', fssai_no: '12345678901234', near_expiry_days: 60 });
  check('owner saves medical type, licences, FSSAI, near-expiry days', r.status === 200 && r.json.business_type === 'medical' && r.json.fssai_no === '12345678901234' && r.json.near_expiry_days === 60, JSON.stringify(r.json));
  for (const [label, body] of [['bad type', { business_type: 'pharma' }], ['FSSAI 13 digits', { fssai_no: '1234567890123' }], ['near-expiry 0', { near_expiry_days: 0 }], ['near-expiry 9999', { near_expiry_days: 9999 }]]) {
    check(`industry refused: ${label}`, (await call('PUT', '/settings/industry', A.token, body)).status === 400);
  }
  check('staff cannot change industry settings (403)', (await call('PUT', '/settings/industry', staff, { business_type: 'fmcg' })).status === 403);
  check('staff can read industry settings', (await call('GET', '/settings/industry', staff)).status === 200);
  await call('PUT', '/settings/industry', A.token, { business_type: 'general' }); // later tests: expiry optional unless a test sets medical

  // ── item fields and the batch switch ───────────────────────────────────────
  const p1 = await product(A.token, { mrp: 120, pack_size: '10x10', schedule: 'h', manufacturer: 'Acme', composition: 'Paracetamol 500mg' });
  check('item keeps MRP, pack, schedule (uppercased), maker, composition', p1.mrp === 12000 && p1.pack_size === '10x10' && p1.schedule === 'H' && p1.manufacturer === 'Acme' && p1.composition === 'Paracetamol 500mg', JSON.stringify(p1));
  check('bad schedule refused', (await call('POST', '/products', A.token, { name: nm('X'), schedule: 'Z' })).status === 400);
  check('negative MRP refused', (await call('POST', '/products', A.token, { name: nm('X'), mrp: -5 })).status === 400);
  const p2 = await product(A.token, { track_inventory: true, stock_quantity: 10, sale_price: 150, purchase_price: 100 });
  r = await call('PUT', `/products/${p2.id}`, A.token, { track_batches: true });
  let bs = await batchesOf(A.token, p2.id);
  check('switching batches on makes an "Opening stock" batch from current stock', r.status === 200 && r.json.track_batches === true && bs.length === 1 && bs[0].is_opening && bs[0].quantity === 10 && bs[0].batch_no === 'OPENING' && bs[0].mrp === 15000 && bs[0].purchase_price === 10000, JSON.stringify(bs));
  check('batches cannot be switched off again', (await call('PUT', `/products/${p2.id}`, A.token, { track_batches: false })).status === 400);
  const p3 = await product(A.token, { track_batches: true, stock_quantity: 7 });
  bs = await batchesOf(A.token, p3.id);
  check('batch item made with stock gets its opening batch, and stock tracking is forced on', p3.track_inventory === true && bs.length === 1 && bs[0].quantity === 7 && (await stockOf(A.token, p3.id)) === 7, JSON.stringify(p3));
  const p0 = await product(A.token, { track_batches: true });
  check('batch item made without stock has no batch yet', (await batchesOf(A.token, p0.id)).length === 0);

  // ── adding stock as batches ─────────────────────────────────────────────────
  const rice = await product(A.token, { track_batches: true, tax_rate: 5, mrp: 120, sale_price: 110, purchase_price: 90 });
  r = await call('POST', `/products/${rice.id}/batches`, A.token, { batch_no: 'r-100', expiry_date: day(200), mrp: 10000, purchase_price: 8000, sale_price: 9500, quantity: 20 });
  const b100 = r.json;
  check('add batch: number uppercased, expiry and prices kept, stock total moves', r.status === 201 && b100.batch_no === 'R-100' && b100.quantity === 20 && b100.sale_price === 9500 && b100.days_to_expiry === 200 && (await stockOf(A.token, rice.id)) === 20, JSON.stringify(r.json));
  r = await call('POST', `/products/${rice.id}/batches`, A.token, { batch_no: 'R-120', expiry_date: day(100), mrp: 12000, purchase_price: 9500, quantity: 5 });
  const b120 = r.json;
  check('same item, other MRP and cost = a second batch (100 and 120)', r.status === 201 && b120.id !== b100.id && (await stockOf(A.token, rice.id)) === 25);
  r = await call('POST', `/products/${rice.id}/batches`, A.token, { batch_no: 'R-100', expiry_date: day(200), mrp: 10000, purchase_price: 8000, quantity: 10 });
  check('same batch number + MRP + cost tops up the same batch', r.status === 201 && r.json.id === b100.id && r.json.quantity === 30 && (await batchesOf(A.token, rice.id)).length === 2);
  r = await call('POST', `/products/${rice.id}/batches`, A.token, { batch_no: 'R-100', expiry_date: day(300), mrp: 10000, purchase_price: 8000, quantity: 1 });
  check('same batch with a different expiry is refused (typo guard)', r.status === 409 && r.json.code === 'BATCH_EXPIRY_MISMATCH', JSON.stringify(r.json));
  bs = await batchesOf(A.token, rice.id);
  check('batches listed earliest expiry first, with days left and expired flag', bs.length === 2 && bs[0].batch_no === 'R-120' && bs[0].days_to_expiry === 100 && bs[0].expired === false, JSON.stringify(bs.map((b) => [b.batch_no, b.days_to_expiry])));
  const bNoExp = (await call('POST', `/products/${rice.id}/batches`, A.token, { batch_no: 'NOEXP', mrp: 10000, purchase_price: 7000, quantity: 3 })).json;
  bs = await batchesOf(A.token, rice.id);
  check('a batch without expiry sorts last', bs[bs.length - 1].batch_no === 'NOEXP' && bNoExp.expiry_date === null);
  for (const [label, body] of [['no batch number', { quantity: 1 }], ['bad batch number', { batch_no: '<x>', quantity: 1 }], ['zero quantity', { batch_no: 'Z1', quantity: 0 }], ['negative quantity', { batch_no: 'Z1', quantity: -2 }], ['bad expiry', { batch_no: 'Z1', quantity: 1, expiry_date: '2027-13-40' }], ['made after expiry', { batch_no: 'Z1', quantity: 1, expiry_date: day(10), mfg_date: day(20) }], ['negative MRP', { batch_no: 'Z1', quantity: 1, mrp: -1 }]]) {
    check(`add batch refused: ${label}`, (await call('POST', `/products/${rice.id}/batches`, A.token, body)).status === 400);
  }
  const plain = await product(A.token);
  check('add batch to an item without batch tracking is refused', (await call('POST', `/products/${plain.id}/batches`, A.token, { batch_no: 'Q1', quantity: 1 })).status === 400);
  check('staff cannot add stock batches (403)', (await call('POST', `/products/${rice.id}/batches`, staff, { batch_no: 'S1', quantity: 1 })).status === 403);
  check('another business cannot see or add batches (404)', (await call('GET', `/products/${rice.id}/batches`, B.token)).status === 404 && (await call('POST', `/products/${rice.id}/batches`, B.token, { batch_no: 'S1', quantity: 1 })).status === 404);
  check('another business cannot edit or adjust a batch (404)', (await call('PUT', `/batches/${b100.id}`, B.token, { sale_price: 1 })).status === 404 && (await call('POST', `/batches/${b100.id}/adjust`, B.token, { quantity_delta: -1, reason: 'x' })).status === 404);

  // ── edit and adjust ─────────────────────────────────────────────────────────
  r = await call('PUT', `/batches/${bNoExp.id}`, A.token, { expiry_date: day(400), sale_price: 8800 });
  check('edit a batch: expiry and selling price', r.status === 200 && r.json.sale_price === 8800 && r.json.days_to_expiry === 400);
  check('edit refused: manufacturing date after expiry', (await call('PUT', `/batches/${bNoExp.id}`, A.token, { mfg_date: day(500) })).status === 400);
  const before = await stockOf(A.token, rice.id);
  r = await call('POST', `/batches/${bNoExp.id}/adjust`, A.token, { quantity_delta: -2, reason: 'damaged' });
  check('adjust with a reason moves batch and item stock together', r.status === 200 && r.json.quantity === 1 && (await stockOf(A.token, rice.id)) === before - 2);
  check('adjust without a reason refused', (await call('POST', `/batches/${bNoExp.id}/adjust`, A.token, { quantity_delta: -1 })).status === 400);
  check('adjust by zero refused', (await call('POST', `/batches/${bNoExp.id}/adjust`, A.token, { quantity_delta: 0, reason: 'x' })).status === 400);
  check('staff cannot adjust (403)', (await call('POST', `/batches/${bNoExp.id}/adjust`, staff, { quantity_delta: -1, reason: 'x' })).status === 403);

  // ── purchase bills create batches ───────────────────────────────────────────
  const sup = await supplier(A.token); const cu = await customer(A.token);
  const ricePurchase = await product(A.token, { track_batches: true, tax_rate: 0, mrp: 150 });
  const draft = await bill(A.token, { voucher_type: 'PURCHASE', status: 'draft', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 10, 8000, { tax_rate: 0, batch_no: 'p-a', expiry_date: day(300), mrp: 10000 })] });
  check('a purchase draft does not create a batch yet', draft.status === 201 && (await batchesOf(A.token, ricePurchase.id)).length === 0);
  r = await call('POST', `/invoices/${draft.json.id}/send`, A.token);
  bs = await batchesOf(A.token, ricePurchase.id);
  check('sending the purchase creates its batch (qty, cost, MRP, supplier) and links the line', r.status === 200 && bs.length === 1 && bs[0].batch_no === 'P-A' && bs[0].quantity === 10 && bs[0].purchase_price === 8000 && bs[0].mrp === 10000 && bs[0].supplier_id === sup.id && (await stockOf(A.token, ricePurchase.id)) === 10);
  const two = await bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 10, 8000, { tax_rate: 0, batch_no: 'P-A', expiry_date: day(300), mrp: 10000 }), line(ricePurchase, 4, 9600, { tax_rate: 0, batch_no: 'P-B', expiry_date: day(250), mrp: 12000, free_qty: 1, batch_sale_price: 11500 })] });
  bs = await batchesOf(A.token, ricePurchase.id);
  const pa = bs.find((b) => b.batch_no === 'P-A'); const pb = bs.find((b) => b.batch_no === 'P-B');
  check('same rice from the same vendor at two MRPs: two batches, matching one topped up', two.status === 201 && bs.length === 2 && pa.quantity === 20 && pb.quantity === 5 && pb.sale_price === 11500, JSON.stringify(bs.map((b) => [b.batch_no, b.quantity])));
  check('free pieces count in stock and lower the cost per piece (4 x 96.00 + 1 free = 76.80 each)', pb.purchase_price === 7680 && (await stockOf(A.token, ricePurchase.id)) === 25, `cost ${pb.purchase_price}`);
  check('billed amount ignores the free pieces', two.json.subtotal === 10 * 8000 + 4 * 9600, `subtotal ${two.json.subtotal}`);
  check('purchase without a batch number refused (BATCH_REQUIRED)', (await bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 1, 100, { tax_rate: 0 })] })).json.code === 'BATCH_REQUIRED');
  check('purchase with a bad batch number refused', (await bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 1, 100, { tax_rate: 0, batch_no: '<b>' })] })).status === 400);
  check('purchase with an impossible expiry date refused', (await bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 1, 100, { tax_rate: 0, batch_no: 'X1', expiry_date: '2027-02-31' })] })).status === 400);
  const clash = await bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 1, 8000, { tax_rate: 0, batch_no: 'P-A', expiry_date: day(999), mrp: 10000 })] });
  check('purchase reusing a batch with another expiry refused (typo guard); nothing half-saved', clash.status === 409 && clash.json.code === 'BATCH_EXPIRY_MISMATCH' && (await stockOf(A.token, ricePurchase.id)) === 25, JSON.stringify(clash.json));

  // medical businesses must give an expiry
  await call('PUT', '/settings/industry', M.token, { business_type: 'medical' });
  const mp = await product(M.token, { track_batches: true }); const msup = await supplier(M.token);
  r = await bill(M.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: msup.id, items: [line(mp, 5, 5000, { batch_no: 'M-1' })] });
  check('medical business: purchase without expiry refused (EXPIRY_REQUIRED)', r.status === 400 && r.json.code === 'EXPIRY_REQUIRED', JSON.stringify(r.json));
  r = await bill(M.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: msup.id, items: [line(mp, 5, 5000, { batch_no: 'M-1', expiry_date: day(400) })] });
  check('medical business: purchase with expiry accepted', r.status === 201);

  // ── sales take from the chosen batch ────────────────────────────────────────
  const sale = await bill(A.token, { customer_id: cu.id, items: [line(rice, 6, 11000, { tax_rate: 5, batch_id: b120.id })] });
  bs = await batchesOf(A.token, rice.id); const after120 = bs.find((b) => b.id === b120.id);
  const sl = sale.json.items?.[0];
  check('sale from a chosen batch: that batch goes down, item total follows, nothing else changes', sale.status === 201 && after120.quantity === -1 && bs.find((b) => b.id === b100.id).quantity === 30 && sumBatches(bs) === (await stockOf(A.token, rice.id)), JSON.stringify(bs.map((b) => [b.batch_no, b.quantity])));
  check('oversold batch is allowed but warned, naming the batch', (sale.json.stock_warnings || []).some((w) => w.batch_no === 'R-120' && w.batch === true), JSON.stringify(sale.json.stock_warnings));
  check('bill line remembers batch number, expiry, MRP and cost at sale time', sl && sl.batch_no === 'R-120' && sl.mrp === 12000 && sl.cost_price === 9500 && sl.expiry_date?.slice(0, 10) === day(100), JSON.stringify(sl));
  check('sale of a batch item without choosing a batch refused (BATCH_REQUIRED)', (await bill(A.token, { customer_id: cu.id, items: [line(rice, 1, 11000)] })).json.code === 'BATCH_REQUIRED');
  const other = await product(A.token, { track_batches: true }); const otherBatch = (await call('POST', `/products/${other.id}/batches`, A.token, { batch_no: 'O1', quantity: 5, expiry_date: day(100) })).json;
  check('a batch of another item cannot be used (400)', (await bill(A.token, { customer_id: cu.id, items: [line(rice, 1, 11000, { batch_id: otherBatch.id })] })).status === 400);
  check('a batch id that does not exist is refused', (await bill(A.token, { customer_id: cu.id, items: [line(rice, 1, 11000, { batch_id: 'nope' })] })).status === 400);
  const fr = await bill(A.token, { customer_id: cu.id, items: [line(rice, 2, 11000, { batch_id: b100.id, free_qty: 1 })] });
  check('free pieces on a sale also leave the batch (2 sold + 1 free = 3)', fr.status === 201 && (await batchesOf(A.token, rice.id)).find((b) => b.id === b100.id).quantity === 27 && fr.json.subtotal === 22000);
  const tax = await bill(A.token, { customer_id: cu.id, items: [line(plain, 3, 1000, { batch_id: b100.id, batch_no: 'FAKE', expiry_date: '2020-01-01' })] });
  check('batch details on a non-batch item are ignored (and it sells normally)', tax.status === 201 && tax.json.items[0].batch_id === null && tax.json.items[0].batch_no === null && tax.json.items[0].expiry_date === null);
  check('estimate may name a batch or none; it moves no stock', (await bill(A.token, { voucher_type: 'ESTIMATE', status: 'draft', customer_id: cu.id, items: [line(rice, 1, 11000)] })).status === 201 && (await batchesOf(A.token, rice.id)).find((b) => b.id === b100.id).quantity === 27);

  // ── returns and cancels go back to the same batch ───────────────────────────
  const sret = await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cu.id, linked_invoice_id: sale.json.id, items: [line(rice, 2, 11000, { batch_id: b120.id })] });
  check('sale return puts stock back into the named batch', sret.status === 201 && (await batchesOf(A.token, rice.id)).find((b) => b.id === b120.id).quantity === 1);
  check('sale return without a batch refused', (await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cu.id, linked_invoice_id: sale.json.id, items: [line(rice, 1, 11000)] })).json.code === 'BATCH_REQUIRED');
  const cancelSale = await call('DELETE', `/invoices/${fr.json.id}`, A.token);
  check('cancelling a sale restores its batch', cancelSale.status === 200 && (await batchesOf(A.token, rice.id)).find((b) => b.id === b100.id).quantity === 30, JSON.stringify(cancelSale.json).slice(0, 120));
  const cancelPurchase = await call('DELETE', `/invoices/${two.json.id}`, A.token);
  bs = await batchesOf(A.token, ricePurchase.id);
  check('cancelling a purchase removes what it brought into its batches', cancelPurchase.status === 200 && bs.find((b) => b.batch_no === 'P-A').quantity === 10 && bs.find((b) => b.batch_no === 'P-B').quantity === 0 && (await stockOf(A.token, ricePurchase.id)) === 10, JSON.stringify(bs.map((b) => [b.batch_no, b.quantity])));
  const pret = await bill(A.token, { voucher_type: 'PURCHASE_RETURN', customer_id: undefined, supplier_id: sup.id, items: [line(ricePurchase, 2, 8000, { tax_rate: 0, batch_id: pa.id })] });
  check('purchase return takes stock out of the named batch', pret.status === 201 && (await batchesOf(A.token, ricePurchase.id)).find((b) => b.batch_no === 'P-A').quantity === 8);

  // ── expired batches ─────────────────────────────────────────────────────────
  const med = await product(A.token, { track_batches: true });
  const dead = (await call('POST', `/products/${med.id}/batches`, A.token, { batch_no: 'OLD', expiry_date: day(-1), mrp: 5000, purchase_price: 3000, quantity: 10 })).json;
  const lastDay = (await call('POST', `/products/${med.id}/batches`, A.token, { batch_no: 'LAST', expiry_date: today(), mrp: 5000, purchase_price: 3000, quantity: 10 })).json;
  check('expired batch is flagged in the list', (await batchesOf(A.token, med.id)).find((b) => b.id === dead.id).expired === true && (await batchesOf(A.token, med.id)).find((b) => b.id === lastDay.id).expired === false);
  r = await bill(staff, { customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: dead.id })] });
  check('staff cannot sell an expired batch (EXPIRED_BATCH, nothing taken)', r.status === 422 && r.json.code === 'EXPIRED_BATCH' && (await batchesOf(A.token, med.id)).find((b) => b.id === dead.id).quantity === 10, JSON.stringify(r.json));
  r = await bill(staff, { customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: dead.id, expired_override_reason: 'staff tries to override' })] });
  check('staff cannot override by sending a reason', r.status === 422 && r.json.code === 'EXPIRED_BATCH');
  r = await bill(A.token, { customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: dead.id })] });
  check('owner without a reason is asked for one (EXPIRED_BATCH_REASON_REQUIRED)', r.status === 422 && r.json.code === 'EXPIRED_BATCH_REASON_REQUIRED');
  r = await bill(A.token, { customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: dead.id, expired_override_reason: 'customer asked, labelled sample' })] });
  check('owner with a reason can sell it; the reason is kept on the line', r.status === 201 && r.json.items[0].expired_override_reason === 'customer asked, labelled sample');
  check('a batch expiring today can still be sold', (await bill(A.token, { customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: lastDay.id })] })).status === 201);
  check('a reason on a batch that has not expired is dropped', (await bill(A.token, { customer_id: cu.id, items: [line(rice, 1, 11000, { batch_id: b100.id, expired_override_reason: 'not needed' })] })).json.items?.[0]?.expired_override_reason === null);
  const dd = (await call('POST', `/products/${med.id}/batches`, A.token, { batch_no: 'SOON', expiry_date: day(30), mrp: 5000, purchase_price: 3000, quantity: 5 })).json;
  const aging = await bill(staff, { status: 'draft', customer_id: cu.id, items: [line(med, 1, 5000, { batch_id: dd.id })] });
  await call('PUT', `/batches/${dd.id}`, A.token, { expiry_date: day(-2) });
  r = await call('POST', `/invoices/${aging.json.id}/send`, A.token);
  check('a draft made before the batch expired cannot be sent after it did (EXPIRED_BATCH)', aging.status === 201 && r.status === 422 && r.json.code === 'EXPIRED_BATCH' && (await batchesOf(A.token, med.id)).find((b) => b.id === dd.id).quantity === 5, JSON.stringify(r.json));
  const listExp = (await call('GET', '/batches?expired=1', A.token)).json;
  check('batch list can show expired stock only', listExp.batches.length >= 2 && listExp.batches.every((b) => b.expired));
  const soon = (await call('GET', '/batches?expiring_within=60', A.token)).json;
  check('batch list can show what expires within N days', soon.batches.every((b) => !b.expired && b.days_to_expiry <= 60) && soon.batches.some((b) => b.id === lastDay.id));

  // ── invariants and races ────────────────────────────────────────────────────
  for (const prod of [rice, ricePurchase, med, p2, p3]) {
    const total = await stockOf(A.token, prod.id); const sum = sumBatches(await batchesOf(A.token, prod.id));
    check(`stock total = sum of batches (${prod.name.slice(0, 12)}…)`, Math.abs(total - sum) < 1e-9, `total ${total} vs batches ${sum}`);
  }
  const race = await product(A.token, { track_batches: true }); const rb = (await call('POST', `/products/${race.id}/batches`, A.token, { batch_no: 'RACE', expiry_date: day(100), quantity: 10, mrp: 2000, purchase_price: 1000 })).json;
  const results = await Promise.all(Array.from({ length: 10 }, () => bill(A.token, { customer_id: cu.id, items: [line(race, 1, 2000, { batch_id: rb.id })] })));
  check('10 sales at the same moment from a batch of 10: all saved, batch 0, item 0 (no lost update)', results.every((x) => x.status === 201) && (await batchesOf(A.token, race.id, true))[0].quantity === 0 && (await stockOf(A.token, race.id)) === 0);
  const pr = await product(A.token, { track_batches: true }); const prSup = await supplier(A.token);
  const buys = await Promise.all(Array.from({ length: 6 }, () => bill(A.token, { voucher_type: 'PURCHASE', customer_id: undefined, supplier_id: prSup.id, items: [line(pr, 2, 500, { tax_rate: 0, batch_no: 'SAME', expiry_date: day(200), mrp: 700 })] })));
  bs = await batchesOf(A.token, pr.id);
  check('6 purchases of the same new batch at the same moment: one batch, 12 in it', buys.every((x) => x.status === 201) && bs.length === 1 && bs[0].quantity === 12, JSON.stringify(bs.map((b) => [b.batch_no, b.quantity])) + buys.map((x) => x.status));

  // ── MRP warning ─────────────────────────────────────────────────────────────
  const mrpP = await product(A.token, { track_batches: true, tax_rate: 12 }); const mb = (await call('POST', `/products/${mrpP.id}/batches`, A.token, { batch_no: 'MRP1', expiry_date: day(100), quantity: 50, mrp: 10000, purchase_price: 6000 })).json;
  r = await bill(A.token, { customer_id: cu.id, items: [line(mrpP, 1, 9500, { tax_rate: 12, batch_id: mb.id })] });
  check('price + GST above MRP gives an MRP warning (95.00 + 12% = 106.40 > 100.00)', r.status === 201 && r.json.mrp_warnings?.length === 1 && r.json.mrp_warnings[0].mrp === 10000, JSON.stringify(r.json.mrp_warnings));
  r = await bill(A.token, { customer_id: cu.id, items: [line(mrpP, 1, 8900, { tax_rate: 12, batch_id: mb.id })] });
  check('price + GST within MRP gives no warning (89.00 + 12% = 99.68)', r.status === 201 && !r.json.mrp_warnings);

  // ── GST-inclusive bills ─────────────────────────────────────────────────────
  const gp = await product(G.token, { tax_rate: 18 }); const gc = await customer(G.token);
  r = await bill(G.token, { customer_id: gc.id, items: [line(gp, 1, 11800, { tax_rate: 18 })] });
  check('default: rates are GST-extra (118.00 + 18% = 139.24)', r.status === 201 && r.json.total_amount === 13924 && r.json.rates_include_gst === false, JSON.stringify([r.json.total_amount, r.json.rates_include_gst]));
  await call('PUT', '/settings/industry', G.token, { rates_include_gst: true });
  r = await bill(G.token, { customer_id: gc.id, items: [line(gp, 1, 11800, { tax_rate: 18 })] });
  check('rates include GST: 118.00 is 100.00 + 18.00 and the total stays 118.00', r.status === 201 && r.json.subtotal === 10000 && r.json.tax_amount === 1800 && r.json.total_amount === 11800 && r.json.rates_include_gst === true, JSON.stringify([r.json.subtotal, r.json.tax_amount, r.json.total_amount]));
  r = await bill(G.token, { customer_id: gc.id, discount_amount: 1180, items: [line(gp, 1, 11800, { tax_rate: 18 })] });
  check('inclusive discount typed as paid: total 106.20, discount kept as typed, books stay GST-exclusive', r.status === 201 && r.json.total_amount === 10620 && r.json.discount_incl === 1180 && r.json.discount_amount === 1000 && r.json.subtotal - r.json.discount_amount + r.json.tax_amount === r.json.total_amount, JSON.stringify([r.json.total_amount, r.json.discount_incl, r.json.discount_amount]));
  const gd = await bill(G.token, { status: 'draft', customer_id: gc.id, discount_amount: 590, items: [line(gp, 2, 5900, { tax_rate: 18 })] });
  const ge = await call('PUT', `/invoices/${gd.json.id}`, G.token, { customer_id: gc.id, discount_amount: gd.json.discount_incl, items: [line(gp, 2, 5900, { tax_rate: 18 })] });
  check('editing an inclusive draft with its own discount_incl gives the same total (no drift)', gd.status === 201 && ge.status === 200 && ge.json.total_amount === gd.json.total_amount && ge.json.discount_incl === 590, JSON.stringify([gd.json.total_amount, ge.json.total_amount]));
  await call('PUT', '/settings/industry', G.token, { rates_include_gst: false });
  const ge2 = await call('PUT', `/invoices/${gd.json.id}`, G.token, { customer_id: gc.id, discount_amount: gd.json.discount_incl, items: [line(gp, 2, 5900, { tax_rate: 18 })] });
  check('a bill keeps its pricing mode even if the setting is switched off later', ge2.status === 200 && ge2.json.rates_include_gst === true && ge2.json.total_amount === gd.json.total_amount);
  r = await bill(G.token, { customer_id: gc.id, items: [line(gp, 1, 11800, { tax_rate: 18 })] });
  check('after switching off, new bills are GST-extra again', r.json.total_amount === 13924 && r.json.rates_include_gst === false);
  await call('PUT', '/settings/industry', G.token, { rates_include_gst: true });
  check('inclusive: a discount larger than the bill is refused', (await bill(G.token, { customer_id: gc.id, discount_amount: 999999, items: [line(gp, 1, 11800, { tax_rate: 18 })] })).status === 400);
  const ex = await bill(G.token, { customer_id: gc.id, items: [line(gp, 3, 3333, { tax_rate: 12, discount_percent: 10 }), line(gp, 1, 5000, { tax_rate: 5 })] });
  check('inclusive: mixed GST rates and a line discount keep subtotal - discount + tax = total', ex.status === 201 && ex.json.subtotal - ex.json.discount_amount + ex.json.tax_amount === ex.json.total_amount);

  // ── old behaviour untouched ─────────────────────────────────────────────────
  const old = await bill(B.token, { customer_id: (await customer(B.token)).id, items: [{ description: 'Loose item', quantity: 2, unit: 'pcs', rate: 5000, discount_percent: 0, tax_rate: 18 }] });
  check('a plain bill with no new fields (as old apps send it) works and totals as before', old.status === 201 && old.json.total_amount === 11800 && old.json.items[0].free_qty === 0 && old.json.rates_include_gst === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
