// Checks the bill import (POST /imports/bills): preview, import, duplicates, bad rows, batches, drafts, permissions.
//   DATABASE_URL=... API=http://localhost:5000 node scripts/import-suite.mjs
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
  const email = `im.${label}.${stamp}@example.com`;
  const r = await call('POST', '/auth/register', null, { name: `IM ${label}`, email, password: 'Passw0rd!23', business: { name: `IM Biz ${label}`, state: 'Karnataka', city: 'Bengaluru' }, client: 'mobile' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json)}`);
  return { email, token: r.json.accessToken };
}
const upgrade = (email) => execSync(`node scripts/upgrade-test-plan.cjs ${email.toLowerCase()}`, { stdio: 'ignore', env: process.env });
const imp = (t, body) => call('POST', '/imports/bills', t, body);
const L = (row, item, qty, rate, extra = {}) => ({ row, item, qty, rate, gst: 12, unit: 'pcs', ...extra });
const B = (ref, party, lines, extra = {}) => ({ ref, date: day(0), party: { name: party }, lines, ...extra });
const stockOf = async (t, id) => (await call('GET', `/products/${id}`, t)).json.stock_quantity;
const findProduct = async (t, name) => ((await call('GET', `/products?search=${encodeURIComponent(name)}`, t)).json.products || []).find((p) => p.name === name);

(async () => {
  const A = await account('a'); const F = await account('free');
  upgrade(A.email);
  const supName = nm('Sun Pharma'); const itemName = nm('Paracetamol'); const itemName2 = nm('Cough Syrup');
  const flags = { create_parties: true, create_items: true };

  // ── preview changes nothing ────────────────────────────────────────────────
  const purchase1 = B('SUP-001', supName, [
    L(2, itemName, 10, 80, { batch_no: 'p1', expiry: day(300), mrp: 120, free_qty: 2 }),
    L(3, itemName2, 5, 50.5, { batch_no: 'c1', expiry: day(400), mrp: 90 }),
  ]);
  let r = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: {}, bills: [purchase1] });
  check('preview without "create" flags: supplier not found', r.status === 200 && r.json.results[0].status === 'error' && /not found/.test(r.json.results[0].errors[0]), JSON.stringify(r.json));
  r = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [purchase1] });
  const p = r.json.results[0];
  check('preview with flags: ok, will create the supplier and 2 items', p.status === 'ok' && p.will_create.party === true && p.will_create.items.length === 2, JSON.stringify(p));
  check('preview total: 10 x 80 + 5 x 50.50 = 1052.50 + 12% GST = 1178.80', p.total === 117880, `${p.total}`);
  check('preview created nothing (no supplier, no items, no bills)', (await call('GET', `/suppliers?search=${encodeURIComponent(supName)}`, A.token)).json.suppliers?.length === 0 && !(await findProduct(A.token, itemName)) && (await call('GET', '/invoices?type=PURCHASE', A.token)).json.invoices?.length === 0);

  // ── import ─────────────────────────────────────────────────────────────────
  r = await imp(A.token, { type: 'PURCHASE', options: flags, bills: [purchase1] });
  check('import creates the bill', r.json.results[0].status === 'created' && !!r.json.results[0].invoice_number && r.json.summary.created === 1, JSON.stringify(r.json));
  const prod1 = await findProduct(A.token, itemName);
  check('new item made with GST 12, batch tracking on', prod1 && prod1.tax_rate === 12 && prod1.track_batches === true, JSON.stringify(prod1));
  check('stock moved: 10 + 2 free = 12', (await stockOf(A.token, prod1.id)) === 12);
  const bt = (await call('GET', `/products/${prod1.id}/batches`, A.token)).json.batches;
  check('batch P1 (uppercased) with MRP 120.00 and expiry', bt.length === 1 && bt[0].batch_no === 'P1' && bt[0].mrp === 12000 && bt[0].expiry_date?.slice(0, 10) === day(300), JSON.stringify(bt));
  const inv = (await call('GET', `/invoices/${r.json.results[0].invoice_id}`, A.token)).json;
  check('bill keeps the sheet bill number as its reference and is posted', inv.external_ref === 'SUP-001' && inv.status !== 'draft' && inv.total_amount === 117880, JSON.stringify({ e: inv.external_ref, s: inv.status, t: inv.total_amount }));

  // ── duplicates ─────────────────────────────────────────────────────────────
  r = await imp(A.token, { type: 'PURCHASE', options: flags, bills: [{ ...purchase1, ref: 'sup-001', party: { name: supName.toUpperCase() } }] });
  check('same bill again (bill no. and supplier match ignoring case) is skipped as a duplicate', r.json.results[0].status === 'duplicate' && r.json.summary.duplicate === 1, JSON.stringify(r.json.results[0]));
  check('no second bill and no double stock', (await stockOf(A.token, prod1.id)) === 12);
  r = await imp(A.token, { type: 'PURCHASE', options: flags, bills: [B('SUP-001', nm('Other Supplier'), [L(2, itemName, 1, 80, { batch_no: 'p9', expiry: day(300), mrp: 120 })])] });
  check('the same bill number from a different supplier is not a duplicate', r.json.results[0].status === 'created', JSON.stringify(r.json.results[0]));
  const dupInv = r.json.results[0].invoice_id;
  await call('DELETE', `/invoices/${(await call('GET', `/invoices/${dupInv}`, A.token)).json.id}`, A.token);

  // ── bad rows are reported, good bills still import ─────────────────────────
  const bad = (name, line, extraBill = {}) => imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [B('BAD', supName, [line], extraBill)] }).then((x) => x.json.results[0]);
  for (const [label, line, rx] of [
    ['quantity 0', L(2, itemName, 0, 80, { batch_no: 'x', expiry: day(5) }), /quantity/],
    ['quantity text', L(2, itemName, 'abc', 80, { batch_no: 'x', expiry: day(5) }), /quantity/],
    ['rate with 3 decimals', L(2, itemName, 1, 80.555, { batch_no: 'x', expiry: day(5) }), /decimal/],
    ['negative rate', L(2, itemName, 1, -5, { batch_no: 'x', expiry: day(5) }), /rate/],
    ['discount 150', L(2, itemName, 1, 80, { disc: 150, batch_no: 'x', expiry: day(5) }), /discount/],
    ['bad expiry', L(2, itemName, 1, 80, { batch_no: 'x', expiry: '31/02/2027' }), /expiry/],
    ['batch with symbols', L(2, itemName, 1, 80, { batch_no: 'a;b', expiry: day(5) }), /batch number/],
    ['no item', L(2, '', 1, 80), /item/],
    ['batch missing on a batch item', L(2, itemName, 1, 80), /[Bb]atch/],
  ]) {
    const x = await bad(label, line);
    check(`bad row refused: ${label}`, x.status === 'error' && rx.test(x.errors.join(' ')), JSON.stringify(x.errors));
  }
  let x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [{ ref: '', date: 'tomorrow', party: {}, lines: [] }] });
  check('missing bill no., bad date, no party, no lines: all reported together', x.json.results[0].errors.length >= 4, JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [B('B2', supName, [L(2, nm('New thing'), 1, 10, { gst: null, batch_no: 'x', expiry: day(9) })])] });
  check('a new item without GST % is refused', /GST/.test(x.json.results[0].errors.join(' ')), JSON.stringify(x.json.results[0]));
  x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [B('B3', supName, [L(2, itemName, 1, 80, { batch_no: 'z', expiry: day(9) }), L(3, itemName, 1, 80, { batch_no: 'z', expiry: day(99) })])] });
  check('one batch with two expiry dates on a bill is refused', /two different expiry/.test(x.json.results[0].errors.join(' ')), JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [{ ...B('B4', supName, [L(2, itemName, 1, 80, { batch_no: 'z', expiry: day(9) })]), date: '2019-01-01' }] });
  check('a date outside the financial year is refused with the usual message', x.json.results[0].status === 'error' && /outside FY/.test(x.json.results[0].errors[0]), JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'PURCHASE', options: flags, bills: [B('MIX-1', supName, [L(2, itemName, 1, 80, { batch_no: 'mx', expiry: day(50), mrp: 120 })]), B('MIX-2', supName, [L(2, itemName, 0, 80)])] });
  check('a bad bill does not stop a good one in the same request', x.json.results[0].status === 'created' && x.json.results[1].status === 'error' && x.json.summary.created === 1 && x.json.summary.error === 1, JSON.stringify(x.json.summary));

  // ── medical business needs expiry ──────────────────────────────────────────
  await call('PUT', '/settings/industry', A.token, { business_type: 'medical' });
  x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [B('MED-1', supName, [L(2, itemName, 1, 80, { batch_no: 'noexp' })])] });
  check('medical business: purchase without expiry refused (same rule as typing it)', x.json.results[0].code === 'EXPIRY_REQUIRED', JSON.stringify(x.json.results[0]));
  await call('PUT', '/settings/industry', A.token, { business_type: 'general' });

  // ── sales ──────────────────────────────────────────────────────────────────
  const custName = nm('Ramesh');
  const sale = (ref, lines, extra) => ({ ref, date: day(0), party: { name: custName }, lines, ...extra });
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: { create_parties: true }, bills: [sale('S1', [L(2, itemName, 2, 100)])] });
  check('sale of a batch item without a batch no. is refused', /batch number is needed/.test(x.json.results[0].errors.join(' ')), JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: { create_parties: true }, bills: [sale('S1', [L(2, itemName, 2, 100, { batch_no: 'NOPE' })])] });
  check('sale naming a batch that does not exist is refused', /was not found/.test(x.json.results[0].errors.join(' ')), JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S1', [L(2, itemName, 2, 100, { batch_no: 'P1' })])] });
  check('sale to an unknown customer is refused unless creating customers is allowed', /not found/.test(x.json.results[0].errors.join(' ')));
  x = await imp(A.token, { type: 'SALE', options: { create_parties: true }, bills: [sale('S1', [L(2, itemName, 2, 100, { batch_no: 'P1' })])] });
  check('sale imported: customer created, 2 x 100 + 12% = 224.00', x.json.results[0].status === 'created' && x.json.results[0].total === 22400 && x.json.results[0].will_create.party === true, JSON.stringify(x.json.results[0]));
  check('stock down by 2 (12 + 1 + ... = batch P1 now 10)', (await call('GET', `/products/${prod1.id}/batches`, A.token)).json.batches.find((b) => b.batch_no === 'P1').quantity === 10);
  x = await imp(A.token, { type: 'SALE', options: { create_parties: true }, bills: [sale('S1', [L(2, itemName, 2, 100, { batch_no: 'P1' })])] });
  check('importing the sale again is a duplicate', x.json.results[0].status === 'duplicate');

  // expired batch: owner needs a reason
  await call('POST', `/products/${prod1.id}/batches`, A.token, { batch_no: 'OLD1', expiry_date: day(-4), mrp: 12000, purchase_price: 7000, quantity: 3 });
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S2', [L(2, itemName, 1, 100, { batch_no: 'OLD1' })])] });
  check('expired batch without a reason is refused', x.json.results[0].code === 'EXPIRED_BATCH_REASON_REQUIRED', JSON.stringify(x.json.results[0]));
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S2', [L(2, itemName, 1, 100, { batch_no: 'OLD1', expired_reason: 'clearance' })])] });
  check('expired batch with a reason column is accepted', x.json.results[0].status === 'ok', JSON.stringify(x.json.results[0]));
  // MRP warning shows as a warning, not an error
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S3', [L(2, itemName, 1, 150, { batch_no: 'P1' })])] });
  check('price above MRP is a warning, not an error', x.json.results[0].status === 'ok' && x.json.results[0].warnings.some((w) => /MRP/.test(w)), JSON.stringify(x.json.results[0]));
  // same batch no. with two MRPs needs the MRP column
  await imp(A.token, { type: 'PURCHASE', options: flags, bills: [B('SUP-DUP', supName, [L(2, itemName, 4, 85, { batch_no: 'P1', expiry: day(300), mrp: 130 })])] });
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S4', [L(2, itemName, 1, 100, { batch_no: 'P1' })])] });
  check('a batch no. that exists with two MRPs asks for the MRP', /different MRPs/.test(x.json.results[0].errors.join(' ')), JSON.stringify(x.json.results[0].errors));
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [sale('S4', [L(2, itemName, 1, 100, { batch_no: 'P1', mrp: 130 })])] });
  check('...and with the MRP it is found', x.json.results[0].status === 'ok', JSON.stringify(x.json.results[0].errors));

  // ── drafts ─────────────────────────────────────────────────────────────────
  const before = await stockOf(A.token, prod1.id);
  x = await imp(A.token, { type: 'SALE', options: { status: 'draft' }, bills: [sale('S5', [L(2, itemName, 1, 100, { batch_no: 'P1', mrp: 130 })])] });
  check('"save as draft": bill is a draft and stock does not move', x.json.results[0].status === 'created' && (await call('GET', `/invoices/${x.json.results[0].invoice_id}`, A.token)).json.status === 'draft' && (await stockOf(A.token, prod1.id)) === before);

  // ── matching ───────────────────────────────────────────────────────────────
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [{ ref: 'S6', date: day(0), party: { name: custName.toLowerCase() }, lines: [L(2, `  ${itemName.toUpperCase()}  `, 1, 100, { batch_no: 'P1', mrp: 130 })] }] });
  check('party and item match ignoring case and extra spaces', x.json.results[0].status === 'ok' && !x.json.results[0].will_create.party && x.json.results[0].will_create.items.length === 0, JSON.stringify(x.json.results[0]));
  await call('POST', `/products/${prod1.id}/barcodes`, A.token, { code: '8901234567890' });
  x = await imp(A.token, { type: 'SALE', dry_run: true, options: {}, bills: [{ ref: 'S7', date: day(0), party: { name: custName }, lines: [{ row: 2, code: '8901234567890', qty: 1, rate: 100, batch_no: 'P1', mrp: 130 }] }] });
  check('an item can be found by its barcode', x.json.results[0].status === 'ok', JSON.stringify(x.json.results[0]));

  // ── GST-inclusive rates ────────────────────────────────────────────────────
  await call('PUT', '/settings/industry', A.token, { rates_include_gst: true });
  x = await imp(A.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [B('INC-1', supName, [L(2, nm('Inc item'), 1, 118, { gst: 18, batch_no: 'i1', expiry: day(99) })])] });
  check('rates include GST: 118.00 stays 118.00 (100.00 + 18.00)', x.json.results[0].total === 11800, JSON.stringify(x.json.results[0]));
  await call('PUT', '/settings/industry', A.token, { rates_include_gst: false });

  // ── request limits, permissions, other business ────────────────────────────
  check('no sign-in is refused (401)', (await imp(null, { type: 'SALE', bills: [] })).status === 401);
  check('bad type is refused (400)', (await imp(A.token, { type: 'ESTIMATE', bills: [B('x', 'y', [])] })).status === 400);
  check('empty bill list is refused (400)', (await imp(A.token, { type: 'SALE', bills: [] })).status === 400);
  check('more than 60 bills in one request is refused (400)', (await imp(A.token, { type: 'SALE', dry_run: true, bills: Array.from({ length: 61 }, (_, i) => B(`T${i}`, 'x', [L(2, 'y', 1, 1)])) })).status === 400);
  const staffEmail = `im.staff.${stamp}@example.com`;
  await call('POST', '/settings/users/invite', A.token, { name: 'Staffer', email: staffEmail, password: 'Passw0rd!23', role: 'staff' });
  const staff = (await call('POST', '/auth/login', null, { email: staffEmail, password: 'Passw0rd!23' })).json.accessToken;
  check('staff cannot import (403)', (await imp(staff, { type: 'PURCHASE', dry_run: true, options: flags, bills: [purchase1] })).status === 403);
  x = await imp(F.token, { type: 'PURCHASE', options: flags, bills: [B('F-1', 'Free Supplier', [L(2, 'Free item', 3, 10, { batch_no: 'f1', expiry: day(30) })])] });
  check('a free-plan account can import purchases', x.json.results[0].status === 'created', JSON.stringify(x.json));
  x = await imp(F.token, { type: 'PURCHASE', dry_run: true, options: flags, bills: [purchase1] });
  check('another business is never told about my bills (no duplicate there)', x.json.results[0].status === 'ok');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
