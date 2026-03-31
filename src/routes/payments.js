const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// POST /api/payments — record a payment against an invoice
router.post('/', async (req, res) => {
  const { invoice_id, amount, payment_mode, payment_date, reference_number, notes } = req.body;
  const businessId = req.user.businessId;

  if (!invoice_id || !amount || amount <= 0) {
    return res.status(400).json({ error: 'invoice_id and a positive amount are required' });
  }

  try {
    // Pre-validate outside transaction so we can return proper HTTP errors
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoice_id, business_id: businessId, is_deleted: false },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (['draft', 'cancelled', 'paid'].includes(invoice.status)) {
      return res.status(400).json({ error: `Cannot record payment on a ${invoice.status} invoice` });
    }
    if (amount > invoice.balance_due) {
      return res.status(400).json({
        error: `Amount exceeds balance due (${invoice.balance_due} paise)`,
      });
    }

    const payment = await prisma.$transaction(async (tx) => {
      const newPayment = await tx.payment.create({
        data: {
          business_id: businessId,
          invoice_id,
          customer_id: invoice.customer_id,
          amount,
          payment_mode: payment_mode || 'cash',
          payment_date: payment_date ? new Date(payment_date) : new Date(),
          reference_number: reference_number || null,
          notes: notes || null,
        },
      });

      const newAmountPaid = invoice.amount_paid + amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      const newStatus = newBalanceDue <= 0 ? 'paid' : 'partial';

      await tx.invoice.update({
        where: { id: invoice_id },
        data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
      });

      // Running balance: last ledger entry for this customer
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { business_id: businessId, customer_id: invoice.customer_id },
        orderBy: { created_at: 'desc' },
      });
      const newBalance = (lastEntry?.balance || 0) - amount;

      await tx.ledgerEntry.create({
        data: {
          business_id: businessId,
          customer_id: invoice.customer_id,
          entry_type: 'payment',
          reference_id: newPayment.id,
          reference_type: 'payment',
          debit: 0,
          credit: amount,
          balance: newBalance,
          narration: `Payment received for ${invoice.invoice_number} via ${payment_mode || 'cash'}`,
          entry_date: payment_date ? new Date(payment_date) : new Date(),
        },
      });

      return newPayment;
    });

    return res.status(201).json(payment);
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: 'Failed to record payment' });
  }
});

// GET /api/payments — list payments
router.get('/', async (req, res) => {
  const { customer_id, from, to, mode, limit = 50, offset = 0 } = req.query;
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_reversed: false };
  if (customer_id) where.customer_id = customer_id;
  if (mode) where.payment_mode = mode;
  if (from || to) {
    where.payment_date = {};
    if (from) where.payment_date.gte = new Date(from);
    if (to) where.payment_date.lte = new Date(to + 'T23:59:59');
  }

  try {
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          invoice: { select: { id: true, invoice_number: true } },
        },
        orderBy: { payment_date: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.payment.count({ where }),
    ]);

    return res.json({ payments, total });
  } catch (err) {
    console.error('Payments list error:', err);
    return res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

module.exports = router;
