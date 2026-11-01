const express = require('express');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { lockRow, lockRows } = require('../utils/lock');
const { normalizeBatchNo, INT32_MAX } = require('../utils/money');
const { todayDate } = require('../utils/time');
const { isExpired } = require('../services/stock');

// Batches of items that are tracked per batch (medical / FMCG). Money here is in paise, like bills.
const router = express.Router();
// (auth is per route: this router is mounted at /api, so a router-wide check would also catch unrelated paths)

const dayMs = 24 * 60 * 60 * 1000;
const fmtDay = (d) => new Date(d).toISOString().slice(0, 10);

function parseDay(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!d || Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1 || +m[1] < 2000 || +m[1] > 2100) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  return d;
}
function paise(raw, field, { optional = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (optional) return null;
    throw new HttpError(400, `${field} is required`, 'VALIDATION');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > INT32_MAX) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  return Math.round(n);
}
const qty = (raw, field = 'quantity') => {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  return n;
};

function view(b, today = todayDate()) {
  return {
    ...b,
    expired: isExpired(b.expiry_date, today),
    days_to_expiry: b.expiry_date ? Math.round((new Date(b.expiry_date).getTime() - today.getTime()) / dayMs) : null,
  };
}
const sortBatches = (rows) => rows.sort((a, b) => {
  const ax = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity; const bx = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
  return ax - bx || new Date(a.created_at) - new Date(b.created_at);
});

function sendError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  if (err && err.code === 'P2002') return res.status(409).json({ error: 'A batch with this number, MRP and cost already exists for this item', code: 'BATCH_EXISTS' });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const findProduct = (businessId, id) => prisma.product.findFirst({ where: { id, business_id: businessId, is_deleted: false }, select: { id: true, name: true, track_batches: true, track_inventory: true } });

// GET /api/products/:id/batches[?all=1]  -> the item's batches, earliest expiry first (empty ones only with all=1)
router.get('/products/:id/batches', authenticateToken, async (req, res) => {
  try {
    const product = await findProduct(req.user.businessId, req.params.id);
    if (!product) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
    const rows = await prisma.batch.findMany({ where: { product_id: product.id, business_id: req.user.businessId, ...(req.query.all === '1' ? {} : { quantity: { not: 0 } }) } });
    return res.json({ track_batches: product.track_batches, batches: sortBatches(rows).map((b) => view(b)) });
  } catch (err) { return sendError(res, err, 'Failed to load batches'); }
});

// POST /api/products/:id/batches  { batch_no, expiry_date?, mfg_date?, mrp, purchase_price, sale_price?, quantity }  -> add stock as a batch
router.post('/products/:id/batches', authenticateToken, requireRole(...MANAGERS), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await findProduct(businessId, req.params.id);
    if (!product) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
    if (!product.track_batches) throw new HttpError(400, 'Turn on batch tracking for this item first', 'VALIDATION');
    const b = req.body || {};
    if (!b.batch_no) throw new HttpError(400, 'Batch number is required', 'VALIDATION');
    const batch_no = normalizeBatchNo(b.batch_no);
    const q = qty(b.quantity);
    if (q <= 0) throw new HttpError(400, 'Quantity must be more than zero', 'VALIDATION');
    const key = { product_id: product.id, batch_no, mrp: paise(b.mrp ?? 0, 'MRP'), purchase_price: paise(b.purchase_price ?? 0, 'purchase price') };
    const expiry = parseDay(b.expiry_date, 'expiry date'); const mfg = parseDay(b.mfg_date, 'manufacturing date');
    if (expiry && mfg && mfg > expiry) throw new HttpError(400, 'Manufacturing date is after the expiry date', 'VALIDATION');
    const sale_price = paise(b.sale_price, 'selling price', { optional: true });

    const batch = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'product', product.id);
      let existing = await tx.batch.findUnique({ where: { product_id_batch_no_mrp_purchase_price: key } });
      if (existing) {
        if (expiry && existing.expiry_date && fmtDay(expiry) !== fmtDay(existing.expiry_date)) {
          throw new HttpError(409, `Batch ${batch_no} already exists with expiry ${fmtDay(existing.expiry_date)}, not ${fmtDay(expiry)}. Check the batch number and expiry.`, 'BATCH_EXPIRY_MISMATCH');
        }
        await lockRows(tx, 'batch', [existing.id]);
        existing = await tx.batch.update({ where: { id: existing.id }, data: { quantity: { increment: q }, ...(expiry && !existing.expiry_date ? { expiry_date: expiry } : {}), ...(sale_price != null ? { sale_price } : {}) } });
      } else {
        existing = await tx.batch.create({ data: { business_id: businessId, ...key, expiry_date: expiry, mfg_date: mfg, sale_price, quantity: q } });
      }
      await tx.product.update({ where: { id: product.id }, data: { stock_quantity: { increment: q } } });
      return existing;
    });
    console.info(`[audit] batch ${batch.id} (${batch_no}) of product ${product.id} +${q} by user ${req.user.userId}`);
    return res.status(201).json(view(batch));
  } catch (err) { return sendError(res, err, 'Failed to add the batch'); }
});

// GET /api/batches?product_id=&expired=1&expiring_within=90&include_empty=1&page=&limit=  -> batches across items (earliest expiry first)
router.get('/batches', authenticateToken, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const today = todayDate();
    const where = { business_id: businessId, product: { is_deleted: false } };
    if (req.query.product_id) where.product_id = String(req.query.product_id);
    if (req.query.include_empty !== '1') where.quantity = { gt: 0 };
    if (req.query.expired === '1') where.expiry_date = { lt: today };
    else if (req.query.expiring_within !== undefined) {
      const days = Math.min(Math.max(parseInt(req.query.expiring_within, 10) || 0, 0), 3650);
      where.expiry_date = { gte: today, lte: new Date(today.getTime() + days * dayMs) };
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const [rows, total] = await Promise.all([
      prisma.batch.findMany({ where, include: { product: { select: { id: true, name: true, unit: true } } }, orderBy: [{ expiry_date: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }], skip: (page - 1) * limit, take: limit }),
      prisma.batch.count({ where }),
    ]);
    return res.json({ batches: rows.map((b) => view(b, today)), total, page, limit });
  } catch (err) { return sendError(res, err, 'Failed to load batches'); }
});

// PUT /api/batches/:id  { expiry_date?, mfg_date?, sale_price? }  (number, MRP and cost never change: they identify the batch)
router.put('/batches/:id', authenticateToken, requireRole(...MANAGERS), async (req, res) => {
  try {
    const batch = await prisma.batch.findFirst({ where: { id: req.params.id, business_id: req.user.businessId } });
    if (!batch) throw new HttpError(404, 'Batch not found', 'NOT_FOUND');
    const b = req.body || {}; const data = {};
    if ('expiry_date' in b) data.expiry_date = parseDay(b.expiry_date, 'expiry date');
    if ('mfg_date' in b) data.mfg_date = parseDay(b.mfg_date, 'manufacturing date');
    if ('sale_price' in b) data.sale_price = paise(b.sale_price, 'selling price', { optional: true });
    const expiry = 'expiry_date' in data ? data.expiry_date : batch.expiry_date; const mfg = 'mfg_date' in data ? data.mfg_date : batch.mfg_date;
    if (expiry && mfg && mfg > expiry) throw new HttpError(400, 'Manufacturing date is after the expiry date', 'VALIDATION');
    const updated = await prisma.batch.update({ where: { id: batch.id }, data });
    return res.json(view(updated));
  } catch (err) { return sendError(res, err, 'Failed to update the batch'); }
});

// POST /api/batches/:id/adjust  { quantity_delta, reason }  -> a correction or write-off (damaged, expired, found), always with a reason
router.post('/batches/:id/adjust', authenticateToken, requireRole(...MANAGERS), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const batch = await prisma.batch.findFirst({ where: { id: req.params.id, business_id: businessId } });
    if (!batch) throw new HttpError(404, 'Batch not found', 'NOT_FOUND');
    const delta = qty((req.body || {}).quantity_delta, 'quantity change');
    if (delta === 0) throw new HttpError(400, 'Quantity change cannot be zero', 'VALIDATION');
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
    if (!reason) throw new HttpError(400, 'A reason is required (for example: expired, damaged, counted)', 'VALIDATION');
    const updated = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'product', batch.product_id);
      await lockRows(tx, 'batch', [batch.id]);
      const out = await tx.batch.update({ where: { id: batch.id }, data: { quantity: { increment: delta } } });
      await tx.product.update({ where: { id: batch.product_id }, data: { stock_quantity: { increment: delta } } });
      return out;
    });
    console.info(`[audit] batch ${batch.id} (${batch.batch_no}) ${delta > 0 ? '+' : ''}${delta} "${reason}" by user ${req.user.userId}`);
    return res.json(view(updated));
  } catch (err) { return sendError(res, err, 'Failed to adjust the batch'); }
});

module.exports = router;
