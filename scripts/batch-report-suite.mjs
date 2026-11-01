// Checks the batch and item-wise reports against figures worked out by hand.
//   DATABASE_URL=... API=http://localhost:5000 node scripts/batch-report-suite.mjs
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
  const email = `br.${label}.${stamp}@example.com`;
  const r = await call('POST', '/auth/register', null, { name: `BR ${label}`, email, password: 'Passw0rd!23', business: { name: `BR Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, token: r.json.accessToken };
}
const upgrade = (email) => execSync(`node scripts/upgrade-test-plan.cjs ${email.toLowerCase()}`, { stdio: 'ignore', env: process.env });
const bill = (t, o) => call('POST', '/invoices', t, { voucher_type: 'SALE', status: 'sent', invoice_date: day(0), discount_amount: 0, ...o }, { 'Idempotency-Key': `br-${stamp}-${++n}-${Math.random().toString(36).slice(2)}` });
const line = (p, quantity, rate, extra = {}) => ({ product_id: p.id, description: p.name, quantity, unit: 'pcs', rate, discount_percent: 0, tax_rate: 12, ...extra });
const rep = (t, path) => call('GET', `/reports/${path}`, t);

(async () => {
  const A = await account('a'); const B = await account('b');
  upgrade(A.email); upgrade(B.email);
  const cust = (await call('POST', '/customers', A.token, { name: nm('Cust'), state: 'Karnataka' })).json;
  const sup = (await call('POST', '/suppliers', A.token, { name: nm('Supp'), state: 'Karnataka' })).json;
  const med = (await call('POST', '/products', A.token, { name: nm('Tab'), sale_price: 100, purchase_price: 80, tax_rate: 12, track_inventory: true, stock_quantity: 0, track_batches: true, mrp: 120 })).json;
  const plain = (await call('POST', '/products', A.token, { name: nm('Plain'), sale_price: 50, purchase_price: 30, tax_rate: 12, track_inventory: true, stock_quantity: 100 })).json;
  const pur = (items) => bill(A.token, { voucher_type: 'PURCHASE', supplier_id: sup.id, items });

  // batch A: 20 @80, MRP 120, expires in 20 days.  batch B: 10 @90, MRP 130, expires in 200 days.  batch C: expired 5 days ago, 3 left.
  check('purchase A', (await pur([line(med, 20, 8000, { batch_no: 'A1', mrp: 12000, expiry_date: day(20) })])).status === 201);
  check('purchase B', (await pur([line(med, 10, 9000, { batch_no: 'B1', mrp: 13000, expiry_date: day(200) })])).status === 201);
  check('expired batch C added by hand', (await call('POST', `/products/${med.id}/batches`, A.token, { batch_no: 'C1', expiry_date: day(-5), mrp: 12000, purchase_price: 7000, quantity: 3 })).status === 201);
  const bs = (await call('GET', `/products/${med.id}/batches?all=1`, A.token)).json.batches;
  const bA = bs.find((b) => b.batch_no === 'A1'); const bB = bs.find((b) => b.batch_no === 'B1');

  // ── stock reports ──────────────────────────────────────────────────────────
  let r = await rep(A.token, 'near-expiry');
  check('near-expiry (default 90 days) lists only batch A', r.status === 200 && r.json.rows.length === 1 && r.json.rows[0].batch_no === 'A1' && r.json.rows[0].days_to_expiry === 20, JSON.stringify(r.json).slice(0, 300));
  check('near-expiry value: 20 x 80.00 at cost, 20 x 120.00 at MRP', r.json.totals.value_at_cost === 160000 && r.json.totals.value_at_mrp === 240000 && r.json.totals.quantity === 20, JSON.stringify(r.json.totals));
  check('near-expiry names the supplier', r.json.rows[0].supplier?.name === sup.name);
  r = await rep(A.token, 'near-expiry?within=365');
  check('within=365 adds batch B, never the expired one', r.json.rows.map((x) => x.batch_no).join() === 'A1,B1', r.json.rows.map((x) => x.batch_no).join());
  r = await rep(A.token, 'near-expiry?within=10');
  check('within=10 lists nothing', r.json.rows.length === 0 && r.json.totals.batches === 0);
  for (const bad of ['within=0', 'within=abc', 'within=9999', 'within=1.5']) check(`near-expiry ${bad} is refused (400)`, (await rep(A.token, `near-expiry?${bad}`)).status === 400);
  r = await rep(A.token, 'expired-stock');
  check('expired stock lists batch C only, 3 x 70.00 = 210.00', r.json.rows.length === 1 && r.json.rows[0].batch_no === 'C1' && r.json.rows[0].status === 'expired' && r.json.totals.value_at_cost === 21000, JSON.stringify(r.json.totals));
  r = await rep(A.token, 'batch-stock');
  check('batch stock lists all 3 with statuses expired / near_expiry / ok', r.json.rows.length === 3 && ['expired', 'near_expiry', 'ok'].every((s) => r.json.rows.some((x) => x.status === s)), JSON.stringify(r.json.rows.map((x) => x.status)));
  check('batch stock totals 33 pieces', r.json.totals.quantity === 33);
  check('status filter works', (await rep(A.token, 'batch-stock?status=ok')).json.rows.length === 1);
  check('product filter works', (await rep(A.token, `batch-stock?product_id=${plain.id}`)).json.rows.length === 0);

  // ── sales: A: 5 @100, B: 3 @110, return 1 from A, plain item 2 @ 50 ──────
  const s1 = await bill(A.token, { customer_id: cust.id, items: [line(med, 5, 10000, { batch_id: bA.id }), line(med, 3, 11000, { batch_id: bB.id }), line(plain, 2, 5000)] });
  check('sale saved', s1.status === 201, JSON.stringify(s1.json).slice(0, 200));
  const ret = await bill(A.token, { voucher_type: 'SALE_RETURN', customer_id: cust.id, items: [line(med, 1, 10000, { batch_id: bA.id })] });
  check('return saved', ret.status === 201);
  const dr = await bill(A.token, { customer_id: cust.id, status: 'draft', items: [line(med, 9, 10000, { batch_id: bA.id })] });
  const cx = await bill(A.token, { customer_id: cust.id, items: [line(med, 2, 10000, { batch_id: bA.id })] });
  await call('DELETE', `/invoices/${cx.json.id}`, A.token);
  check('a draft and a cancelled bill exist (must not count)', dr.status === 201 && cx.status === 201);

  r = await rep(A.token, 'batch-sales');
  const ra = r.json.rows.find((x) => x.batch_no === 'A1'); const rb = r.json.rows.find((x) => x.batch_no === 'B1');
  check('batch-sales has only batch lines (2 rows, no plain item)', r.json.rows.length === 2, JSON.stringify(r.json.rows.map((x) => x.batch_no)));
  check('batch A: sold 5, returned 1, net 4, revenue 5x100-1x100 = 400.00', ra.qty_sold === 5 && ra.qty_returned === 1 && ra.net_qty === 4 && ra.net_revenue === 40000, JSON.stringify(ra));
  check('batch A cost 4 x 80.00 = 320.00, profit 80.00, margin 20%', ra.cost === 32000 && ra.profit === 8000 && ra.margin_pct === 20, JSON.stringify(ra));
  check('batch A stock left = 20 - 5 + 1 = 16, expiry and MRP shown', ra.stock_left === 16 && ra.expiry_date === day(20) && ra.mrp === 12000);
  check('batch B: 3 x 110 = 330.00, cost 270.00, profit 60.00', rb.net_revenue === 33000 && rb.cost === 27000 && rb.profit === 6000, JSON.stringify(rb));
  check('batch totals: revenue 730.00, profit 140.00', r.json.totals.net_revenue === 73000 && r.json.totals.profit === 14000, JSON.stringify(r.json.totals));
  r = await rep(A.token, `batch-sales?product_id=${plain.id}`);
  check('batch-sales for a plain item is empty', r.json.rows.length === 0);

  r = await rep(A.token, 'item-sales');
  const im = r.json.rows.find((x) => x.product_id === med.id); const ip = r.json.rows.find((x) => x.product_id === plain.id);
  check('item-sales: medicine net 7 pieces (8 sold - 1 returned), revenue 730.00', im.qty_sold === 8 && im.qty_returned === 1 && im.net_qty === 7 && im.net_revenue === 73000, JSON.stringify(im));
  check('item-sales: avg rate = 730.00 / 7', im.avg_rate === Math.round(73000 / 7) && im.batches_used === 2 && im.bills === 2);
  check('item-sales: plain item uses its purchase price for cost (2 x 30 = 60, profit 40)', ip.net_revenue === 10000 && ip.cost === 6000 && ip.profit === 4000, JSON.stringify(ip));
  check('item-sales sorted by revenue, medicine first', r.json.rows[0].product_id === med.id);
  check('item-sales totals add up', r.json.totals.net_revenue === 83000 && r.json.totals.rows === 2, JSON.stringify(r.json.totals));
  check('sort=name and limit=1 work', (await rep(A.token, 'item-sales?sort=name&limit=1')).json.rows.length === 1);
  check('limit=0 is refused', (await rep(A.token, 'item-sales?limit=0')).status === 400);
  check('totals ignore limit (still 2 items)', (await rep(A.token, 'item-sales?limit=1')).json.totals.rows === 2);
  check('the old product-sales report still works', (await rep(A.token, 'product-sales')).status === 200);

  r = await rep(A.token, 'mrp-sales');
  const m1 = r.json.rows.find((x) => x.mrp === 12000); const m2 = r.json.rows.find((x) => x.mrp === 13000);
  check('mrp-sales: one row per MRP (120 and 130), plain item left out', r.json.rows.length === 2 && !!m1 && !!m2, JSON.stringify(r.json.rows.map((x) => x.mrp)));
  check('mrp-sales 120: net 4, paid per piece 100 + 12% = 112.00, 6.67% below MRP', m1.net_qty === 4 && m1.avg_paid_per_unit === 11200 && m1.below_mrp_pct === 6.67, JSON.stringify(m1));
  check('mrp-sales 130: paid 110 + 12% = 123.20, 5.23% below MRP', m2.avg_paid_per_unit === 12320 && m2.below_mrp_pct === 5.23, JSON.stringify(m2));

  // ── dates ──────────────────────────────────────────────────────────────────
  check('a period in the past has no sales', (await rep(A.token, 'item-sales?from=2020-01-01&to=2020-01-31')).json.rows.length === 0);
  check("today's date range includes today's bills", (await rep(A.token, `item-sales?from=${day(0)}&to=${day(0)}`)).json.rows.length === 2);
  check('bad date refused', (await rep(A.token, 'batch-sales?from=2026-13-40')).status === 400);
  check('from after to refused', (await rep(A.token, 'batch-sales?from=2026-05-02&to=2026-05-01')).status === 400);
  check('bad product id refused', (await rep(A.token, 'batch-sales?product_id=a;b')).status === 400);

  // ── other business sees none of it; sign-in required ───────────────────────
  for (const p of ['near-expiry', 'expired-stock', 'batch-stock', 'item-sales', 'batch-sales', 'mrp-sales']) {
    const o = await rep(B.token, p);
    check(`other business gets an empty ${p}`, o.status === 200 && o.json.rows.length === 0, JSON.stringify(o.json).slice(0, 120));
    check(`${p} needs sign-in (401)`, (await rep(null, p)).status === 401);
  }
  check('another business cannot filter by my product', (await rep(B.token, `batch-sales?product_id=${med.id}`)).json.rows.length === 0);

  // ── selling out removes the batch from stock lists, not from sales history ─
  await bill(A.token, { customer_id: cust.id, items: [line(med, 3, 10000, { batch_id: bs.find((b) => b.batch_no === 'C1').id, expired_override_reason: 'clearance' })] });
  r = await rep(A.token, 'expired-stock');
  check('selling out the expired batch removes it from expired stock', r.json.rows.length === 0);
  check('...but it stays in the batch list with include_empty', (await rep(A.token, 'batch-stock?include_empty=1')).json.rows.some((x) => x.batch_no === 'C1' && x.quantity === 0));
  check('...and in batch-sales', (await rep(A.token, 'batch-sales')).json.rows.some((x) => x.batch_no === 'C1' && x.net_qty === 3));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
