// Bill import from a sheet. The browser reads the file and sends the bills as JSON, so the server never parses a spreadsheet.
//   POST /api/imports/bills   { type: 'PURCHASE'|'SALE', dry_run, options: { create_parties, create_items, status }, bills: [...] }
// With dry_run every bill goes through the real bill creation (same checks, same numbering) and is then rolled back, so the
// preview says exactly what the import would do. Each bill is its own transaction: one bad bill never blocks the others, and a
// bill already imported (same bill number and party) is recognised and skipped, so a file can safely be run again.
const express = require('express');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { attachFinancialYear, requireUnlockedFY, enforceOpenYear } = require('../middleware/financialYear');
const { getActivePlan, countInvoicesThisMonth, PLAN_LIMITS } = require('../middleware/planLimit');
const { HttpError } = require('../utils/httpError');
const { createInvoiceCore } = require('./invoices');

const router = express.Router();
router.use(authenticateToken);

const MAX_BILLS = 60;
const MAX_LINES_PER_REQUEST = 1200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

class RowError extends Error {}
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const isDay = (v) => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};
// rupees typed in the sheet -> paise, refusing a third decimal place rather than rounding it away
const toPaise = (v, label) => {
  const n = toNum(v);
  if (n === null) return null;
  if (Number.isNaN(n) || n < 0 || n > 20000000) throw new RowError(`${label} must be a number from 0 up`);
  const p = Math.round(n * 100);
  if (Math.abs(n * 100 - p) > 1e-6) throw new RowError(`${label} has more than 2 decimal places`);
  return p;
};

// Checks one sheet line with no database; returns the cleaned line or throws RowError (message names the sheet row)
function cleanLine(l, type) {
  const row = l && l.row ? `Row ${l.row}` : 'A line';
  const fail = (m) => { throw new RowError(`${row}: ${m}`); };
  try {
    const item = norm(l.item).slice(0, 150);
    const code = norm(l.code).slice(0, 60);
    if (!item && !code) fail('item name or barcode is required');
    const qty = toNum(l.qty);
    if (qty === null || Number.isNaN(qty) || qty <= 0 || qty > 1e9) fail('quantity must be a number above 0');
    const rate = toPaise(l.rate, 'rate');
    if (rate === null) fail('rate is required');
    const disc = toNum(l.disc);
    if (disc !== null && (Number.isNaN(disc) || disc < 0 || disc > 100)) fail('discount % must be from 0 to 100');
    const gst = toNum(l.gst);
    if (gst !== null && (Number.isNaN(gst) || gst < 0 || gst > 100)) fail('GST % must be from 0 to 100');
    const free = toNum(l.free_qty);
    if (free !== null && (Number.isNaN(free) || free < 0)) fail('free quantity must be 0 or more');
    const batch = norm(l.batch_no).toUpperCase();
    if (batch && !/^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/.test(batch)) fail('batch number may only have letters, digits, space . _ / -');
    const expiry = l.expiry ? String(l.expiry) : '';
    const mfg = l.mfg ? String(l.mfg) : '';
    if (expiry && !isDay(expiry)) fail('expiry must be a date');
    if (mfg && !isDay(mfg)) fail('manufacturing date must be a date');
    if (expiry && mfg && mfg > expiry) fail('manufacturing date is after the expiry date');
    return {
      row: l.row, item, code, qty, unit: norm(l.unit).slice(0, 20), rate, disc: disc ?? 0, gst, hsn: norm(l.hsn).slice(0, 20),
      batch_no: batch, expiry, mfg, mrp: toPaise(l.mrp, 'MRP'), free_qty: free ?? 0, sale_price: type === 'PURCHASE' ? toPaise(l.sale_price, 'selling price') : null,
      expired_reason: norm(l.expired_reason).slice(0, 200),
    };
  } catch (e) {
    if (e instanceof RowError && !String(e.message).startsWith('Row ')) throw new RowError(`${row}: ${e.message}`);
    throw e;
  }
}

// Everything that needs no database; returns { errors, lines }
function checkBill(bill, type) {
  const errors = [];
  const ref = norm(bill.ref);
  if (!ref) errors.push('Bill number is missing');
  else if (ref.length > 60) errors.push('Bill number is longer than 60 characters');
  if (!isDay(bill.date)) errors.push('Bill date is missing or not a valid date');
  if (bill.due_date && !isDay(bill.due_date)) errors.push('Due date is not a valid date');
  const party = bill.party || {};
  if (!norm(party.name) && !norm(party.phone)) errors.push(`${type === 'SALE' ? 'Customer' : 'Supplier'} name is missing`);
  const rawLines = Array.isArray(bill.lines) ? bill.lines : [];
  if (!rawLines.length) errors.push('The bill has no lines');
  if (rawLines.length > 200) errors.push('A bill can have at most 200 lines');
  const lines = [];
  for (const l of rawLines.slice(0, 200)) {
    try { lines.push(cleanLine(l || {}, type)); } catch (e) { if (e instanceof RowError) errors.push(e.message); else throw e; }
  }
  // the same batch with two different expiry dates on one bill cannot both be right
  const seen = new Map();
  for (const l of lines) {
    if (!l.batch_no || !l.expiry) continue;
    const k = `${(l.item || l.code).toLowerCase()}|${l.batch_no}|${l.mrp ?? ''}`;
    if (seen.has(k) && seen.get(k) !== l.expiry) errors.push(`Row ${l.row}: batch ${l.batch_no} appears with two different expiry dates`);
    seen.set(k, l.expiry);
  }
  return { errors, lines, ref };
}

async function findParty(tx, businessId, type, party) {
  const model = type === 'SALE' ? tx.customer : tx.supplier;
  const name = norm(party.name);
  let found = null;
  if (name) found = await model.findFirst({ where: { business_id: businessId, is_deleted: false, name: { equals: name, mode: 'insensitive' } } });
  if (!found && norm(party.phone)) found = await model.findFirst({ where: { business_id: businessId, is_deleted: false, phone: norm(party.phone) } });
  return found;
}

async function findProduct(tx, businessId, line) {
  if (line.code) {
    const bc = await tx.productBarcode.findFirst({ where: { business_id: businessId, code: line.code }, include: { product: true } });
    if (bc && !bc.product.is_deleted) return bc.product;
  }
  if (line.item) return tx.product.findFirst({ where: { business_id: businessId, is_deleted: false, name: { equals: line.item, mode: 'insensitive' } } });
  return null;
}

// Runs inside the bill's transaction: finds (or, if allowed, makes) the party and the items, and builds the bill lines
async function resolveBill({ tx, user, type, options, bill, lines, notes }) {
  const businessId = user.businessId;
  const business = await tx.business.findUnique({ where: { id: businessId }, select: { state: true, business_type: true } });
  const created = { party: false, items: [] };
  const warnings = [];
  const party = bill.party || {};

  let partyRow = await findParty(tx, businessId, type, party);
  if (!partyRow) {
    if (!options.create_parties) throw new RowError(`${type === 'SALE' ? 'Customer' : 'Supplier'} "${norm(party.name) || norm(party.phone)}" was not found`);
    if (!norm(party.name)) throw new RowError('A name is needed to create the party');
    const gstin = norm(party.gstin).toUpperCase();
    if (gstin && !GSTIN.test(gstin)) warnings.push(`GSTIN "${gstin}" is not valid; the party was created without it`);
    partyRow = await (type === 'SALE' ? tx.customer : tx.supplier).create({
      data: { business_id: businessId, name: norm(party.name).slice(0, 150), phone: norm(party.phone).slice(0, 15) || null, gstin: gstin && GSTIN.test(gstin) ? gstin : null, state: business.state || null },
    });
    created.party = true;
  }

  const productByKey = new Map();
  const items = [];
  for (const l of lines) {
    const key = `${l.code}|${l.item.toLowerCase()}`;
    let product = productByKey.get(key);
    if (!product) {
      product = await findProduct(tx, businessId, l);
      if (!product) {
        if (!options.create_items) throw new RowError(`Row ${l.row}: item "${l.item || l.code}" was not found`);
        if (!l.item) throw new RowError(`Row ${l.row}: a name is needed to create the item`);
        if (l.gst === null) throw new RowError(`Row ${l.row}: GST % is needed to create the item "${l.item}"`);
        const packed = ['medical', 'fmcg'].includes(business.business_type) || lines.some((x) => x.item.toLowerCase() === l.item.toLowerCase() && x.batch_no);
        product = await tx.product.create({
          data: {
            business_id: businessId, name: l.item, unit: l.unit || 'pcs', tax_rate: l.gst, hsn_code: l.hsn || null, mrp: l.mrp || 0,
            sale_price: type === 'SALE' ? l.rate : (l.sale_price ?? 0), purchase_price: type === 'PURCHASE' ? l.rate : 0,
            track_inventory: true, track_batches: packed, stock_quantity: 0,
          },
        });
        if (l.code) await tx.productBarcode.create({ data: { business_id: businessId, product_id: product.id, code: l.code, kind: 'manufacturer' } }).catch(() => null);
        created.items.push(product.name);
      }
      productByKey.set(key, product);
    }

    let batch_id = null;
    if (type === 'SALE' && product.track_batches) {
      if (!l.batch_no) throw new RowError(`Row ${l.row}: batch number is needed for "${product.name}"`);
      const found = await tx.batch.findMany({ where: { business_id: businessId, product_id: product.id, batch_no: l.batch_no, ...(l.mrp != null ? { mrp: l.mrp } : {}) } });
      if (!found.length) throw new RowError(`Row ${l.row}: batch ${l.batch_no} of "${product.name}" was not found`);
      if (found.length > 1) throw new RowError(`Row ${l.row}: batch ${l.batch_no} of "${product.name}" exists with different MRPs; add the MRP column`);
      batch_id = found[0].id;
    } else if (!product.track_batches && l.batch_no) {
      warnings.push(`Row ${l.row}: "${product.name}" does not track batches, so the batch number was ignored`);
    }
    if (l.gst === null) warnings.push(`Row ${l.row}: GST % was empty, so the item's ${product.tax_rate}% was used`);

    items.push({
      product_id: product.id, description: product.name, quantity: l.qty, unit: l.unit || product.unit, rate: l.rate, discount_percent: l.disc,
      tax_rate: l.gst !== null ? l.gst : product.tax_rate, batch_id, batch_no: l.batch_no || null, expiry_date: l.expiry || null, mfg_date: l.mfg || null,
      mrp: l.mrp, free_qty: type === 'PURCHASE' ? l.free_qty : 0, batch_sale_price: l.sale_price, expired_override_reason: l.expired_reason || null,
    });
  }
  return { patch: { [type === 'SALE' ? 'customer_id' : 'supplier_id']: partyRow.id, items }, partyRow, created, warnings };
}

async function importOne({ user, fy, type, options, bill, dryRun }) {
  const out = { ref: norm(bill.ref), status: 'error', errors: [], warnings: [], will_create: { party: false, items: [] } };
  const checked = checkBill(bill, type);
  if (checked.errors.length) { out.errors = checked.errors; return out; }
  const ctx = { partyRow: null, created: null, warnings: [] };

  try {
    // already imported? (same bill number, same party, not cancelled)
    const dupBase = { business_id: user.businessId, voucher_type: type, is_deleted: false, status: { not: 'cancelled' }, external_ref: { equals: checked.ref, mode: 'insensitive' } };
    const partyNow = await findParty(prisma, user.businessId, type, bill.party || {});
    if (partyNow) {
      const dup = await prisma.invoice.findFirst({ where: { ...dupBase, ...(type === 'SALE' ? { customer_id: partyNow.id } : { supplier_id: partyNow.id }) }, select: { id: true, invoice_number: true } });
      if (dup) return { ...out, status: 'duplicate', existing_invoice_id: dup.id, existing_invoice_number: dup.invoice_number, errors: [`Already imported as ${dup.invoice_number}`] };
    }

    const result = await createInvoiceCore({
      user, fy, dryRun,
      body: { voucher_type: type, status: options.status, invoice_date: bill.date, due_date: bill.due_date || null, notes: bill.notes ? String(bill.notes).slice(0, 2000) : null, external_ref: checked.ref, discount_amount: 0 },
      prepare: async (tx) => {
        const r = await resolveBill({ tx, user, type, options, bill, lines: checked.lines });
        Object.assign(ctx, { partyRow: r.partyRow, created: r.created, warnings: r.warnings });
        return r.patch;
      },
    });
    const inv = result.invoice;
    const extra = result.extra || {};
    const warnings = [...ctx.warnings];
    for (const w of extra.mrp_warnings || []) warnings.push(`${w.description}: price with GST is above the MRP`);
    for (const w of extra.stock_warnings || []) warnings.push(w.message || `${w.description || 'An item'}: not enough stock`);
    if (extra.message) warnings.push(extra.message);
    return {
      ...out, status: dryRun ? 'ok' : 'created', warnings, will_create: ctx.created || out.will_create,
      party: ctx.partyRow ? ctx.partyRow.name : norm((bill.party || {}).name), total: inv.total_amount, lines: inv.items.length,
      ...(dryRun ? {} : { invoice_id: inv.id, invoice_number: inv.invoice_number }),
    };
  } catch (err) {
    out.errors = [err instanceof RowError || err instanceof HttpError ? err.message : 'Could not import this bill'];
    if (!(err instanceof RowError || err instanceof HttpError)) console.error('import bill error:', err);
    if (err instanceof HttpError && err.code) out.code = err.code;
    return out;
  }
}

router.post('/bills', requireRole(...MANAGERS), attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const { type, dry_run: dryRun = false, bills } = req.body || {};
  const opts = req.body?.options || {};
  if (!['PURCHASE', 'SALE'].includes(type)) throw new HttpError(400, 'type must be PURCHASE or SALE', 'VALIDATION');
  if (!Array.isArray(bills) || bills.length === 0) throw new HttpError(400, 'bills must be a list with at least one bill', 'VALIDATION');
  if (bills.length > MAX_BILLS) throw new HttpError(400, `Send at most ${MAX_BILLS} bills at a time`, 'VALIDATION');
  if (bills.reduce((s, b) => s + (Array.isArray(b?.lines) ? b.lines.length : 0), 0) > MAX_LINES_PER_REQUEST) throw new HttpError(400, `Send at most ${MAX_LINES_PER_REQUEST} lines at a time`, 'VALIDATION');
  const options = { create_parties: !!opts.create_parties, create_items: !!opts.create_items, status: opts.status === 'draft' ? 'draft' : 'sent' };

  if (type === 'SALE' && !dryRun) {
    const plan = await getActivePlan(req.user.businessId);
    const limit = PLAN_LIMITS[plan]?.invoicesPerMonth ?? 50;
    if (limit !== Infinity) {
      const used = await countInvoicesThisMonth(req.user.businessId);
      if (used + bills.length > limit) throw new HttpError(403, `Free plan allows ${limit} invoices per month (${used} used). Upgrade to import ${bills.length} more.`, 'PLAN_LIMIT_REACHED', { limit, used });
    }
  }

  const results = [];
  for (const bill of bills) results.push(await importOne({ user: req.user, fy: req.financialYear, type, options, bill: bill || {}, dryRun: !!dryRun }));
  const count = (s) => results.filter((r) => r.status === s).length;
  res.json({ dry_run: !!dryRun, results, summary: { ok: count('ok'), created: count('created'), duplicate: count('duplicate'), error: count('error') } });
});

module.exports = router;
