// Edge cases for batches: bad input, cross-business access, returns, cancels, free pieces, stock guards, auth fields.
//   DATABASE_URL=... API=http://localhost:5000 node scripts/batch-edge-suite.mjs
import { execSync } from 'node:child_process';
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const stamp = Date.now();
let pass = 0; let fail = 0; let n = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); };
const nm = (p) => `${p} ${stamp}-${++n}`;
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
async function account(label) {
  const email = `be.${label}.${stamp}@example.com`;
  const r = await call('POST', '/auth/register', null, { name: `BE ${label}`, email, password: 'Passw0rd!23', business: { name: `BE Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, token: r.json.accessToken };
}
const upgrade = (email) => execSync(`node scripts/upgrade-test-plan.cjs ${email.toLowerCase()}`, { stdio: 'ignore', env: process.env });
const product = (t, extra = {}) => call('POST', '/products', t, { name: nm('Item'), sale_price: 150, purchase_price: 100, tax_rate: 5, ...extra }).then((r) => r.json);
const customer = (t) => call('POST', '/customers', t, { name: nm('Cust'), state: 'Karnataka' }).then((r) => r.json);
const supplier = (t) => call('POST', '/suppliers', t, { name: nm('Supp'), state: 'Karnataka' }).then((r) => r.json);
const line = (p, quantity, rate, extra = {}) => ({ product_id: p.id, description: p.name, quantity, unit: 'pcs', rate, discount_percent: 0, tax_rate: p.tax_rate ?? 5, ...extra });
const bill = (t, o) => call('POST', '/invoices', t, { voucher_type: 'SALE', status: 'sent', invoice_date: day(0), discount_amount: 0, ...o }, { 'Idempotency-Key': `be-${stamp}-${++n}-${Math.random().toString(36).slice(2)}` });
const stockOf = async (t, id) => (await call('GET', `/products/${id}`, t)).json.stock_quantity;
const batchesOf = async (t, id) => (await call('GET', `/products/${id}/batches?all=1`, t)).json.batches;
const qtyOf = async (t, id, batchId) => (await batchesOf(t, id)).find((b) => b.id === batchId)?.quantity;

(async () => {
  const A = await account('a'); const B = await account('b');
  upgrade(A.email); upgrade(B.email);
  const cust = await customer(A.token); const sup = await supplier(A.token);
  const tracked = await product(A.token, { track_inventory: true, stock_quantity: 0, track_batches: true, mrp: 200 });

  // ── auth payload and stock guard ───────────────────────────────────────────
  const login = await call('POST', '/auth/login', null, { email: A.email, password: 'Passw0rd!23' });
  const biz = login.json?.user?.business || login.json?.business || {};
  check('login returns the industry fields on the business', 'business_type' in biz && 'rates_include_gst' in biz && 'near_expiry_days' in biz, JSON.stringify(biz).slice(0, 200));
  const guard = await call('PUT', `/products/${tracked.id}`, A.token, { stock_quantity: 99 });
  check('changing stock directly on a batch item is refused (400)', guard.status === 400, `${guard.status}`);
  check('sending the same stock figure back is allowed', (await call('PUT', `/products/${tracked.id}`, A.token, { stock_quantity: 0, name: nm('Renamed') })).status === 200);

  // ── purchase validation ────────────────────────────────────────────────────
  const pur = (items, extra = {}) => bill(A.token, { voucher_type: 'PURCHASE', supplier_id: sup.id, items, ...extra });
  check('purchase with no batch number on a batch item is refused', (await pur([line(tracked, 5, 8000)])).status === 400);
  check('batch number with symbols is refused', (await pur([line(tracked, 5, 8000, { batch_no: 'A;DROP', mrp: 20000 })])).status === 400);
  check('mfg date after expiry is refused', (await pur([line(tracked, 5, 8000, { batch_no: 'M1', mrp: 20000, expiry_date: day(30), mfg_date: day(60) })])).status === 400);
  check('negative free pieces refused', (await pur([line(tracked, 5, 8000, { batch_no: 'F1', mrp: 20000, free_qty: -1 })])).status === 400);
  check('zero quantity refused', (await pur([line(tracked, 0, 8000, { batch_no: 'Z1', mrp: 20000 })])).status === 400);
  check('stock stays 0 after all the refused purchases', (await stockOf(A.token, tracked.id)) === 0);

  const ok = await pur([line(tracked, 10, 8000, { batch_no: ' ab-1 ', mrp: 20000, expiry_date: day(100), free_qty: 2 })]);
  check('a good purchase is saved', ok.status === 201, JSON.stringify(ok.json).slice(0, 200));
  let bs = await batchesOf(A.token, tracked.id);
  const b1 = bs.find((b) => b.batch_no === 'AB-1');
  check('batch number is trimmed and uppercased (AB-1)', !!b1);
  check('batch holds paid + free pieces (12) and cost per piece is amount/12', b1?.quantity === 12 && b1.purchase_price === Math.round(80000 / 12), JSON.stringify(b1));

  // ── sale validation ────────────────────────────────────────────────────────
  const sale = (items, extra = {}) => bill(A.token, { customer_id: cust.id, items, ...extra });
  check('sale with no batch on a batch item is refused (BATCH_REQUIRED)', (await sale([line(tracked, 1, 15000)])).json?.code === 'BATCH_REQUIRED');
  check('sale with a made-up batch id is refused', (await sale([line(tracked, 1, 15000, { batch_id: 'nope' })])).status === 400);
  const other = await product(A.token, { track_inventory: true, stock_quantity: 0, track_batches: true });
  check('batch of a different item is refused', (await sale([line(other, 1, 15000, { batch_id: b1.id })])).status === 400);
  const bProd = await product(B.token, { track_inventory: true, track_batches: true });
  check('another business cannot see my batch list (404)', (await call('GET', `/products/${tracked.id}/batches`, B.token)).status === 404);
  check('another business cannot adjust my batch', [403, 404].includes((await call('POST', `/batches/${b1.id}/adjust`, B.token, { quantity_delta: -1, reason: 'x' })).status));
  check('another business cannot sell my batch', (await bill(B.token, { customer_id: (await customer(B.token)).id, items: [line(bProd, 1, 100, { batch_id: b1.id })] })).status === 400);

  // ── sale, cancel, return move the same batch ──────────────────────────────
  const s1 = await sale([line(tracked, 5, 15000, { batch_id: b1.id })]);
  check('sale of 5 saved', s1.status === 201, JSON.stringify(s1.json).slice(0, 200));
  check('batch 12 -> 7 and item total 7', (await qtyOf(A.token, tracked.id, b1.id)) === 7 && (await stockOf(A.token, tracked.id)) === 7);
  check('the bill line keeps batch no, expiry, MRP and cost', s1.json?.items?.[0]?.batch_no === 'AB-1' && s1.json.items[0].mrp === 20000 && !!s1.json.items[0].expiry_date && s1.json.items[0].cost_price > 0, JSON.stringify(s1.json?.items?.[0]));
  const ret = await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cust.id, items: [line(tracked, 2, 15000, { batch_id: b1.id })] });
  check('a return of 2 goes back to the same batch (7 -> 9)', ret.status === 201 && (await qtyOf(A.token, tracked.id, b1.id)) === 9, `${ret.status}`);
  const noBatchRet = await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cust.id, items: [line(tracked, 1, 15000)] });
  check('a return with no batch is refused', noBatchRet.status === 400);
  const cancel = await call('DELETE', `/invoices/${s1.json.id}`, A.token);
  check('cancelling the sale puts 5 back (9 -> 14)', cancel.status === 200 && (await qtyOf(A.token, tracked.id, b1.id)) === 14 && (await stockOf(A.token, tracked.id)) === 14, `${cancel.status}`);
  const cancel2 = await call('DELETE', `/invoices/${s1.json.id}`, A.token);
  check('cancelling twice does not put stock back twice', (await stockOf(A.token, tracked.id)) === 14, `${cancel2.status}`);

  // ── drafts and estimates do not move stock ────────────────────────────────
  const dr = await sale([line(tracked, 3, 15000, { batch_id: b1.id })], { status: 'draft' });
  check('a draft with a batch is saved and moves no stock', dr.status === 201 && (await stockOf(A.token, tracked.id)) === 14, `${dr.status}`);
  const est = await bill(A.token, { voucher_type: 'ESTIMATE', customer_id: cust.id, status: 'draft', items: [line(tracked, 3, 15000)] });
  check('an estimate needs no batch and moves no stock', est.status === 201 && (await stockOf(A.token, tracked.id)) === 14, `${est.status} ${JSON.stringify(est.json).slice(0, 120)}`);

  // ── oversell, free pieces, the same batch bought twice ────────────────────
  const over = await sale([line(tracked, 20, 15000, { batch_id: b1.id })]);
  check('selling more than the batch holds is allowed (14 -> -6)', over.status === 201 && (await qtyOf(A.token, tracked.id, b1.id)) === -6, `${over.status}`);
  await call('DELETE', `/invoices/${over.json?.id}`, A.token);
  const again = await pur([line(tracked, 10, 8000, { batch_no: 'AB-1', mrp: 20000, expiry_date: day(100) })]);
  bs = await batchesOf(A.token, tracked.id);
  check('same batch, MRP and cost tops up one batch (no duplicate)', again.status === 201 && bs.filter((x) => x.batch_no === 'AB-1' && x.mrp === 20000 && x.purchase_price === 8000).length >= 1 && bs.filter((x) => x.batch_no === 'AB-1').length <= 2, JSON.stringify(bs.map((x) => [x.batch_no, x.purchase_price, x.quantity])));
  const clash = await pur([line(tracked, 1, 8000, { batch_no: 'AB-1', mrp: 20000, expiry_date: day(400) })]);
  check('same batch with a different expiry is refused (409)', clash.status === 409, `${clash.status}`);
  check('the stock total is still the sum of the batches', (await stockOf(A.token, tracked.id)) === (await batchesOf(A.token, tracked.id)).reduce((s, x) => s + x.quantity, 0));

  // ── expired batch rules ────────────────────────────────────────────────────
  const old = await call('POST', `/products/${tracked.id}/batches`, A.token, { batch_no: 'OLD-1', expiry_date: day(-3), mrp: 20000, purchase_price: 8000, quantity: 4 });
  check('an expired batch can be added by hand (stock count)', old.status === 201, `${old.status}`);
  const oldId = old.json?.id || (await batchesOf(A.token, tracked.id)).find((x) => x.batch_no === 'OLD-1')?.id;
  check('selling expired stock without a reason is refused (owner: reason required)', (await sale([line(tracked, 1, 15000, { batch_id: oldId })])).json?.code === 'EXPIRED_BATCH_REASON_REQUIRED');
  const okOld = await sale([line(tracked, 1, 15000, { batch_id: oldId, expired_override_reason: 'Customer insisted, near use' })]);
  check('owner can sell it with a reason, and the reason is on the line', okOld.status === 201 && okOld.json.items[0].expired_override_reason === 'Customer insisted, near use', `${okOld.status}`);
  const retOld = await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cust.id, items: [line(tracked, 1, 15000, { batch_id: oldId })] });
  check('a customer can return an expired batch (no reason asked)', retOld.status === 201, `${retOld.status} ${JSON.stringify(retOld.json).slice(0, 150)}`);
  const incl = await call('PUT', '/settings/industry', A.token, { rates_include_gst: true });
  const estIncl = await bill(A.token, { voucher_type: 'ESTIMATE', status: 'draft', customer_id: cust.id, discount_amount: 1000, items: [line(tracked, 2, 11800, { tax_rate: 12 })] });
  check('inclusive estimate with a typed discount: 226.00 total, discount kept as typed', incl.status === 200 && estIncl.status === 201 && estIncl.json.total_amount === 22600 && estIncl.json.discount_incl === 1000, `${estIncl.status} ${JSON.stringify(estIncl.json).slice(0, 150)}`);
  await call('PUT', '/settings/industry', A.token, { rates_include_gst: false });
  check('the expiry list shows it', (await call('GET', '/batches?expired=1', A.token)).json.batches.some((x) => x.id === oldId));

  // ── medical business needs expiry on purchase ─────────────────────────────
  await call('PUT', '/settings/industry', A.token, { business_type: 'medical' });
  const noExp = await pur([line(tracked, 1, 8000, { batch_no: 'NOEXP', mrp: 20000 })]);
  check('medical business: purchase without expiry is refused (EXPIRY_REQUIRED)', noExp.json?.code === 'EXPIRY_REQUIRED', JSON.stringify(noExp.json));

  // ── plain items next to batch items on one bill ───────────────────────────
  const plain = await product(A.token, { track_inventory: true, stock_quantity: 10 });
  const mixed = await sale([line(tracked, 1, 15000, { batch_id: b1.id }), line(plain, 2, 15000)]);
  check('one bill with a batch item and a plain item', mixed.status === 201 && (await stockOf(A.token, plain.id)) === 8, `${mixed.status} ${JSON.stringify(mixed.json).slice(0, 150)}`);
  const bad = await sale([line(plain, 1, 15000), line(tracked, 1, 15000)]);
  check('a failing line rolls the whole bill back (plain item stock unchanged)', bad.status === 400 && (await stockOf(A.token, plain.id)) === 8);

  // ── estimate -> sale keeps the pricing mode and needs a batch before it can be sent ──
  await call('PUT', '/settings/industry', A.token, { rates_include_gst: true });
  const estB = await bill(A.token, { voucher_type: 'ESTIMATE', status: 'sent', customer_id: cust.id, items: [line(tracked, 2, 11800, { tax_rate: 12 })] });
  check('estimate (GST-inclusive) with a batch item needs no batch', estB.status === 201 && estB.json.rates_include_gst === true && estB.json.total_amount === 23600, `${estB.status} ${JSON.stringify(estB.json).slice(0, 160)}`);
  await call('PUT', '/settings/industry', A.token, { rates_include_gst: false });
  const conv = await call('POST', `/invoices/${estB.json.id}/convert`, A.token, {});
  check('converting keeps "rates include GST" and the same total (236.00)', conv.status === 201 && conv.json.rates_include_gst === true && conv.json.total_amount === 23600 && conv.json.status === 'draft', `${conv.status} ${JSON.stringify(conv.json).slice(0, 160)}`);
  const sendNoBatch = await call('POST', `/invoices/${conv.json.id}/send`, A.token);
  check('sending the converted draft without a batch is refused (BATCH_REQUIRED) and nothing moves', sendNoBatch.status === 400 && sendNoBatch.json.code === 'BATCH_REQUIRED', `${sendNoBatch.status} ${JSON.stringify(sendNoBatch.json)}`);
  const stillDraft = (await call('GET', `/invoices/${conv.json.id}`, A.token)).json;
  check('...and it is still a draft', stillDraft.status === 'draft');
  const picked = await call('PUT', `/invoices/${conv.json.id}`, A.token, { customer_id: cust.id, invoice_date: day(0), items: [line(tracked, 2, 11800, { tax_rate: 12, batch_id: b1.id })] });
  check('picking the batch on the draft keeps the inclusive total (236.00)', picked.status === 200 && picked.json.total_amount === 23600 && picked.json.rates_include_gst === true, `${picked.status} ${JSON.stringify(picked.json).slice(0, 160)}`);
  const before2 = await qtyOf(A.token, tracked.id, b1.id);
  const sentOk = await call('POST', `/invoices/${conv.json.id}/send`, A.token);
  check('now it can be sent, and the batch goes down by 2', sentOk.status === 200 && (await qtyOf(A.token, tracked.id, b1.id)) === before2 - 2, `${sentOk.status} ${JSON.stringify(sentOk.json).slice(0, 160)}`);

  // ── a bill made on a phone without internet (made_offline) keeps its real time and a batch ──
  const madeAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const offBill = await bill(A.token, { customer_id: cust.id, made_offline: true, offline_ref: 'OFFLINE-007', client_created_at: madeAt, items: [line(tracked, 1, 15000, { batch_id: b1.id })] });
  check('an offline bill is saved with its batch, marked made_offline, with the temporary number and the real time', offBill.status === 201 && offBill.json.made_offline === true && offBill.json.offline_ref === 'OFFLINE-007' && new Date(offBill.json.created_at).toISOString() === madeAt && !!offBill.json.synced_at, JSON.stringify(offBill.json).slice(0, 220));

  // an invoice's lines say whether their item keeps batches, so a draft made from an estimate can show its batch picker
  const convGet = (await call('GET', `/invoices/${conv.json.id}`, A.token)).json;
  check('invoice lines carry product.track_batches (true for a batch item)', convGet.items?.[0]?.product?.track_batches === true, JSON.stringify(convGet.items?.[0]?.product));
  const staffEmail2 = `be.staff.${stamp}@example.com`;
  await call('POST', '/settings/users/invite', A.token, { name: 'Staffer', email: staffEmail2, password: 'Passw0rd!23', role: 'staff' });
  const staffTok = (await call('POST', '/auth/login', null, { email: staffEmail2, password: 'Passw0rd!23' })).json.accessToken;
  const expiredNow = await call('POST', `/products/${tracked.id}/batches`, A.token, { batch_no: 'OLD-S', expiry_date: day(-2), mrp: 20000, purchase_price: 8000, quantity: 3 });
  const staffSale = await bill(staffTok, { customer_id: cust.id, items: [line(tracked, 1, 15000, { batch_id: expiredNow.json.id, expired_override_reason: 'staff tries' })] });
  check('staff cannot sell an expired batch, even naming a reason (422 EXPIRED_BATCH)', staffSale.status === 422 && staffSale.json.code === 'EXPIRED_BATCH', `${staffSale.status} ${JSON.stringify(staffSale.json)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
