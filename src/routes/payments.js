const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear, requireUnlockedFY, enforceOpenYear } = require('../middleware/financialYear');

router.use(authenticateToken);

// POST /api/payments — record a payment (regular against invoice, or advance on-account)
router.post('/', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const {
    invoice_id,
    customer_id,
    supplier_id,
    amount,
    payment_mode,
    payment_date,
    reference_number,
    notes,
    advance_payment,
    splits,
  } = req.body;
  const businessId = req.user.businessId;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'A positive amount is required' });
  }

  // Validate splits if provided
  if (splits && splits.length > 0) {
    const invalidSplit = splits.find(s => !s.payment_mode || !s.amount || s.amount <= 0);
    if (invalidSplit) {
      return res.status(400).json({ error: 'Each split must have payment_mode and a positive amount' });
    }
    const splitTotal = splits.reduce((sum, s) => sum + s.amount, 0);
    if (splitTotal !== amount) {
      return res.status(400).json({
        error: `Split amounts (${splitTotal} paise) must equal total amount (${amount} paise)`,
      });
    }
  }

  const isAdvance = !!advance_payment;
  const entryDate = payment_date ? new Date(payment_date) : new Date();
  const fyId = req.financialYear?.id || null;
  const resolvedMode = splits?.length > 0 ? null : (payment_mode || 'cash');

  try {
    if (isAdvance) {
      // ── Advance / on-account payment ────────────────────────────────────────
      if (!customer_id && !supplier_id) {
        return res.status(400).json({ error: 'customer_id or supplier_id is required for advance payment' });
      }

      const isSupplier = !!supplier_id;
      const partyType = isSupplier ? 'SUPPLIER' : 'CUSTOMER';
      const paymentType = isSupplier ? 'PAID' : 'RECEIVED';

      const payment = await prisma.$transaction(async (tx) => {
        const newPayment = await tx.payment.create({
          data: {
            business_id: businessId,
            invoice_id: null,
            customer_id: isSupplier ? null : customer_id,
            supplier_id: isSupplier ? supplier_id : null,
            party_type: partyType,
            payment_type: paymentType,
            amount,
            payment_mode: resolvedMode,
            payment_date: entryDate,
            reference_number: reference_number || null,
            notes: notes || null,
            financial_year_id: fyId,
            advance_payment: true,
            advance_balance_remaining: amount,
          },
        });

        if (splits?.length > 0) {
          await tx.paymentSplit.createMany({
            data: splits.map(s => ({ payment_id: newPayment.id, payment_mode: s.payment_mode, amount: s.amount })),
          });
        }

        // Ledger: credit customer (reduces receivable) or debit supplier (reduces payable)
        if (!isSupplier) {
          const lastEntry = await tx.ledgerEntry.findFirst({
            where: { business_id: businessId, customer_id, financial_year_id: fyId },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          });
          const newBalance = (lastEntry?.balance || 0) - amount;
          await tx.ledgerEntry.create({
            data: {
              business_id: businessId,
              customer_id,
              entry_type: 'advance',
              reference_id: newPayment.id,
              reference_type: 'advance_payment',
              debit: 0,
              credit: amount,
              balance: newBalance,
              narration: `Advance payment received via ${payment_mode || 'split'}`,
              entry_date: entryDate,
              financial_year_id: fyId,
            },
          });
        } else {
          const lastEntry = await tx.supplierLedgerEntry.findFirst({
            where: { business_id: businessId, supplier_id, financial_year_id: fyId },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          });
          const newBalance = (lastEntry?.balance || 0) - amount;
          await tx.supplierLedgerEntry.create({
            data: {
              business_id: businessId,
              supplier_id,
              financial_year_id: fyId,
              entry_type: 'advance',
              reference_id: newPayment.id,
              reference_type: 'advance_payment',
              debit: amount,
              credit: 0,
              balance: newBalance,
              narration: `Advance payment made via ${payment_mode || 'split'}`,
              entry_date: entryDate,
            },
          });
        }

        return newPayment;
      });

      return res.status(201).json(payment);
    } else {
      // ── Regular payment against an invoice ──────────────────────────────────
      if (!invoice_id) {
        return res.status(400).json({ error: 'invoice_id is required' });
      }

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
            payment_mode: resolvedMode,
            payment_date: entryDate,
            reference_number: reference_number || null,
            notes: notes || null,
            financial_year_id: fyId,
          },
        });

        if (splits?.length > 0) {
          await tx.paymentSplit.createMany({
            data: splits.map(s => ({ payment_id: newPayment.id, payment_mode: s.payment_mode, amount: s.amount })),
          });
        }

        const newAmountPaid = invoice.amount_paid + amount;
        const newBalanceDue = invoice.total_amount - newAmountPaid;
        const newStatus = newBalanceDue <= 0 ? 'paid' : 'partial';

        await tx.invoice.update({
          where: { id: invoice_id },
          data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
        });

        if (isSupplierInvoice) {
          const lastEntry = await tx.supplierLedgerEntry.findFirst({
            where: { business_id: businessId, supplier_id: invoice.supplier_id, financial_year_id: fyId },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
              narration: `Payment made for ${invoice.invoice_number} via ${payment_mode || 'split'}`,
              entry_date: entryDate,
            },
          });
        } else {
          const lastEntry = await tx.ledgerEntry.findFirst({
            where: { business_id: businessId, customer_id: invoice.customer_id, financial_year_id: fyId },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
              narration: `Payment received for ${invoice.invoice_number} via ${payment_mode || 'split'}`,
              entry_date: entryDate,
              financial_year_id: fyId,
            },
          });
        }

        return newPayment;
      });

      return res.status(201).json(payment);
    }
  } catch (err) {
    console.error('Payment error:', err);
    return res.status(500).json({ error: 'Failed to record payment' });
  }
});

// GET /api/payments — list payments with optional filters
router.get('/', async (req, res) => {
  const {
    customer_id,
    supplier_id,
    party_type,
    from,
    to,
    mode,
    advance_only,
    limit = 50,
    offset = 0,
  } = req.query;
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_reversed: false };
  if (customer_id) where.customer_id = customer_id;
  if (supplier_id) where.supplier_id = supplier_id;
  if (party_type) where.party_type = party_type;
  if (mode) where.payment_mode = mode;
  if (advance_only === 'true') where.advance_payment = true;
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
          splits: true,
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

// GET /api/payments/advance-balance/:customerId — total unused advance for a customer
router.get('/advance-balance/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const businessId = req.user.businessId;

  try {
    const result = await prisma.payment.aggregate({
      where: {
        business_id: businessId,
        customer_id: customerId,
        advance_payment: true,
        is_reversed: false,
      },
      _sum: { advance_balance_remaining: true },
    });

    return res.json({ advance_balance_remaining: result._sum.advance_balance_remaining || 0 });
  } catch (err) {
    console.error('Advance balance error:', err);
    return res.status(500).json({ error: 'Failed to fetch advance balance' });
  }
});

// POST /api/payments/adjust-advance — apply customer advance balance to an invoice
router.post('/adjust-advance', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const { customer_id, invoice_id, amount } = req.body;
  const businessId = req.user.businessId;

  if (!customer_id || !invoice_id || !amount || amount <= 0) {
    return res.status(400).json({ error: 'customer_id, invoice_id, and a positive amount are required' });
  }

  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoice_id, business_id: businessId, is_deleted: false },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (amount > invoice.balance_due) {
      return res.status(400).json({ error: `Amount exceeds invoice balance due (${invoice.balance_due} paise)` });
    }

    // Find open advance payments oldest-first
    const advances = await prisma.payment.findMany({
      where: {
        business_id: businessId,
        customer_id,
        advance_payment: true,
        is_reversed: false,
        advance_balance_remaining: { gt: 0 },
      },
      orderBy: { payment_date: 'asc' },
    });

    const totalAvailable = advances.reduce((sum, a) => sum + a.advance_balance_remaining, 0);
    if (totalAvailable < amount) {
      return res.status(400).json({
        error: `Insufficient advance balance. Available: ${totalAvailable} paise, requested: ${amount} paise`,
      });
    }

    const fyId = req.financialYear?.id || null;
    const entryDate = new Date();

    await prisma.$transaction(async (tx) => {
      // Deduct from advances oldest-first
      let remaining = amount;
      for (const advance of advances) {
        if (remaining <= 0) break;
        const deduct = Math.min(remaining, advance.advance_balance_remaining);
        await tx.payment.update({
          where: { id: advance.id },
          data: { advance_balance_remaining: advance.advance_balance_remaining - deduct },
        });
        remaining -= deduct;
      }

      // Apply to invoice
      const newAmountPaid = invoice.amount_paid + amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      const newStatus = newBalanceDue <= 0 ? 'paid' : 'partial';
      await tx.invoice.update({
        where: { id: invoice_id },
        data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
      });

      // Ledger credit — advance applied reduces the customer's receivable balance
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { business_id: businessId, customer_id, financial_year_id: fyId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      });
      const newBalance = (lastEntry?.balance || 0) - amount;
      await tx.ledgerEntry.create({
        data: {
          business_id: businessId,
          customer_id,
          entry_type: 'advance_adjustment',
          reference_id: invoice_id,
          reference_type: 'advance_adjustment',
          debit: 0,
          credit: amount,
          balance: newBalance,
          narration: `Advance applied to ${invoice.invoice_number}`,
          entry_date: entryDate,
          financial_year_id: fyId,
        },
      });
    });

    return res.json({ message: 'Advance applied successfully' });
  } catch (err) {
    console.error('Adjust advance error:', err);
    return res.status(500).json({ error: 'Failed to apply advance' });
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
        data: {
          is_reversed: true,
          // Zero out remaining advance balance — it can no longer be applied
          ...(payment.advance_payment && { advance_balance_remaining: 0 }),
        },
      });

      const fyId = payment.financial_year_id || null;
      const narration = payment.advance_payment
        ? `Advance payment reversal${reason ? ` — ${reason}` : ''}`
        : `Payment reversal for ${payment.invoice?.invoice_number}${reason ? ` — ${reason}` : ''}`;

      // Only update the invoice for regular payments
      if (!payment.advance_payment && payment.invoice) {
        const invoice = payment.invoice;
        const newAmountPaid = invoice.amount_paid - payment.amount;
        const newBalanceDue = invoice.total_amount - newAmountPaid;
        const newStatus = newAmountPaid <= 0 ? 'sent' : 'partial';

        await tx.invoice.update({
          where: { id: invoice.id },
          data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newStatus },
        });
      }

      if (payment.party_type === 'SUPPLIER') {
        const lastEntry = await tx.supplierLedgerEntry.findFirst({
          where: { business_id: businessId, supplier_id: payment.supplier_id, financial_year_id: fyId },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
        const lastEntry = await tx.ledgerEntry.findFirst({
          where: { business_id: businessId, customer_id: payment.customer_id, financial_year_id: fyId },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
