const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Compute available balance for a bank account
async function computeBalance(bankAccountId, businessId) {
  const [account, paymentsIn, paymentsOut, expensesOut, transfersIn, transfersOut] = await Promise.all([
    prisma.bankAccount.findFirst({
      where: { id: bankAccountId, business_id: businessId },
      select: { opening_balance: true },
    }),
    prisma.payment.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, payment_type: 'RECEIVED', is_reversed: false },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, payment_type: 'PAID', is_reversed: false },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, is_deleted: false },
      _sum: { amount: true },
    }),
    prisma.fundTransfer.aggregate({
      where: { to_account_id: bankAccountId, business_id: businessId },
      _sum: { amount: true },
    }),
    prisma.fundTransfer.aggregate({
      where: { from_account_id: bankAccountId, business_id: businessId },
      _sum: { amount: true },
    }),
  ]);

  if (!account) return null;
  return (account.opening_balance || 0)
    + (paymentsIn._sum.amount || 0)
    - (paymentsOut._sum.amount || 0)
    - (expensesOut._sum.amount || 0)
    + (transfersIn._sum.amount || 0)
    - (transfersOut._sum.amount || 0);
}

// GET /api/fund-transfers
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to, limit = 50, offset = 0 } = req.query;

  const where = { business_id: businessId };
  if (from || to) {
    where.transfer_date = {};
    if (from) where.transfer_date.gte = new Date(from);
    if (to) where.transfer_date.lte = new Date(to + 'T23:59:59');
  }

  try {
    const [transfers, total] = await Promise.all([
      prisma.fundTransfer.findMany({
        where,
        include: {
          from_account: { select: { id: true, account_name: true, bank_name: true } },
          to_account: { select: { id: true, account_name: true, bank_name: true } },
        },
        orderBy: { transfer_date: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.fundTransfer.count({ where }),
    ]);

    return res.json({ transfers, total });
  } catch (err) {
    console.error('Fund transfers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch fund transfers' });
  }
});

// POST /api/fund-transfers
router.post('/', async (req, res) => {
  const { from_account_id, to_account_id, amount, transfer_date, reference_number, notes } = req.body;
  const businessId = req.user.businessId;

  if (!from_account_id) return res.status(400).json({ error: 'Source account is required' });
  if (!to_account_id) return res.status(400).json({ error: 'Destination account is required' });
  if (from_account_id === to_account_id) return res.status(400).json({ error: 'Source and destination must differ' });

  const amountPaise = Math.round(parseFloat(amount) * 100);
  if (!amountPaise || amountPaise <= 0) return res.status(400).json({ error: 'Amount must be positive' });

  try {
    // Verify both accounts belong to this business
    const [fromAcc, toAcc] = await Promise.all([
      prisma.bankAccount.findFirst({ where: { id: from_account_id, business_id: businessId, is_deleted: false } }),
      prisma.bankAccount.findFirst({ where: { id: to_account_id, business_id: businessId, is_deleted: false } }),
    ]);
    if (!fromAcc) return res.status(404).json({ error: 'Source account not found' });
    if (!toAcc) return res.status(404).json({ error: 'Destination account not found' });

    // Check sufficient balance in source
    const fromBalance = await computeBalance(from_account_id, businessId);
    if (fromBalance < amountPaise) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ₹${(fromBalance / 100).toFixed(2)}`,
      });
    }

    const transfer = await prisma.fundTransfer.create({
      data: {
        business_id: businessId,
        from_account_id,
        to_account_id,
        amount: amountPaise,
        transfer_date: transfer_date ? new Date(transfer_date) : new Date(),
        reference_number: reference_number?.trim() || null,
        notes: notes?.trim() || null,
      },
      include: {
        from_account: { select: { id: true, account_name: true, bank_name: true } },
        to_account: { select: { id: true, account_name: true, bank_name: true } },
      },
    });

    return res.status(201).json(transfer);
  } catch (err) {
    console.error('Create fund transfer error:', err);
    return res.status(500).json({ error: 'Failed to create fund transfer' });
  }
});

// DELETE /api/fund-transfers/:id
router.delete('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const existing = await prisma.fundTransfer.findFirst({
      where: { id: req.params.id, business_id: businessId },
    });
    if (!existing) return res.status(404).json({ error: 'Fund transfer not found' });

    await prisma.fundTransfer.delete({ where: { id: req.params.id } });
    return res.json({ message: 'Fund transfer deleted' });
  } catch (err) {
    console.error('Delete fund transfer error:', err);
    return res.status(500).json({ error: 'Failed to delete fund transfer' });
  }
});

module.exports = router;
