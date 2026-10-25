const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { attachFinancialYear, requireUnlockedFY, enforceOpenYear } = require('../middleware/financialYear');
const { HttpError } = require('../utils/httpError');
const { rupeesToPaise } = require('../utils/validate');
const { parseDayStart, parseDayEnd, isValidDate, todayDate } = require('../utils/time');
const { assertFyWritable, assertDateInFY, assertRecordFyWritable } = require('../utils/ledger');

router.use(authenticateToken);

const MODE_RE = /^[a-z_]{2,20}$/;

async function resolveBankAccount(client, businessId, id) {
  if (!id) return null;
  const acc = await client.bankAccount.findFirst({
    where: { id, business_id: businessId, is_deleted: false, is_active: true },
    select: { id: true },
  });
  if (!acc) throw new HttpError(404, 'Bank account not found', 'NOT_FOUND');
  return acc.id;
}

function parseMode(mode, fallback = 'cash') {
  const m = String(mode || fallback).trim().toLowerCase();
  if (!MODE_RE.test(m)) throw new HttpError(400, 'Invalid payment_mode', 'VALIDATION');
  return m;
}

// GET /api/expenses
router.get('/', attachFinancialYear, async (req, res) => {
  const { category, from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_deleted: false };
  if (req.financialYear) where.financial_year_id = req.financialYear.id;
  if (category) where.category = category;
  if (from || to) {
    where.expense_date = {};
    if (from) where.expense_date.gte = parseDayStart(from);
    if (to) where.expense_date.lte = parseDayEnd(to);
  }

  const [expenses, total, totalAmount] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { bankAccount: { select: { id: true, account_name: true } } },
      orderBy: [{ expense_date: 'desc' }, { created_at: 'desc' }],
      take: limit,
      skip: offset,
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  return res.json({ expenses, total, totalAmount: totalAmount._sum.amount || 0 });
});

// POST /api/expenses   (amount in rupees)
router.post('/', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const { category, amount, payment_mode, description, expense_date, receipt_url, bank_account_id } = req.body;
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  assertFyWritable(fy);

  if (!category || !String(category).trim()) throw new HttpError(400, 'Category is required', 'VALIDATION');
  const amountPaise = rupeesToPaise(amount, 'amount', { allowZero: false });
  const date = expense_date ? parseDayStart(expense_date) : todayDate();
  if (!isValidDate(date)) throw new HttpError(400, 'Invalid expense_date', 'VALIDATION');
  assertDateInFY(date, fy);
  if (receipt_url && !/^https:\/\//i.test(receipt_url)) throw new HttpError(400, 'Receipt URL must start with https://', 'VALIDATION');

  const expense = await prisma.expense.create({
    data: {
      business_id: businessId,
      financial_year_id: fy.id,
      category: String(category).trim().slice(0, 80),
      amount: amountPaise,
      payment_mode: parseMode(payment_mode),
      bank_account_id: await resolveBankAccount(prisma, businessId, bank_account_id),
      description: description ? String(description).slice(0, 500) : null,
      expense_date: date,
      receipt_url: receipt_url || null,
    },
  });
  return res.status(201).json(expense);
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  const { category, amount, payment_mode, description, expense_date, receipt_url, bank_account_id } = req.body;
  const businessId = req.user.businessId;

  const existing = await prisma.expense.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) throw new HttpError(404, 'Expense not found', 'NOT_FOUND');
  const fy = await assertRecordFyWritable(prisma, existing.financial_year_id);

  const data = {};
  if (category !== undefined) {
    if (!String(category).trim()) throw new HttpError(400, 'Category is required', 'VALIDATION');
    data.category = String(category).trim().slice(0, 80);
  }
  if (amount !== undefined) data.amount = rupeesToPaise(amount, 'amount', { allowZero: false });
  if (payment_mode !== undefined) data.payment_mode = parseMode(payment_mode);
  if (description !== undefined) data.description = description ? String(description).slice(0, 500) : null;
  if (expense_date !== undefined) {
    const d = parseDayStart(expense_date);
    if (!isValidDate(d)) throw new HttpError(400, 'Invalid expense_date', 'VALIDATION');
    if (fy) assertDateInFY(d, fy);
    data.expense_date = d;
  }
  if (receipt_url !== undefined) {
    if (receipt_url && !/^https:\/\//i.test(receipt_url)) throw new HttpError(400, 'Receipt URL must start with https://', 'VALIDATION');
    data.receipt_url = receipt_url || null;
  }
  if (bank_account_id !== undefined) data.bank_account_id = await resolveBankAccount(prisma, businessId, bank_account_id);

  const expense = await prisma.expense.update({ where: { id: req.params.id }, data });
  return res.json(expense);
});

// DELETE /api/expenses/:id
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  const businessId = req.user.businessId;
  const existing = await prisma.expense.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) throw new HttpError(404, 'Expense not found', 'NOT_FOUND');
  await assertRecordFyWritable(prisma, existing.financial_year_id);

  await prisma.expense.update({
    where: { id: req.params.id },
    data: { is_deleted: true, deleted_at: new Date() },
  });
  console.info(`[audit] expense ${existing.id} deleted by user ${req.user.userId}`);
  return res.json({ message: 'Expense deleted' });
});

module.exports = router;
