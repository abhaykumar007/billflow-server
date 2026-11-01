// Checks "move existing items to batch tracking" (GET/POST /products/batch-migration).
//   DATABASE_URL=... API=http://localhost:5000 node scripts/migration-suite.mjs
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
  const email = `mg.${label}.${stamp}@example.com`;
  const r = await call('POST', '/auth/register', null, { name: `MG ${label}`, email, password: 'Passw0rd!23', business: { name: `MG Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, token: r.json.accessToken };
}
const upgrade = (email) => execSync(`node scripts/upgrade-test-plan.cjs ${email.toLowerCase()}`, { stdio: 'ignore', env: process.env });
const prod = (t, extra) => call('POST', '/products', t, { name: nm('Item'), sale_price: 100, purchase_price: 60, tax_rate: 12, ...extra }).then((r) => r.json);
const batchesOf = async (t, id) => (await call('GET', `/products/${id}/batches?all=1`, t)).json.batches;
const stockOf = async (t, id) => (await call('GET', `/products/${id}`, t)).json.stock_quantity;

(async () => {
  const A = await account('a'); const B = await account('b');
  upgrade(A.email); upgrade(B.email);
  const staffEmail = `mg.staff.${stamp}@example.com`;
  await call('POST', '/settings/users/invite', A.token, { name: 'Staffer', email: staffEmail, password: 'Passw0rd!23', role: 'staff' });
  const staff = (await call('POST', '/auth/login', null, { email: staffEmail, password: 'Passw0rd!23' })).json.accessToken;
  const cust = (await call('POST', '/customers', A.token, { name: nm('Cust'), state: 'Karnataka' })).json;

  const withStock1 = await prod(A.token, { track_inventory: true, stock_quantity: 40, mrp: 150 });
  const withStock2 = await prod(A.token, { track_inventory: true, stock_quantity: 7.5, sale_price: 80, purchase_price: 50 });
  const negative = await prod(A.token, { track_inventory: true, stock_quantity: -3 });
  const noStock = await prod(A.token, { track_inventory: true, stock_quantity: 0 });
  const service = await prod(A.token, { track_inventory: false });
  const already = await prod(A.token, { track_inventory: true, stock_quantity: 5, track_batches: true });
  const gone = await prod(A.token, { track_inventory: true, stock_quantity: 9 });
  await call('DELETE', `/products/${gone.id}`, A.token);
  const bProd = await prod(B.token, { track_inventory: true, stock_quantity: 11 });

  // ── preview ────────────────────────────────────────────────────────────────
  let r = await call('GET', '/products/batch-migration', A.token);
  check('preview: 5 items to move (stock 40, 7.5, -3, 0 and a service), 1 already tracking', r.status === 200 && r.json.items_to_move === 5 && r.json.already_tracking === 1, JSON.stringify(r.json));
  check('preview: 3 of them have stock (40, 7.5, -3), positive stock 47.5 units', r.json.items_with_stock === 3 && r.json.stock_units === 47.5, JSON.stringify(r.json));
  r = await call('GET', '/products/batch-migration?only_with_stock=1', A.token);
  check('preview with "only items that have stock": 3 items', r.json.items_to_move === 3, JSON.stringify(r.json));
  check('preview changed nothing', (await call('GET', `/products/${withStock1.id}`, A.token)).json.track_batches === false);
  check('staff cannot preview or run it (403)', (await call('GET', '/products/batch-migration', staff)).status === 403 && (await call('POST', '/products/batch-migration', staff, {})).status === 403);
  check('no sign-in is refused (401)', (await call('GET', '/products/batch-migration', null)).status === 401);

  // ── run for chosen items only ──────────────────────────────────────────────
  r = await call('POST', '/products/batch-migration', A.token, { product_ids: [withStock1.id] });
  check('moving one chosen item: 1 converted, 1 opening batch of 40', r.status === 200 && r.json.converted === 1 && r.json.opening_batches_created === 1 && r.json.stock_units === 40, JSON.stringify(r.json));
  let bs = await batchesOf(A.token, withStock1.id);
  check('its stock became one OPENING batch of 40 with the item MRP 150.00 and cost 60.00', bs.length === 1 && bs[0].batch_no === 'OPENING' && bs[0].quantity === 40 && bs[0].mrp === 15000 && bs[0].purchase_price === 6000 && bs[0].is_opening === true, JSON.stringify(bs));
  check('the item total is unchanged (40) and batch tracking is on', (await stockOf(A.token, withStock1.id)) === 40 && (await call('GET', `/products/${withStock1.id}`, A.token)).json.track_batches === true);
  check('items not chosen were not touched', (await call('GET', `/products/${withStock2.id}`, A.token)).json.track_batches === false);
  check('bad ids only: 400', (await call('POST', '/products/batch-migration', A.token, { product_ids: ['a;b'] })).status === 400);
  check("another business's item id changes nothing", (await call('POST', '/products/batch-migration', A.token, { product_ids: [bProd.id] })).json.converted === 0 && (await call('GET', `/products/${bProd.id}`, B.token)).json.track_batches === false);

  // ── run for all (only items with stock) ────────────────────────────────────
  r = await call('POST', '/products/batch-migration', A.token, { only_with_stock: true });
  check('"only items with stock": 2 more converted (7.5 and -3)', r.json.converted === 2 && r.json.opening_batches_created === 2, JSON.stringify(r.json));
  bs = await batchesOf(A.token, withStock2.id);
  check('decimal stock 7.5 keeps its decimals; MRP falls back to the sale price 80.00', bs[0].quantity === 7.5 && bs[0].mrp === 8000, JSON.stringify(bs));
  bs = await batchesOf(A.token, negative.id);
  check('negative stock -3 becomes an OPENING batch of -3 (the total still agrees)', bs.length === 1 && bs[0].quantity === -3 && (await stockOf(A.token, negative.id)) === -3, JSON.stringify(bs));
  check('items with no stock were left alone this time', (await call('GET', `/products/${noStock.id}`, A.token)).json.track_batches === false);

  // ── run for everything left, then again ────────────────────────────────────
  r = await call('POST', '/products/batch-migration', A.token, {});
  check('everything left: the 0-stock item and the service are converted, no batch made for them', r.json.converted === 2 && r.json.opening_batches_created === 0, JSON.stringify(r.json));
  check('the 0-stock item has no batches', (await batchesOf(A.token, noStock.id)).length === 0);
  r = await call('POST', '/products/batch-migration', A.token, {});
  check('running it again changes nothing (idempotent)', r.json.converted === 0 && r.json.opening_batches_created === 0, JSON.stringify(r.json));
  check('already-tracking item kept its single batch', (await batchesOf(A.token, already.id)).length === 1);
  check('the deleted item was not touched', (await call('GET', '/products/batch-migration', A.token)).json.items_to_move === 0);
  const sumOk = async (p) => (await batchesOf(A.token, p.id)).reduce((s, b) => s + b.quantity, 0) === (await stockOf(A.token, p.id));
  check('for every moved item the batches add up to the item stock', (await Promise.all([withStock1, withStock2, negative, noStock].map(sumOk))).every(Boolean));

  // ── the item now behaves like a batch item ─────────────────────────────────
  const line = (p, q, extra = {}) => ({ product_id: p.id, description: p.name, quantity: q, unit: 'pcs', rate: 10000, discount_percent: 0, tax_rate: 12, ...extra });
  const sale = (items) => call('POST', '/invoices', A.token, { voucher_type: 'SALE', status: 'sent', customer_id: cust.id, invoice_date: day(0), discount_amount: 0, items }, { 'Idempotency-Key': `mg-${stamp}-${++n}-${Math.random().toString(36).slice(2)}` });
  check('a sale of a moved item without a batch is refused (BATCH_REQUIRED)', (await sale([line(withStock1, 2)])).json?.code === 'BATCH_REQUIRED');
  const op = (await batchesOf(A.token, withStock1.id))[0];
  const sold = await sale([line(withStock1, 2, { batch_id: op.id })]);
  check('...and with the OPENING batch it sells (no expiry, so no expiry rules)', sold.status === 201 && (await stockOf(A.token, withStock1.id)) === 38 && (await batchesOf(A.token, withStock1.id))[0].quantity === 38, `${sold.status} ${JSON.stringify(sold.json).slice(0, 160)}`);
  const buy = await call('POST', '/invoices', A.token, { voucher_type: 'PURCHASE', status: 'sent', supplier_id: (await call('POST', '/suppliers', A.token, { name: nm('Sup'), state: 'Karnataka' })).json.id, invoice_date: day(0), items: [line(withStock1, 10, { batch_no: 'NEW1', mrp: 15000, expiry_date: day(200) })] }, { 'Idempotency-Key': `mg-${stamp}-${++n}-${Math.random().toString(36).slice(2)}` });
  check('a purchase after the move adds a new batch next to OPENING', buy.status === 201 && (await batchesOf(A.token, withStock1.id)).length === 2 && (await stockOf(A.token, withStock1.id)) === 48, `${buy.status}`);
  check('the other business is untouched throughout', (await call('GET', `/products/${bProd.id}`, B.token)).json.track_batches === false && (await batchesOf(B.token, bProd.id)).length === 0);

  // ── a sale at the same moment as the move: totals still agree ─────────────
  const racer = await prod(A.token, { track_inventory: true, stock_quantity: 100 });
  const [m1] = await Promise.all([
    call('POST', '/products/batch-migration', A.token, { product_ids: [racer.id] }),
    call('POST', '/invoices', A.token, { voucher_type: 'SALE', status: 'sent', customer_id: cust.id, invoice_date: day(0), items: [line(racer, 5)] }, { 'Idempotency-Key': `mg-${stamp}-race-${Math.random().toString(36).slice(2)}` }),
  ]);
  check('a move and an old-style sale at the same moment leave the batches adding up to the stock', m1.status === 200 && (await sumOk(racer)), JSON.stringify(m1.json));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
