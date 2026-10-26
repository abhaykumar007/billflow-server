const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { lockRows } = require('../utils/lock');
const { computeBalance } = require('../utils/bank');
const { parseDayStart, parseDayEnd, isValidDate, todayDate } = require('../utils/time');
const { rupeesToPaise } = require('../utils/validate');

router.use(authenticateToken);

// GET /api/fund-transfers
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const where = { business_id: businessId };
  if (from || to) {
    where.transfer_date = {};
    if (from) where.transfer_date.gte = parseDayStart(from);
    if (to) where.transfer_date.lte = parseDayEnd(to);
  }

  const [transfers, total] = await Promise.all([
    prisma.fundTransfer.findMany({
      where,
      include: {
        from_account: { select: { id: true, account_name: true, bank_name: true } },
        to_account: { select: { id: true, account_name: true, bank_name: true } },
      },
      orderBy: { transfer_date: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.fundTransfer.count({ where }),
  ]);
  return res.json({ transfers, total });
});

// POST /api/fund-transfers
router.post('/', requireRole(...MANAGERS), async (req, res) => {
  const { from_account_id, to_account_id, amount, transfer_date, reference_number, notes } = req.body;
  const businessId = req.user.businessId;

  if (!from_account_id) throw new HttpError(400, 'Source account is required', 'VALIDATION');
  if (!to_account_id) throw new HttpError(400, 'Destination account is required', 'VALIDATION');
  if (from_account_id === to_account_id) throw new HttpError(400, 'Source and destination must differ', 'VALIDATION');
  const amountPaise = rupeesToPaise(amount, 'amount', { allowZero: false });
  const date = transfer_date ? parseDayStart(transfer_date) : todayDate();
  if (!isValidDate(date)) throw new HttpError(400, 'Invalid transfer_date', 'VALIDATION');

  const transfer = await prisma.$transaction(async (tx) => {
    // lock both accounts so two simultaneous transfers cannot both pass the balance check
    await lockRows(tx, 'bankAccount', [from_account_id, to_account_id]);
    const [fromAcc, toAcc] = await Promise.all([
      tx.bankAccount.findFirst({ where: { id: from_account_id, business_id: businessId, is_deleted: false } }),
      tx.bankAccount.findFirst({ where: { id: to_account_id, business_id: businessId, is_deleted: false } }),
    ]);
    if (!fromAcc) throw new HttpError(404, 'Source account not found', 'NOT_FOUND');
    if (!toAcc) throw new HttpError(404, 'Destination account not found', 'NOT_FOUND');

    const fromBalance = await computeBalance(tx, from_account_id, businessId);
    if (fromBalance < amountPaise) {
      throw new HttpError(400, `Insufficient balance. Available: ₹${(fromBalance / 100).toFixed(2)}`, 'INSUFFICIENT_BALANCE');
    }

    return tx.fundTransfer.create({
      data: {
        business_id: businessId,
        from_account_id,
        to_account_id,
        amount: amountPaise,
        transfer_date: date,
        reference_number: reference_number?.trim() || null,
        notes: notes?.trim() || null,
      },
      include: {
        from_account: { select: { id: true, account_name: true, bank_name: true } },
        to_account: { select: { id: true, account_name: true, bank_name: true } },
      },
    });
  });

  return res.status(201).json(transfer);
});

// DELETE /api/fund-transfers/:id - only if the destination still holds the money
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  const businessId = req.user.businessId;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.fundTransfer.findFirst({ where: { id: req.params.id, business_id: businessId } });
    if (!existing) throw new HttpError(404, 'Fund transfer not found', 'NOT_FOUND');

    await lockRows(tx, 'bankAccount', [existing.from_account_id, existing.to_account_id]);
    const toBalance = await computeBalance(tx, existing.to_account_id, businessId);
    if (toBalance !== null && toBalance - existing.amount < 0) {
      throw new HttpError(409, 'Cannot delete: the destination account no longer has this money.', 'INSUFFICIENT_BALANCE');
    }
    await tx.fundTransfer.delete({ where: { id: existing.id } });
    console.info(`[audit] fund transfer ${existing.id} (${existing.amount} paise) deleted by user ${req.user.userId}`);
  });

  return res.json({ message: 'Fund transfer deleted' });
});

module.exports = router;
