const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);

// GET /api/expenses
router.get('/', attachFinancialYear, async (req, res) => {
  const { category, from, to, limit = 50, offset = 0 } = req.query;
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_deleted: false };
  if (req.financialYear) where.financial_year_id = req.financialYear.id;
  if (category) where.category = category;
  if (from || to) {
    where.expense_date = {};
    if (from) where.expense_date.gte = new Date(from);
    if (to) where.expense_date.lte = new Date(to + 'T23:59:59');
  }

  try {
    const [expenses, total, totalAmount] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: { expense_date: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);

    return res.json({ expenses, total, totalAmount: totalAmount._sum.amount || 0 });
  } catch (err) {
    console.error('Expenses list error:', err);
    return res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// POST /api/expenses
router.post('/', attachFinancialYear, async (req, res) => {
  const { category, amount, payment_mode, description, expense_date, receipt_url } = req.body;
  const businessId = req.user.businessId;

  if (!category || !category.trim()) return res.status(400).json({ error: 'Category is required' });
  const amountPaise = Math.round(parseFloat(amount) * 100);
  if (!amountPaise || amountPaise <= 0) return res.status(400).json({ error: 'Amount must be positive' });

  try {
    const expense = await prisma.expense.create({
      data: {
        business_id: businessId,
        financial_year_id: req.financialYear?.id || null,
        category: category.trim(),
        amount: amountPaise,
        payment_mode: payment_mode || 'cash',
        description: description || null,
        expense_date: expense_date ? new Date(expense_date) : new Date(),
        receipt_url: receipt_url || null,
      },
    });
    return res.status(201).json(expense);
  } catch (err) {
    console.error('Create expense error:', err);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  const { category, amount, payment_mode, description, expense_date, receipt_url } = req.body;
  const businessId = req.user.businessId;

  try {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, business_id: businessId },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });

    const data = {};
    if (category !== undefined) data.category = category.trim();
    if (amount !== undefined) data.amount = Math.round(parseFloat(amount) * 100);
    if (payment_mode !== undefined) data.payment_mode = payment_mode;
    if (description !== undefined) data.description = description || null;
    if (expense_date !== undefined) data.expense_date = new Date(expense_date);
    if (receipt_url !== undefined) data.receipt_url = receipt_url || null;

    const expense = await prisma.expense.update({ where: { id: req.params.id }, data });
    return res.json(expense);
  } catch (err) {
    console.error('Update expense error:', err);
    return res.status(500).json({ error: 'Failed to update expense' });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    await prisma.expense.update({
      where: { id: req.params.id },
      data: { is_deleted: true, deleted_at: new Date() },
    });
    return res.json({ message: 'Expense deleted' });
  } catch (err) {
    console.error('Delete expense error:', err);
    return res.status(500).json({ error: 'Failed to delete expense' });
  }
});

module.exports = router;
