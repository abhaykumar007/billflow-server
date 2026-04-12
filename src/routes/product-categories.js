const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/product-categories — list all for this business
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const categories = await prisma.productCategory.findMany({
      where: { business_id: businessId, is_deleted: false },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: { where: { is_deleted: false } } } } },
    });
    return res.json(categories);
  } catch (err) {
    console.error('List categories error:', err);
    return res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// POST /api/product-categories — create
router.post('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { name, color = '#6366f1' } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });

    const category = await prisma.productCategory.create({
      data: { business_id: businessId, name: name.trim(), color },
    });
    return res.status(201).json(category);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Category name already exists' });
    console.error('Create category error:', err);
    return res.status(500).json({ error: 'Failed to create category' });
  }
});

// PUT /api/product-categories/:id — update name/color
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.productCategory.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const { name, color } = req.body || {};
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Category name cannot be empty' });

    const updated = await prisma.productCategory.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(color !== undefined && { color }),
      },
    });
    return res.json(updated);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Category name already exists' });
    console.error('Update category error:', err);
    return res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /api/product-categories/:id — soft delete (unlinks products)
router.delete('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.productCategory.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    await prisma.$transaction([
      // Unlink all products from this category
      prisma.product.updateMany({
        where: { category_id: req.params.id },
        data: { category_id: null },
      }),
      // Soft delete the category
      prisma.productCategory.update({
        where: { id: req.params.id },
        data: { is_deleted: true },
      }),
    ]);

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete category error:', err);
    return res.status(500).json({ error: 'Failed to delete category' });
  }
});

module.exports = router;
