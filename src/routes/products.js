const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

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
    const { search = '', page = 1, limit = 100, active } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

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
            ],
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: parseInt(limit),
        include: { category: { select: { id: true, name: true, color: true } } },
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({ products, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('List products error:', err);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      include: { category: { select: { id: true, name: true, color: true } } },
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

    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });

    const product = await prisma.product.create({
      data: {
        business_id: businessId,
        name: name.trim(),
        description: description?.trim() || null,
        unit,
        sale_price: Math.round((sale_price || 0) * 100),       // rupees → paise
        purchase_price: Math.round((purchase_price || 0) * 100),
        tax_rate: parseFloat(tax_rate) || 0,
        hsn_code: hsn_code?.trim() || null,
        track_inventory: Boolean(track_inventory),
        stock_quantity: track_inventory ? parseInt(stock_quantity) || 0 : 0,
        low_stock_alert: parseInt(low_stock_alert) || 10,
        category_id: category_id || null,
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    return res.status(201).json(product);
  } catch (err) {
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

    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Product name cannot be empty' });
    }

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(unit !== undefined && { unit }),
        ...(sale_price !== undefined && { sale_price: Math.round(sale_price * 100) }),
        ...(purchase_price !== undefined && { purchase_price: Math.round(purchase_price * 100) }),
        ...(tax_rate !== undefined && { tax_rate: parseFloat(tax_rate) }),
        ...(hsn_code !== undefined && { hsn_code: hsn_code?.trim() || null }),
        ...(track_inventory !== undefined && { track_inventory: Boolean(track_inventory) }),
        ...(stock_quantity !== undefined && { stock_quantity: parseInt(stock_quantity) }),
        ...(low_stock_alert !== undefined && { low_stock_alert: parseInt(low_stock_alert) }),
        ...(is_active !== undefined && { is_active: Boolean(is_active) }),
        ...('category_id' in req.body && { category_id: category_id || null }),
      },
      include: { category: { select: { id: true, name: true, color: true } } },
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update product error:', err);
    return res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/:id — soft delete
router.delete('/:id', async (req, res) => {
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

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete product error:', err);
    return res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
