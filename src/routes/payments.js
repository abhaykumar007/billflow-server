const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);

// POST /api/payments — record a payment against an invoice (customer or supplier)
router.post('/', attachFinancialYear, async (req, res) => {
  const { invoice_id, amount, payment_mode, payment_date, reference_number, notes } = req.body;
  const businessId = req.user.businessId;

  if (!invoice_id || !amount || amount <= 0) {
    return res.status(400).json({ error: 'invoice_id and a positive amount are required' });
  }

  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoice_id, business_id: businessId, is_deleted: false },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (['draft', 'cancelled', 'paid'].includes(invoice.status)) {
      return res.status(400).json({ error: `Cannot record payment on a ${invoice.status} invoice` });
    }
    if (amount > invoice.balance_due) {
      return res.status(400).json({ error: `Amount exceeds balance due (${invoice.balance_due} paise)` });
    }

    const isSupplierInvoice = ['PURCHASE', 'PURCHASE_RETURN'].includes(invoice.voucher_type);
    const partyType = isSupplierInvoice ? 'SUPPLIER' : 'CUSTOMER';
    const paymentType = isSupplierInvoice ? 'PAID' : 'RECEIVED';
    const entryDate = payment_date ? new Date(payment_date) : new Date();
    const fyId = req.financialYear?.id || null;

    const payment = await prisma.$transaction(async (tx) => {
      const newPayment = await tx.payment.create({
        data: {
          business_id: businessId,
          invoice_id,
          customer_id: isSupplierInvoice ? null : invoice.customer_id,
          supplier_id: isSupplierInvoice ? invoice.supplier_id : null,
          party_type: partyType,
          payment_type: paymentType,
          amount,
          payment_mode: payment_mode || 'cash',
          payment_date: entryDate,
          reference_number: reference_number || null,
          notes: notes || null,
          financial_year_id: fyId,
        },
      });

      const newAmountPaid = invoice.amount_paid + amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      const newStatus = newBalanceDue <= 0 ? 'paid' : 'partial';

      await tx.invoice.update({
        where: { id: invoice_id },
        data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
      });

      if (isSupplierInvoice) {
        // Supplier payment: debit in supplier ledger (reduces what we owe)
        const lastEntry = await tx.supplierLedgerEntry.findFirst({
          where: { business_id: businessId, supplier_id: invoice.supplier_id, financial_year_id: fyId },
          orderBy: { created_at: 'desc' },
        });
        const newBalance = (lastEntry?.balance || 0) - amount;

        await tx.supplierLedgerEntry.create({
          data: {
            business_id: businessId,
            supplier_id: invoice.supplier_id,
            financial_year_id: fyId,
            entry_type: 'payment',
            reference_id: newPayment.id,
            reference_type: 'payment',
            debit: amount,
            credit: 0,
            balance: newBalance,
            narration: `Payment made for ${invoice.invoice_number} via ${payment_mode || 'cash'}`,
            entry_date: entryDate,
          },
        });
      } else {
        // Customer payment: credit in customer ledger (reduces what they owe us)
        const lastEntry = await tx.ledgerEntry.findFirst({
          where: { business_id: businessId, customer_id: invoice.customer_id, financial_year_id: fyId },
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
            entry_date: entryDate,
            financial_year_id: fyId,
          },
        });
      }

      return newPayment;
    });

    return res.status(201).json(payment);
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: 'Failed to record payment' });
  }
});

// GET /api/payments — list payments (customer or supplier)
router.get('/', async (req, res) => {
  const { customer_id, supplier_id, party_type, from, to, mode, limit = 50, offset = 0 } = req.query;
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_reversed: false };
  if (customer_id) where.customer_id = customer_id;
  if (supplier_id) where.supplier_id = supplier_id;
  if (party_type) where.party_type = party_type;
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
          supplier: { select: { id: true, name: true } },
          invoice: { select: { id: true, invoice_number: true, voucher_type: true } },
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

// DELETE /api/payments/:id — reverse a payment (append-only ledger reversal)
router.delete('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const { reason } = req.body;

  try {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, business_id: businessId },
      include: { invoice: true },
    });

    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.is_reversed) return res.status(400).json({ error: 'Payment is already reversed' });

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { is_reversed: true },
      });

      const invoice = payment.invoice;
      const newAmountPaid = invoice.amount_paid - payment.amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      // Bug #2 fix: was 'confirmed' — correct unpaid status is 'sent'
      const newStatus = newAmountPaid <= 0 ? 'sent' : 'partial';

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
      });

      const narration = `Payment reversal for ${invoice.invoice_number}${reason ? ` — ${reason}` : ''}`;
      const fyId = payment.financial_year_id || null;

      if (payment.party_type === 'SUPPLIER') {
        // Reverse supplier payment: credit (restores liability — we owe them again)
        const lastEntry = await tx.supplierLedgerEntry.findFirst({
          where: { business_id: businessId, supplier_id: payment.supplier_id, financial_year_id: fyId },
          orderBy: { created_at: 'desc' },
        });
        const newBalance = (lastEntry?.balance || 0) + payment.amount;

        await tx.supplierLedgerEntry.create({
          data: {
            business_id: businessId,
            supplier_id: payment.supplier_id,
            financial_year_id: fyId,
            entry_type: 'adjustment',
            reference_id: payment.id,
            reference_type: 'payment_reversal',
            debit: 0,
            credit: payment.amount,
            balance: newBalance,
            narration,
            entry_date: new Date(),
          },
        });
      } else {
        // Reverse customer payment: debit (restores receivable — they owe us again)
        const lastEntry = await tx.ledgerEntry.findFirst({
          where: { business_id: businessId, customer_id: payment.customer_id, financial_year_id: fyId },
          orderBy: { created_at: 'desc' },
        });
        const newBalance = (lastEntry?.balance || 0) + payment.amount;

        await tx.ledgerEntry.create({
          data: {
            business_id: businessId,
            customer_id: payment.customer_id,
            entry_type: 'adjustment',
            reference_id: payment.id,
            reference_type: 'payment_reversal',
            debit: payment.amount,
            credit: 0,
            balance: newBalance,
            narration,
            entry_date: new Date(),
            financial_year_id: fyId,
          },
        });
      }
    });

    return res.json({ message: 'Payment reversed successfully' });
  } catch (err) {
    console.error('Payment reversal error:', err);
    return res.status(500).json({ error: 'Failed to reverse payment' });
  }
});

module.exports = router;
