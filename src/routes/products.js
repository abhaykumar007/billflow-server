const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { rupeesToPaise, pageParams } = require('../utils/validate');
const { lockRow } = require('../utils/lock');
const { normalizeCode, codeProblem } = require('../utils/barcode');

// Medical / FMCG fields. Money in rupees here, like the other product fields (the response is in paise).
const SCHEDULES = ['H', 'H1', 'X', 'NARCOTIC', 'OTC'];
function medFields(body) {
  const out = {};
  if ('mrp' in body) out.mrp = rupeesToPaise(body.mrp ?? 0, 'MRP');
  if ('track_batches' in body) out.track_batches = Boolean(body.track_batches);
  const text = (k, max) => { if (k in body) out[k] = body[k] == null || String(body[k]).trim() === '' ? null : String(body[k]).trim().slice(0, max); };
  text('pack_size', 40); text('manufacturer', 100); text('composition', 300);
  if ('schedule' in body) {
    const v = body.schedule == null || body.schedule === '' ? null : String(body.schedule).trim().toUpperCase();
    if (v && !SCHEDULES.includes(v)) throw new HttpError(400, `Schedule must be one of ${SCHEDULES.join(', ')}`, 'VALIDATION');
    out.schedule = v;
  }
  return out;
}
// The stock an item already has becomes its first batch when batch tracking is switched on.
const openingBatch = (business_id, product) => ({
  business_id, product_id: product.id, batch_no: 'OPENING', mrp: product.mrp || product.sale_price || 0, purchase_price: product.purchase_price || 0,
  quantity: product.stock_quantity, is_opening: true,
});

const WITH_BARCODES = { select: { id: true, code: true, kind: true }, orderBy: { created_at: 'asc' } };

const num =(v, field, { min = 0, max = 1e9 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid ${field}`, 'VALIDATION');
  return n;
};

async function assertCategory(client, businessId, categoryId) {
  if (!categoryId) return null;
  const c = await client.productCategory.findFirst({ where: { id: categoryId, business_id: businessId, is_deleted: false }, select: { id: true } });
  if (!c) throw new HttpError(404, 'Category not found', 'NOT_FOUND');
  return c.id;
}

router.use(authenticateToken);

// GET /api/products/low-stock — must be before /:id
// Prisma doesn't support column-to-column comparisons in where, so filter in JS
router.get('/low-stock', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const products = await prisma.product.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        is_active: true,
        track_inventory: true,
      },
    });
    return res.json(products.filter((p) => p.stock_quantity <= p.low_stock_alert));
  } catch (err) {
    console.error('Low stock error:', err);
    return res.status(500).json({ error: 'Failed to fetch low stock products' });
  }
});

// GET /api/products — list with search + pagination
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { search = '', active } = req.query;
    const { page, limit, skip } = pageParams(req.query, 100, 500);

    const { category_id } = req.query;

    const where = {
      business_id: businessId,
      is_deleted: false,
      ...(active !== undefined && { is_active: active === 'true' }),
      ...(category_id === 'none'
        ? { category_id: null }
        : category_id
        ? { category_id }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { hsn_code: { contains: search, mode: 'insensitive' } },
              // typing or scanning a barcode finds the item too
              ...(normalizeCode(search) ? [{ barcodes: { some: { code: { contains: normalizeCode(search) } } } }] : []),
            ],
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: { category: { select: { id: true, name: true, color: true } }, barcodes: WITH_BARCODES },
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({ products, total, page, limit });
  } catch (err) {
    console.error('List products error:', err);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id
// ── Moving existing items to batch tracking ─────────────────────────────────────
// GET  /api/products/batch-migration   what would change (nothing is changed)
// POST /api/products/batch-migration   { only_with_stock?, product_ids? }  turn batch tracking on for the items that do not have it yet.
// Each item's current stock becomes one "OPENING" batch (MRP and cost taken from the item), so the batches add up to the stock the
// item already had. Owner only. Running it again only touches items that are still untracked.
const untrackedWhere = (businessId, { onlyWithStock, ids } = {}) => ({
  business_id: businessId, is_deleted: false, track_batches: false,
  ...(onlyWithStock ? { stock_quantity: { not: 0 } } : {}),
  ...(ids ? { id: { in: ids } } : {}),
});

router.get('/batch-migration', requireRole('owner'), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const onlyWithStock = req.query.only_with_stock === '1';
    const where = untrackedWhere(businessId, { onlyWithStock });
    const [total, withStock, tracked, sample] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.count({ where: { ...where, stock_quantity: { not: 0 } } }),
      prisma.product.count({ where: { business_id: businessId, is_deleted: false, track_batches: true } }),
      prisma.product.findMany({ where, orderBy: { name: 'asc' }, take: 10, select: { id: true, name: true, unit: true, stock_quantity: true, mrp: true, purchase_price: true, sale_price: true } }),
    ]);
    const agg = await prisma.product.aggregate({ where: { ...where, stock_quantity: { gt: 0 } }, _sum: { stock_quantity: true } });
    return res.json({ items_to_move: total, items_with_stock: withStock, already_tracking: tracked, stock_units: agg._sum.stock_quantity || 0, sample });
  } catch (err) {
    console.error('Batch migration preview error:', err);
    return res.status(500).json({ error: 'Failed to check the items' });
  }
});

router.post('/batch-migration', requireRole('owner'), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const body = req.body || {};
    const ids = Array.isArray(body.product_ids) ? body.product_ids.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 5000) : undefined;
    if (Array.isArray(body.product_ids) && !ids.length) return res.status(400).json({ error: 'No valid items were chosen', code: 'VALIDATION' });
    const todo = await prisma.product.findMany({ where: untrackedWhere(businessId, { onlyWithStock: body.only_with_stock === true, ids }), select: { id: true }, orderBy: { name: 'asc' } });
    let converted = 0; let batches = 0; let units = 0; let skipped = 0;
    for (const { id } of todo) {
      // one item at a time, so billing is only held up for a moment and a failure leaves the others done
      // eslint-disable-next-line no-await-in-loop
      await prisma.$transaction(async (tx) => {
        await lockRow(tx, 'product', id);
        const p = await tx.product.findFirst({ where: { id, business_id: businessId, is_deleted: false } });
        if (!p || p.track_batches) { skipped += 1; return; }
        const updated = await tx.product.update({ where: { id }, data: { track_batches: true, track_inventory: true } });
        if (updated.stock_quantity !== 0) { await tx.batch.create({ data: openingBatch(businessId, updated) }); batches += 1; if (updated.stock_quantity > 0) units += updated.stock_quantity; }
        converted += 1;
      }, { timeout: 15000 });
    }
    console.info(`[audit] batch migration: ${converted} items moved by user ${req.user.userId}`);
    return res.json({ converted, skipped, opening_batches_created: batches, stock_units: units });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('Batch migration error:', err);
    return res.status(500).json({ error: 'The move stopped part-way. Items already moved stay moved; run it again for the rest.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      include: { category: { select: { id: true, name: true, color: true } }, barcodes: WITH_BARCODES },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.json(product);
  } catch (err) {
    console.error('Get product error:', err);
    return res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /api/products — create
router.post('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const {
      name,
      description,
      unit = 'pcs',
      sale_price = 0,
      purchase_price = 0,
      tax_rate = 18,
      hsn_code,
      track_inventory = false,
      stock_quantity = 0,
      low_stock_alert = 10,
      category_id,
    } = req.body;
    const med = medFields(req.body);

    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });

    const duplicate = await prisma.product.findFirst({
      where: { business_id: businessId, name: { equals: name.trim(), mode: 'insensitive' }, is_deleted: false },
    });
    if (duplicate) return res.status(409).json({ error: `A product named "${duplicate.name}" already exists` });

    // optional: create the item together with the barcode that was just scanned
    let barcode = null;
    if (req.body.barcode !== undefined && req.body.barcode !== null && req.body.barcode !== '') {
      barcode = normalizeCode(req.body.barcode);
      const problem = codeProblem(barcode);
      if (problem) throw new HttpError(400, problem, 'VALIDATION');
      const taken = await prisma.productBarcode.findFirst({ where: { business_id: businessId, code: barcode }, include: { product: { select: { name: true, is_deleted: true } } } });
      if (taken && !taken.product.is_deleted) throw new HttpError(409, `This barcode is already used by "${taken.product.name}"`, 'BARCODE_IN_USE');
      if (taken) await prisma.productBarcode.delete({ where: { id: taken.id } });
    }

    const product = await prisma.product.create({
      data: {
        business_id: businessId,
        name: name.trim().slice(0, 150),
        description: description?.trim() || null,
        unit: String(unit).slice(0, 20),
        sale_price: rupeesToPaise(sale_price, 'sale price'),         // rupees → paise
        purchase_price: rupeesToPaise(purchase_price, 'purchase price'),
        tax_rate: num(tax_rate, 'GST %', { max: 100 }),
        hsn_code: hsn_code?.trim() || null,
        ...med,
        track_inventory: Boolean(track_inventory) || med.track_batches === true, // batches need stock tracking
        stock_quantity: (track_inventory || med.track_batches) ? num(stock_quantity, 'stock quantity', { min: -1e9 }) : 0,
        low_stock_alert: Math.max(parseInt(low_stock_alert) || 0, 0),
        category_id: await assertCategory(prisma, businessId, category_id),
        ...(barcode ? { barcodes: { create: [{ business_id: businessId, code: barcode, kind: 'manufacturer' }] } } : {}),
      },
      include: { category: { select: { id: true, name: true, color: true } }, barcodes: WITH_BARCODES },
    });

    if (product.track_batches && product.stock_quantity !== 0) await prisma.batch.create({ data: openingBatch(businessId, product) });
    return res.status(201).json(product);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err && err.code === 'P2002') return res.status(409).json({ error: 'This barcode is already used by another item', code: 'BARCODE_IN_USE' });
    console.error('Create product error:', err);
    return res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /api/products/:id — update
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Product not found' });

    const {
      name,
      description,
      unit,
      sale_price,
      purchase_price,
      tax_rate,
      hsn_code,
      track_inventory,
      stock_quantity,
      low_stock_alert,
      is_active,
      category_id,
    } = req.body;
    const med = medFields(req.body);

    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Product name cannot be empty' });
    }

    if (name !== undefined) {
      const duplicate = await prisma.product.findFirst({
        where: { business_id: businessId, name: { equals: name.trim(), mode: 'insensitive' }, is_deleted: false, NOT: { id: req.params.id } },
      });
      if (duplicate) return res.status(409).json({ error: `A product named "${duplicate.name}" already exists` });
    }

    const categoryId = 'category_id' in req.body ? await assertCategory(prisma, businessId, category_id) : undefined;

    const turningOn = med.track_batches === true && !existing.track_batches;
    const updated = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'product', req.params.id); // serialise with invoices moving stock
      if (existing.track_batches && stock_quantity !== undefined && Number(stock_quantity) !== existing.stock_quantity) {
        throw new HttpError(400, 'Stock of a batch item changes through its batches (add stock or adjust a batch), so that the batches and the total always agree', 'VALIDATION');
      }
      if (med.track_batches === false && existing.track_batches) {
        throw new HttpError(400, 'Batch tracking cannot be turned off once it is on (it would lose the stock per batch)', 'VALIDATION');
      }
      const result = await tx.product.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined && { name: name.trim().slice(0, 150) }),
          ...(description !== undefined && { description: description?.trim() || null }),
          ...(unit !== undefined && { unit: String(unit).slice(0, 20) }),
          ...(sale_price !== undefined && { sale_price: rupeesToPaise(sale_price, 'sale price') }),
          ...(purchase_price !== undefined && { purchase_price: rupeesToPaise(purchase_price, 'purchase price') }),
          ...(tax_rate !== undefined && { tax_rate: num(tax_rate, 'GST %', { max: 100 }) }),
          ...(hsn_code !== undefined && { hsn_code: hsn_code?.trim() || null }),
          ...(track_inventory !== undefined && { track_inventory: Boolean(track_inventory) }),
          ...(stock_quantity !== undefined && { stock_quantity: num(stock_quantity, 'stock quantity', { min: -1e9 }) }),
          ...(low_stock_alert !== undefined && { low_stock_alert: Math.max(parseInt(low_stock_alert) || 0, 0) }),
          ...(is_active !== undefined && { is_active: Boolean(is_active) }),
          ...(categoryId !== undefined && { category_id: categoryId }),
          ...med,
          ...(med.track_batches === true && { track_inventory: true }),
        },
        include: { category: { select: { id: true, name: true, color: true } }, barcodes: WITH_BARCODES },
      });
      if (turningOn && result.stock_quantity !== 0) await tx.batch.create({ data: openingBatch(req.user.businessId, result) });
      return result;
    });
    if (stock_quantity !== undefined && Number(stock_quantity) !== existing.stock_quantity) {
      console.info(`[audit] stock of product ${existing.id} set ${existing.stock_quantity} -> ${stock_quantity} by user ${req.user.userId}`);
    }

    return res.json(updated);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('Update product error:', err);
    return res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/:id — soft delete
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await prisma.product.update({
      where: { id: req.params.id },
      data: { is_deleted: true },
    });
    // a deleted item gives its barcodes back, so the numbers can be used again
    await prisma.productBarcode.deleteMany({ where: { product_id: req.params.id } });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    return res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
