// Stock movement for bills, including batches (medical / FMCG).
//
// - Product.stock_quantity is always the total. For a product with track_batches the same movement is also applied to one batch,
//   so the total always equals the sum of its batches.
// - A purchase line creates its batch when the bill is posted (or tops up one with the same batch number, MRP and cost).
// - A sale / return line must name the batch it takes from / goes back to (the person picks it; nothing is chosen automatically).
// - Selling an expired batch is blocked. Only the owner can allow it, and the reason is saved on the line.
const { HttpError } = require('../utils/httpError');
const { lockRows } = require('../utils/lock');
const { todayDate } = require('../utils/time');

const BATCH_VOUCHERS = ['SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN'];

const isExpired = (expiry, today = todayDate()) => !!expiry && new Date(expiry).getTime() < today.getTime();
const fmtDay = (d) => new Date(d).toISOString().slice(0, 10);

// The cost of one unit of a purchase line: what was paid (GST excluded, after the line discount) over everything received, free
// pieces included, so a scheme lowers the cost per piece.
function unitCostOf(item) {
  const pieces = Number(item.quantity) + Number(item.free_qty || 0);
  return pieces > 0 ? Math.round(Number(item.amount) / pieces) : 0;
}

// Find the batch a purchase line belongs to, or make it. Same batch number + MRP + cost = the same batch.
async function upsertBatchFromLine(tx, businessId, product, item, supplierId) {
  const mrp = item.mrp ?? product.mrp ?? 0;
  const purchase_price = unitCostOf(item);
  const key = { product_id: product.id, batch_no: item.batch_no, mrp, purchase_price };
  let batch = await tx.batch.findUnique({ where: { product_id_batch_no_mrp_purchase_price: key } });
  if (!batch) {
    try {
      batch = await tx.batch.create({
        data: {
          business_id: businessId, ...key, supplier_id: supplierId || null,
          expiry_date: item.expiry_date || null, mfg_date: item.mfg_date || null, sale_price: item.batch_sale_price ?? null, quantity: 0,
        },
      });
    } catch (err) {
      if (err && err.code === 'P2002') batch = await tx.batch.findUnique({ where: { product_id_batch_no_mrp_purchase_price: key } }); // made a moment ago by someone else
      else throw err;
    }
  }
  if (!batch || batch.business_id !== businessId) throw new HttpError(400, 'Batch not found', 'VALIDATION');
  if (item.expiry_date && batch.expiry_date && fmtDay(item.expiry_date) !== fmtDay(batch.expiry_date)) {
    throw new HttpError(409, `Batch ${batch.batch_no} of ${product.name} already exists with expiry ${fmtDay(batch.expiry_date)}, not ${fmtDay(item.expiry_date)}. Check the batch number and expiry.`, 'BATCH_EXPIRY_MISMATCH');
  }
  const fill = {};
  if (item.expiry_date && !batch.expiry_date) fill.expiry_date = item.expiry_date;
  if (item.mfg_date && !batch.mfg_date) fill.mfg_date = item.mfg_date;
  if (item.batch_sale_price != null) fill.sale_price = item.batch_sale_price;
  if (Object.keys(fill).length) await tx.batch.update({ where: { id: batch.id }, data: fill });
  return batch.id;
}

// direction +1 = add, -1 = remove. Quantity moved is the billed quantity plus any free pieces. Returns warnings for products
// and batches that went below zero (selling before receiving is common in small shops, so this warns instead of blocking).
// ctx.supplierId: the supplier of a purchase being posted (recorded on the batch it creates).
async function adjustInventory(tx, businessId, items, direction, ctx = {}) {
  const perProduct = new Map();
  for (const item of items) {
    if (!item.product_id) continue;
    perProduct.set(item.product_id, (perProduct.get(item.product_id) || 0) + Number(item.quantity) + Number(item.free_qty || 0));
  }
  if (perProduct.size === 0) return [];

  await lockRows(tx, 'product', [...perProduct.keys()]);
  const products = await tx.product.findMany({
    where: { id: { in: [...perProduct.keys()] }, business_id: businessId },
    select: { id: true, name: true, mrp: true, track_inventory: true, track_batches: true, stock_quantity: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const warnings = [];
  for (const product of products) {
    if (!product.track_inventory) continue;
    const delta = direction * perProduct.get(product.id);
    const after = product.stock_quantity + delta;
    await tx.product.update({ where: { id: product.id }, data: { stock_quantity: { increment: delta } } });
    if (after < 0) warnings.push({ product_id: product.id, name: product.name, stock_after: after });
  }

  // the same movement, line by line, on the batches
  const batchLines = items.filter((i) => i.product_id && byId.get(i.product_id)?.track_batches);
  await lockRows(tx, 'batch', batchLines.map((i) => i.batch_id));
  for (const item of batchLines) {
    const product = byId.get(item.product_id);
    let batchId = item.batch_id;
    if (!batchId) {
      if (direction > 0 && item.batch_no) {
        batchId = await upsertBatchFromLine(tx, businessId, product, item, ctx.supplierId);
        await tx.invoiceItem.update({ where: { id: item.id }, data: { batch_id: batchId } });
        await lockRows(tx, 'batch', [batchId]);
      } else {
        throw new HttpError(400, `Choose a batch for ${product.name}`, 'BATCH_REQUIRED', { product_id: product.id });
      }
    }
    const batch = await tx.batch.findFirst({ where: { id: batchId, business_id: businessId, product_id: product.id } });
    if (!batch) throw new HttpError(400, `Batch for ${product.name} was not found`, 'VALIDATION');
    const delta = direction * (Number(item.quantity) + Number(item.free_qty || 0));
    const after = batch.quantity + delta;
    await tx.batch.update({ where: { id: batch.id }, data: { quantity: { increment: delta } } });
    if (after < 0) warnings.push({ product_id: product.id, name: product.name, batch_no: batch.batch_no, stock_after: after, batch: true });
  }
  return warnings;
}

// Checks the batch details on the lines of a bill being created or edited, fills in the snapshots (batch number, expiry, MRP, cost)
// and returns MRP warnings. Mutates `lines` (they are what gets saved).
//   business: { business_type, rates_include_gst }   user: { role }
async function validateBatchLines(tx, { businessId, business, user, voucher_type, lines }) {
  const ids = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];
  const products = ids.length ? await tx.product.findMany({ where: { id: { in: ids }, business_id: businessId }, select: { id: true, name: true, mrp: true, track_batches: true } }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const today = todayDate();
  const isOwner = user && user.role === 'owner';
  const mrpWarnings = [];

  for (const line of lines) {
    const product = line.product_id ? byId.get(line.product_id) : null;
    if (!product || !product.track_batches) {
      // not a batch item: nothing batch-related is kept (free pieces and MRP still are)
      Object.assign(line, { batch_id: null, batch_no: null, expiry_date: null, mfg_date: null, batch_sale_price: null, expired_override_reason: null });
      if (line.mrp == null && product && product.mrp) line.mrp = product.mrp;
    } else if (voucher_type === 'PURCHASE') {
      if (!line.batch_no) throw new HttpError(400, `Enter the batch number for ${product.name}`, 'BATCH_REQUIRED', { product_id: product.id });
      if (business.business_type === 'medical' && !line.expiry_date) throw new HttpError(400, `Enter the expiry date for ${product.name}`, 'EXPIRY_REQUIRED', { product_id: product.id });
      if (line.expiry_date && line.mfg_date && line.mfg_date > line.expiry_date) throw new HttpError(400, `${product.name}: manufacturing date is after the expiry date`, 'VALIDATION');
      if (line.mrp == null) line.mrp = product.mrp || 0;
      line.batch_id = null; // made when the bill is posted
      line.expired_override_reason = null;
    } else if (voucher_type === 'ESTIMATE' && !line.batch_id) {
      line.batch_no = null; line.expiry_date = null; line.mfg_date = null; line.expired_override_reason = null;
    } else {
      if (!line.batch_id) throw new HttpError(400, `Choose a batch for ${product.name}`, 'BATCH_REQUIRED', { product_id: product.id });
      const batch = await tx.batch.findFirst({ where: { id: line.batch_id, business_id: businessId, product_id: product.id } });
      if (!batch) throw new HttpError(400, `That batch does not belong to ${product.name}`, 'VALIDATION');
      Object.assign(line, { batch_no: batch.batch_no, expiry_date: batch.expiry_date, mfg_date: batch.mfg_date, mrp: batch.mrp, cost_price: batch.purchase_price });
      if (voucher_type === 'SALE' && isExpired(batch.expiry_date, today)) {
        const msg = `${product.name} batch ${batch.batch_no} expired on ${fmtDay(batch.expiry_date)}`;
        if (!isOwner) throw new HttpError(422, `${msg}. It cannot be sold; ask the owner.`, 'EXPIRED_BATCH', { batch_id: batch.id, expiry_date: fmtDay(batch.expiry_date) });
        if (!line.expired_override_reason) throw new HttpError(422, `${msg}. Selling it needs a reason.`, 'EXPIRED_BATCH_REASON_REQUIRED', { batch_id: batch.id, expiry_date: fmtDay(batch.expiry_date) });
      } else {
        line.expired_override_reason = null; // only kept when it was really used
      }
    }
    if (voucher_type === 'SALE' || voucher_type === 'ESTIMATE') {
      const mrp = line.mrp;
      if (mrp > 0) {
        const unitPrice = business.rates_include_gst ? line.rate : line.rate * (1 + line.tax_rate / 100);
        if (unitPrice > mrp + 0.5) mrpWarnings.push({ description: line.description, rate: line.rate, mrp, price_with_gst: Math.round(unitPrice) });
      }
    }
  }
  return mrpWarnings;
}

// When a saved draft is sent: the batch may have expired since it was drafted.
async function assertSaleBatchesSellable(tx, items) {
  const ids = [...new Set(items.filter((i) => i.batch_id && !i.expired_override_reason).map((i) => i.batch_id))];
  if (!ids.length) return;
  const batches = await tx.batch.findMany({ where: { id: { in: ids } }, select: { id: true, batch_no: true, expiry_date: true } });
  const today = todayDate();
  const bad = batches.find((b) => isExpired(b.expiry_date, today));
  if (bad) throw new HttpError(422, `Batch ${bad.batch_no} expired on ${fmtDay(bad.expiry_date)}. Change the batch on that line before sending.`, 'EXPIRED_BATCH', { batch_id: bad.id });
}

module.exports = { adjustInventory, validateBatchLines, assertSaleBatchesSellable, upsertBatchFromLine, isExpired, unitCostOf, BATCH_VOUCHERS };
