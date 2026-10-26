const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { attachFinancialYear, requireUnlockedFY, enforceOpenYear } = require('../middleware/financialYear');
const { HttpError } = require('../utils/httpError');
const { lockRow, lockRows } = require('../utils/lock');
const { parsePaise } = require('../utils/money');
const { parseDayStart, parseDayEnd, isValidDate, todayDate } = require('../utils/time');
const {
  postCustomerEntry, postSupplierEntry, VOUCHERS,
  assertDateInFY, getActiveFY, assertFyWritable, assertCanPost, idempotencyKey,
} = require('../utils/ledger');

router.use(authenticateToken);

const PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'bank', 'credit', 'other'];

function parseMode(mode) {
  const m = String(mode || 'cash').trim().toLowerCase();
  if (!PAYMENT_MODES.includes(m)) throw new HttpError(400, `Invalid payment_mode (use one of: ${PAYMENT_MODES.join(', ')})`, 'VALIDATION');
  return m;
}

// Validates the shared body fields and returns normalised values
function parsePaymentBody(body) {
  const amount = parsePaise(body.amount, 'amount');
  let splits = null;
  if (Array.isArray(body.splits) && body.splits.length > 0) {
    splits = body.splits.map((s) => ({ payment_mode: parseMode(s.payment_mode), amount: parsePaise(s.amount, 'split amount') }));
    const total = splits.reduce((sum, s) => sum + s.amount, 0);
    if (total !== amount) {
      throw new HttpError(400, `Split amounts (${total} paise) must equal total amount (${amount} paise)`, 'VALIDATION');
    }
  }
  const paymentDate = body.payment_date ? parseDayStart(body.payment_date) : todayDate();
  if (!isValidDate(paymentDate)) throw new HttpError(400, 'Invalid payment_date', 'VALIDATION');
  return {
    amount,
    splits,
    paymentDate,
    mode: splits ? null : parseMode(body.payment_mode),
    reference: body.reference_number ? String(body.reference_number).slice(0, 100) : null,
    notes: body.notes ? String(body.notes).slice(0, 500) : null,
  };
}

async function resolveBankAccount(tx, businessId, bankAccountId) {
  if (!bankAccountId) return null;
  const acc = await tx.bankAccount.findFirst({
    where: { id: bankAccountId, business_id: businessId, is_deleted: false, is_active: true },
    select: { id: true },
  });
  if (!acc) throw new HttpError(404, 'Bank account not found', 'NOT_FOUND');
  return acc.id;
}

// POST /api/payments - record a payment against an invoice, or an advance / on-account payment
router.post('/', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  await assertCanPost(prisma, fy);

  const p = parsePaymentBody(req.body);
  assertDateInFY(p.paymentDate, fy);
  const key = idempotencyKey(req);
  const isAdvance = !!req.body.advance_payment;

  if (key) {
    const dup = await prisma.payment.findFirst({ where: { business_id: businessId, idempotency_key: key }, include: { splits: true } });
    if (dup) return res.status(200).json({ ...dup, idempotent_replay: true });
  }

  const payment = await prisma.$transaction(async (tx) => {
    const bankAccountId = await resolveBankAccount(tx, businessId, req.body.bank_account_id);
    const modeLabel = p.mode || 'split';

    let created;
    if (isAdvance) {
      // ── Advance / on-account payment ──────────────────────────────────────
      const { customer_id, supplier_id } = req.body;
      if (!customer_id && !supplier_id) throw new HttpError(400, 'customer_id or supplier_id is required for advance payment', 'VALIDATION');
      if (customer_id && supplier_id) throw new HttpError(400, 'Provide either customer_id or supplier_id, not both', 'VALIDATION');
      const isSupplier = !!supplier_id;

      if (isSupplier) {
        const s = await tx.supplier.findFirst({ where: { id: supplier_id, business_id: businessId, is_deleted: false }, select: { id: true } });
        if (!s) throw new HttpError(404, 'Supplier not found', 'NOT_FOUND');
      } else {
        const c = await tx.customer.findFirst({ where: { id: customer_id, business_id: businessId, is_deleted: false }, select: { id: true } });
        if (!c) throw new HttpError(404, 'Customer not found', 'NOT_FOUND');
      }

      created = await tx.payment.create({
        data: {
          business_id: businessId,
          invoice_id: null,
          customer_id: isSupplier ? null : customer_id,
          supplier_id: isSupplier ? supplier_id : null,
          bank_account_id: bankAccountId,
          party_type: isSupplier ? 'SUPPLIER' : 'CUSTOMER',
          payment_type: isSupplier ? 'PAID' : 'RECEIVED',
          amount: p.amount,
          payment_mode: p.mode,
          payment_date: p.paymentDate,
          reference_number: p.reference,
          notes: p.notes,
          financial_year_id: fy.id,
          advance_payment: true,
          advance_balance_remaining: p.amount,
          idempotency_key: key,
        },
      });

      if (isSupplier) {
        await postSupplierEntry(tx, {
          businessId, supplierId: supplier_id, fyId: fy.id, debit: p.amount, entryType: 'advance',
          referenceId: created.id, referenceType: 'advance_payment',
          narration: `Advance payment made via ${modeLabel}`, entryDate: p.paymentDate,
        });
      } else {
        await postCustomerEntry(tx, {
          businessId, customerId: customer_id, fyId: fy.id, credit: p.amount, entryType: 'advance',
          referenceId: created.id, referenceType: 'advance_payment',
          narration: `Advance payment received via ${modeLabel}`, entryDate: p.paymentDate,
        });
      }
    } else {
      // ── Regular payment against an invoice ────────────────────────────────
      const { invoice_id } = req.body;
      if (!invoice_id) throw new HttpError(400, 'invoice_id is required', 'VALIDATION');

      await lockRow(tx, 'invoice', invoice_id);
      const invoice = await tx.invoice.findFirst({ where: { id: invoice_id, business_id: businessId, is_deleted: false } });
      if (!invoice) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');
      const v = VOUCHERS[invoice.voucher_type];
      if (!v) throw new HttpError(400, 'Payments cannot be recorded against estimates', 'VALIDATION');
      if (['draft', 'cancelled', 'paid'].includes(invoice.status)) {
        throw new HttpError(400, `Cannot record payment on a ${invoice.status} invoice`, 'VALIDATION');
      }
      // read inside the lock, so two concurrent payments cannot both pass this check
      if (p.amount > invoice.balance_due) {
        throw new HttpError(400, `Amount exceeds balance due (${invoice.balance_due} paise)`, 'OVERPAYMENT');
      }
      if (p.paymentDate.getTime() < invoice.invoice_date.getTime() - 24 * 3600 * 1000) {
        throw new HttpError(400, 'Payment date cannot be before the invoice date', 'VALIDATION');
      }

      const isSupplier = v.party === 'SUPPLIER';
      created = await tx.payment.create({
        data: {
          business_id: businessId,
          invoice_id,
          customer_id: isSupplier ? null : invoice.customer_id,
          supplier_id: isSupplier ? invoice.supplier_id : null,
          bank_account_id: bankAccountId,
          party_type: v.party,
          payment_type: v.settleType,
          amount: p.amount,
          payment_mode: p.mode,
          payment_date: p.paymentDate,
          reference_number: p.reference,
          notes: p.notes,
          financial_year_id: fy.id,
          idempotency_key: key,
        },
      });

      const newAmountPaid = invoice.amount_paid + p.amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      await tx.invoice.update({
        where: { id: invoice_id },
        data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newBalanceDue <= 0 ? 'paid' : 'partial' },
      });

      const narrationBase = {
        SALE: `Payment received for ${invoice.invoice_number}`,
        SALE_RETURN: `Refund paid against ${invoice.invoice_number}`,
        PURCHASE: `Payment made for ${invoice.invoice_number}`,
        PURCHASE_RETURN: `Refund received against ${invoice.invoice_number}`,
      }[invoice.voucher_type];
      const entry = {
        businessId, fyId: fy.id, entryType: 'payment', referenceId: created.id, referenceType: 'payment',
        narration: `${narrationBase} via ${modeLabel}`, entryDate: p.paymentDate,
        [v.settleSide]: p.amount,
      };
      if (isSupplier) await postSupplierEntry(tx, { ...entry, supplierId: invoice.supplier_id });
      else await postCustomerEntry(tx, { ...entry, customerId: invoice.customer_id });
    }

    if (p.splits) {
      await tx.paymentSplit.createMany({ data: p.splits.map((s) => ({ payment_id: created.id, ...s })) });
    }
    return created;
  });

  return res.status(201).json(payment);
});

// GET /api/payments - list payments with optional filters
router.get('/', async (req, res) => {
  const { customer_id, supplier_id, party_type, payment_type, from, to, mode, advance_only } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const businessId = req.user.businessId;

  const where = { business_id: businessId, is_reversed: false };
  if (customer_id) where.customer_id = customer_id;
  if (supplier_id) where.supplier_id = supplier_id;
  if (party_type) where.party_type = party_type;
  if (payment_type) where.payment_type = payment_type;
  if (mode) where.payment_mode = mode;
  if (advance_only === 'true') where.advance_payment = true;
  if (from || to) {
    where.payment_date = {};
    if (from) where.payment_date.gte = parseDayStart(from);
    if (to) where.payment_date.lte = parseDayEnd(to);
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoice_number: true, voucher_type: true } },
        bankAccount: { select: { id: true, account_name: true } },
        splits: true,
      },
      orderBy: [{ payment_date: 'desc' }, { created_at: 'desc' }],
      take: limit,
      skip: offset,
    }),
    prisma.payment.count({ where }),
  ]);
  return res.json({ payments, total });
});

// GET /api/payments/advance-balance/:customerId - unused advance for a customer
router.get('/advance-balance/:customerId', async (req, res) => {
  const result = await prisma.payment.aggregate({
    where: {
      business_id: req.user.businessId,
      customer_id: req.params.customerId,
      advance_payment: true,
      is_reversed: false,
    },
    _sum: { advance_balance_remaining: true },
  });
  return res.json({ advance_balance_remaining: result._sum.advance_balance_remaining || 0 });
});

// GET /api/payments/advance-balance/supplier/:supplierId
router.get('/advance-balance/supplier/:supplierId', async (req, res) => {
  const result = await prisma.payment.aggregate({
    where: {
      business_id: req.user.businessId,
      supplier_id: req.params.supplierId,
      advance_payment: true,
      is_reversed: false,
    },
    _sum: { advance_balance_remaining: true },
  });
  return res.json({ advance_balance_remaining: result._sum.advance_balance_remaining || 0 });
});

// POST /api/payments/adjust-advance - apply a party's advance balance to one of its invoices.
// An advance is already on the ledger (credited when received), so applying it only
// settles the invoice; the ledger gets an informational zero-amount line, never a second credit.
router.post('/adjust-advance', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  await assertCanPost(prisma, fy);

  const { invoice_id } = req.body;
  if (!invoice_id) throw new HttpError(400, 'invoice_id is required', 'VALIDATION');
  const amount = parsePaise(req.body.amount, 'amount');

  await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'invoice', invoice_id);
    const invoice = await tx.invoice.findFirst({ where: { id: invoice_id, business_id: businessId, is_deleted: false } });
    if (!invoice) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');
    if (!['SALE', 'PURCHASE'].includes(invoice.voucher_type)) {
      throw new HttpError(400, 'Advances can only be applied to sale or purchase invoices', 'VALIDATION');
    }
    if (!['sent', 'partial'].includes(invoice.status)) {
      throw new HttpError(400, `Cannot apply advance to a ${invoice.status} invoice`, 'VALIDATION');
    }
    if (amount > invoice.balance_due) {
      throw new HttpError(400, `Amount exceeds invoice balance due (${invoice.balance_due} paise)`, 'OVERPAYMENT');
    }

    // the party always comes from the invoice, never from the request body
    const isSupplier = invoice.voucher_type === 'PURCHASE';
    const partyId = isSupplier ? invoice.supplier_id : invoice.customer_id;
    await lockRow(tx, isSupplier ? 'supplier' : 'customer', partyId);

    const advances = await tx.payment.findMany({
      where: {
        business_id: businessId,
        ...(isSupplier ? { supplier_id: partyId } : { customer_id: partyId }),
        advance_payment: true,
        is_reversed: false,
        advance_balance_remaining: { gt: 0 },
      },
      orderBy: [{ payment_date: 'asc' }, { created_at: 'asc' }],
    });
    const totalAvailable = advances.reduce((s, a) => s + a.advance_balance_remaining, 0);
    if (totalAvailable < amount) {
      throw new HttpError(400, `Insufficient advance balance. Available: ${totalAvailable} paise, requested: ${amount} paise`, 'INSUFFICIENT_ADVANCE');
    }

    let remaining = amount;
    for (const adv of advances) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, adv.advance_balance_remaining);
      await tx.payment.update({ where: { id: adv.id }, data: { advance_balance_remaining: { decrement: deduct } } });
      remaining -= deduct;
    }

    const newAmountPaid = invoice.amount_paid + amount;
    const newBalanceDue = invoice.total_amount - newAmountPaid;
    await tx.invoice.update({
      where: { id: invoice_id },
      data: { amount_paid: newAmountPaid, balance_due: newBalanceDue, status: newBalanceDue <= 0 ? 'paid' : 'partial' },
    });

    const entry = {
      businessId, fyId: fy.id, debit: 0, credit: 0, entryType: 'advance_adjustment',
      referenceId: invoice_id, referenceType: 'advance_adjustment',
      narration: `Advance of Rs ${(amount / 100).toFixed(2)} applied to ${invoice.invoice_number}`,
      entryDate: todayDate(),
    };
    if (isSupplier) await postSupplierEntry(tx, { ...entry, supplierId: partyId });
    else await postCustomerEntry(tx, { ...entry, customerId: partyId });
  });

  return res.json({ message: 'Advance applied successfully' });
});

// DELETE /api/payments/:id - reverse a payment (append-only ledger reversal)
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  const businessId = req.user.businessId;
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;

  await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'payment', req.params.id);
    const payment = await tx.payment.findFirst({
      where: { id: req.params.id, business_id: businessId },
      include: { invoice: true },
    });
    if (!payment) throw new HttpError(404, 'Payment not found', 'NOT_FOUND');
    if (payment.is_reversed) throw new HttpError(400, 'Payment is already reversed', 'VALIDATION');

    // The reversal is an event of TODAY: it is posted to the current financial year,
    // so closed / carried-forward years are never rewritten.
    const activeFy = await getActiveFY(tx, businessId);
    assertFyWritable(activeFy);
    if (payment.financial_year_id && payment.financial_year_id !== activeFy.id) {
      const payFy = await tx.financialYear.findUnique({ where: { id: payment.financial_year_id } });
      if (payFy?.is_locked && !payFy.is_closed) {
        throw new HttpError(423, 'This payment belongs to a locked financial year. Unlock it first.', 'FY_LOCKED');
      }
    }

    if (payment.advance_payment && payment.advance_balance_remaining < payment.amount) {
      throw new HttpError(409, 'Part of this advance has already been applied to invoices. Reverse those invoice payments first.', 'ADVANCE_PARTIALLY_USED');
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { is_reversed: true, ...(payment.advance_payment && { advance_balance_remaining: 0 }) },
    });

    if (!payment.advance_payment && payment.invoice) {
      await lockRow(tx, 'invoice', payment.invoice.id);
      const invoice = await tx.invoice.findUnique({ where: { id: payment.invoice.id } });
      const newAmountPaid = invoice.amount_paid - payment.amount;
      const newBalanceDue = invoice.total_amount - newAmountPaid;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amount_paid: newAmountPaid,
          balance_due: newBalanceDue,
          // a cancelled invoice must stay cancelled
          status: invoice.status === 'cancelled' ? 'cancelled' : newAmountPaid <= 0 ? 'sent' : 'partial',
        },
      });
    }

    // Original posting side, then flip it
    // customer ledger: RECEIVED = credit, PAID = debit; supplier ledger: PAID = debit, RECEIVED = credit
    // so in both ledgers the original line was a credit exactly when the money came IN
    const wasCredit = payment.payment_type === 'RECEIVED';
    const narration = payment.advance_payment
      ? `Advance payment reversal${reason ? ` - ${reason}` : ''}`
      : `Payment reversal for ${payment.invoice?.invoice_number}${reason ? ` - ${reason}` : ''}`;
    const entry = {
      businessId, fyId: activeFy.id, entryType: 'adjustment', referenceId: payment.id,
      referenceType: 'payment_reversal', narration, entryDate: todayDate(),
      ...(wasCredit ? { debit: payment.amount } : { credit: payment.amount }),
    };
    if (payment.party_type === 'SUPPLIER') await postSupplierEntry(tx, { ...entry, supplierId: payment.supplier_id });
    else await postCustomerEntry(tx, { ...entry, customerId: payment.customer_id });

    console.info(`[audit] payment ${payment.id} reversed by user ${req.user.userId}${reason ? `: ${reason}` : ''}`);
  });

  return res.json({ message: 'Payment reversed successfully' });
});

module.exports = router;
