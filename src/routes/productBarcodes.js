const express = require('express');
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { normalizeCode, codeProblem, checkDigitWarning, ownCodeFor } = require('../utils/barcode');
const { renderLabels, LAYOUTS, DEFAULT_LAYOUT } = require('../services/labelRenderer');

// Mounted on /api/products BEFORE the products router, so /by-barcode/:code is not read as a product id.
const router = express.Router();
router.use(authenticateToken);

const MAX_PER_ITEM = 10;
const MAX_ITEMS_PER_SHEET = 100;
const MAX_COPIES = 100;
const MAX_LABELS = 500;

const BARCODE_SELECT = { id: true, code: true, kind: true };
const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, color: true } },
  barcodes: { select: BARCODE_SELECT, orderBy: { created_at: 'asc' } },
};

function sendError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  if (err && err.code === 'P2002') return res.status(409).json({ error: 'This barcode is already used by another item', code: 'BARCODE_IN_USE' });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const findProduct = (businessId, id) => prisma.product.findFirst({ where: { id, business_id: businessId, is_deleted: false }, select: { id: true, name: true } });

function parseCode(raw) {
  const code = normalizeCode(raw);
  const problem = codeProblem(code);
  if (problem) throw new HttpError(400, problem, 'VALIDATION');
  return code;
}

// GET /api/products/label-layouts
router.get('/label-layouts', (req, res) => {
  res.json({ default: DEFAULT_LAYOUT, layouts: Object.entries(LAYOUTS).map(([id, l]) => ({ id, label: l.label })) });
});

// GET /api/products/by-barcode/:code  ->  the item this code belongs to (a scanner calls this)
router.get('/by-barcode/:code', async (req, res) => {
  try {
    const code = parseCode(req.params.code);
    const row = await prisma.productBarcode.findFirst({
      where: { business_id: req.user.businessId, code, product: { is_deleted: false } },
      include: { product: { include: PRODUCT_INCLUDE } },
    });
    if (!row) throw new HttpError(404, 'No item has this barcode', 'BARCODE_NOT_FOUND', { barcode: code });
    return res.json({ ...row.product, matched_code: code, matched_kind: row.kind });
  } catch (err) {
    return sendError(res, err, 'Failed to look up the barcode');
  }
});

// POST /api/products/labels  { items: [{ product_id, copies?, barcode_id? }], layout?, show_name?, show_price?, show_code? }
router.post('/labels', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const body = req.body || {};
    const items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_SHEET) {
      throw new HttpError(400, `Choose between 1 and ${MAX_ITEMS_PER_SHEET} items`, 'VALIDATION');
    }
    const wanted = [];
    let total = 0;
    for (const it of items) {
      const id = it && typeof it.product_id === 'string' ? it.product_id : '';
      const copies = it && it.copies !== undefined ? Number(it.copies) : 1;
      if (!id || !Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new HttpError(400, `Each item needs a product and 1 to ${MAX_COPIES} copies`, 'VALIDATION');
      total += copies;
      wanted.push({ id, copies, barcode_id: it && typeof it.barcode_id === 'string' ? it.barcode_id : null });
    }
    if (total > MAX_LABELS) throw new HttpError(400, `At most ${MAX_LABELS} labels at a time`, 'VALIDATION');
    const layout = typeof body.layout === 'string' && LAYOUTS[body.layout] ? body.layout : DEFAULT_LAYOUT;

    const products = await prisma.product.findMany({
      where: { id: { in: [...new Set(wanted.map((w) => w.id))] }, business_id: businessId, is_deleted: false },
      include: { barcodes: { select: BARCODE_SELECT, orderBy: { created_at: 'asc' } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const labels = [];
    const skipped = [];
    for (const w of wanted) {
      const p = byId.get(w.id);
      if (!p) { skipped.push({ product_id: w.id, name: null, reason: 'Item not found' }); continue; }
      const chosen = (w.barcode_id && p.barcodes.find((b) => b.id === w.barcode_id)) || p.barcodes[0];
      if (!chosen) { skipped.push({ product_id: p.id, name: p.name, reason: 'No barcode yet' }); continue; }
      for (let i = 0; i < w.copies; i += 1) labels.push({ name: p.name, code: chosen.code, price: p.sale_price });
    }
    if (!labels.length) throw new HttpError(400, 'None of these items has a barcode yet. Add or generate one first.', 'NO_BARCODES', { skipped });
    const html = renderLabels({ labels, layout, show_name: body.show_name, show_price: body.show_price, show_code: body.show_code });
    return res.json({ html, count: labels.length, layout, skipped });
  } catch (err) {
    return sendError(res, err, 'Failed to build the labels');
  }
});

// GET /api/products/:id/barcodes
router.get('/:id/barcodes', async (req, res) => {
  try {
    const product = await findProduct(req.user.businessId, req.params.id);
    if (!product) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
    const barcodes = await prisma.productBarcode.findMany({ where: { product_id: product.id }, select: BARCODE_SELECT, orderBy: { created_at: 'asc' } });
    return res.json({ barcodes });
  } catch (err) {
    return sendError(res, err, 'Failed to load barcodes');
  }
});

// POST /api/products/:id/barcodes/generate  ->  a new own EAN-13 code for this item
router.post('/:id/barcodes/generate', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await findProduct(businessId, req.params.id);
    if (!product) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
    if ((await prisma.productBarcode.count({ where: { product_id: product.id } })) >= MAX_PER_ITEM) {
      throw new HttpError(400, `An item can have at most ${MAX_PER_ITEM} barcodes`, 'VALIDATION');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // the counter moves forward inside the same transaction, so two shops/tabs never get the same number
      const created = await prisma.$transaction(async (tx) => {
        const b = await tx.business.update({ where: { id: businessId }, data: { barcode_next_number: { increment: 1 } }, select: { barcode_next_number: true } });
        const code = ownCodeFor(b.barcode_next_number - 1);
        if (await tx.productBarcode.findFirst({ where: { business_id: businessId, code }, select: { id: true } })) return null;
        return tx.productBarcode.create({ data: { business_id: businessId, product_id: product.id, code, kind: 'own' }, select: BARCODE_SELECT });
      });
      if (created) {
        const barcodes = await prisma.productBarcode.findMany({ where: { product_id: product.id }, select: BARCODE_SELECT, orderBy: { created_at: 'asc' } });
        return res.status(201).json({ barcode: created, barcodes });
      }
    }
    throw new HttpError(500, 'Could not make a free barcode, try again', 'BARCODE_GENERATE');
  } catch (err) {
    return sendError(res, err, 'Failed to generate a barcode');
  }
});

// POST /api/products/:id/barcodes  { code }  ->  attach the number printed on the pack
router.post('/:id/barcodes', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await findProduct(businessId, req.params.id);
    if (!product) throw new HttpError(404, 'Product not found', 'NOT_FOUND');
    const code = parseCode(req.body && req.body.code);
    if ((await prisma.productBarcode.count({ where: { product_id: product.id } })) >= MAX_PER_ITEM) {
      throw new HttpError(400, `An item can have at most ${MAX_PER_ITEM} barcodes`, 'VALIDATION');
    }
    const taken = await prisma.productBarcode.findFirst({ where: { business_id: businessId, code }, include: { product: { select: { id: true, name: true, is_deleted: true } } } });
    if (taken) {
      if (taken.product_id === product.id) throw new HttpError(409, 'This barcode is already on this item', 'BARCODE_IN_USE', { product_id: product.id });
      if (!taken.product.is_deleted) {
        throw new HttpError(409, `This barcode is already used by "${taken.product.name}"`, 'BARCODE_IN_USE', { product_id: taken.product.id, product_name: taken.product.name });
      }
      await prisma.productBarcode.delete({ where: { id: taken.id } }); // left over from a deleted item
    }
    const barcode = await prisma.productBarcode.create({ data: { business_id: businessId, product_id: product.id, code, kind: 'manufacturer' }, select: BARCODE_SELECT });
    const barcodes = await prisma.productBarcode.findMany({ where: { product_id: product.id }, select: BARCODE_SELECT, orderBy: { created_at: 'asc' } });
    const warning = checkDigitWarning(code);
    return res.status(201).json({ barcode, barcodes, warnings: warning ? [warning] : [] });
  } catch (err) {
    return sendError(res, err, 'Failed to add the barcode');
  }
});

// DELETE /api/products/:id/barcodes/:barcodeId
router.delete('/:id/barcodes/:barcodeId', async (req, res) => {
  try {
    const row = await prisma.productBarcode.findFirst({ where: { id: req.params.barcodeId, product_id: req.params.id, business_id: req.user.businessId } });
    if (!row) throw new HttpError(404, 'Barcode not found', 'NOT_FOUND');
    await prisma.productBarcode.delete({ where: { id: row.id } });
    return res.json({ success: true });
  } catch (err) {
    return sendError(res, err, 'Failed to remove the barcode');
  }
});

module.exports = router;
