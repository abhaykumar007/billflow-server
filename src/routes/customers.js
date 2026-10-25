const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');
const { requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { parseParty, rupeesToPaise, pageParams } = require('../utils/validate');
const { parseDayStart, parseDayEnd, todayDate } = require('../utils/time');
const { postCustomerEntry, getActiveFY } = require('../utils/ledger');

router.use(authenticateToken);

// GET /api/customers — list with search + pagination
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { search = '' } = req.query;
    const { page, limit, skip } = pageParams(req.query);

    const where = {
      business_id: businessId,
      is_deleted: false,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
          state: true,
          gstin: true,
          opening_balance: true,
          balance_type: true,
          created_at: true,
          _count: { select: { invoices: true } },
        },
      }),
      prisma.customer.count({ where }),
    ]);

    // Compute outstanding balance per customer from invoices
    const customerIds = customers.map((c) => c.id);
    const outstandingData = await prisma.invoice.groupBy({
      by: ['customer_id'],
      where: {
        business_id: businessId,
        customer_id: { in: customerIds },
        status: { in: ['sent', 'partial'] },
        is_deleted: false,
      },
      _sum: { balance_due: true },
    });
    const outstandingMap = Object.fromEntries(
      outstandingData.map((o) => [o.customer_id, o._sum.balance_due || 0])
    );

    // Ledger balance (opening balance + invoices - payments), in the current financial year chain
    const activeFy = await getActiveFY(prisma, businessId);
    const ledgerTotals = activeFy
      ? await prisma.ledgerEntry.groupBy({
          by: ['customer_id'],
          where: { business_id: businessId, financial_year_id: activeFy.id, customer_id: { in: customerIds } },
          _sum: { debit: true, credit: true },
        })
      : [];
    const ledgerMap = Object.fromEntries(
      ledgerTotals.map((t) => [t.customer_id, (t._sum.debit || 0) - (t._sum.credit || 0)])
    );

    const enriched = customers.map((c) => ({
      ...c,
      outstanding: outstandingMap[c.id] || 0,
      ledger_balance: ledgerMap[c.id] || 0,
    }));

    return res.json({ customers: enriched, total, page, limit });
  } catch (err) {
    console.error('List customers error:', err);
    return res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /api/customers/:id — single customer with balance summary
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [invoiceSummary, totalPaid, creditUsed] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          customer_id: customer.id,
          business_id: businessId,
          is_deleted: false,
          status: { not: 'cancelled' },
        },
        _sum: { total_amount: true, amount_paid: true, balance_due: true },
        _count: { id: true },
      }),
      prisma.payment.aggregate({
        where: {
          customer_id: customer.id,
          business_id: businessId,
          is_reversed: false,
        },
        _sum: { amount: true },
      }),
      // credit_used = unpaid balance on SALE invoices only
      prisma.invoice.aggregate({
        where: {
          customer_id: customer.id,
          business_id: businessId,
          voucher_type: 'SALE',
          status: { in: ['sent', 'partial'] },
          is_deleted: false,
        },
        _sum: { balance_due: true },
      }),
    ]);

    const activeFy = await getActiveFY(prisma, businessId);
    const ledgerAgg = activeFy
      ? await prisma.ledgerEntry.aggregate({
          where: { business_id: businessId, customer_id: customer.id, financial_year_id: activeFy.id },
          _sum: { debit: true, credit: true },
        })
      : null;

    return res.json({
      ...customer,
      summary: {
        ledgerBalance: ledgerAgg ? (ledgerAgg._sum.debit || 0) - (ledgerAgg._sum.credit || 0) : 0,
        totalBilled: invoiceSummary._sum.total_amount || 0,
        totalPaid: totalPaid._sum.amount || 0,
        outstanding: invoiceSummary._sum.balance_due || 0,
        invoiceCount: invoiceSummary._count.id || 0,
        creditUsed: creditUsed._sum.balance_due || 0,
      },
    });
  } catch (err) {
    console.error('Get customer error:', err);
    return res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// GET /api/customers/:id/ledger — transaction history (FY-scoped), running balance recomputed
router.get('/:id/ledger', attachFinancialYear, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { from, to } = req.query;
    const { page, limit, skip } = pageParams(req.query);

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const base = {
      customer_id: req.params.id,
      business_id: businessId,
      ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}),
    };
    const where = {
      ...base,
      ...(from || to
        ? { entry_date: { ...(from ? { gte: parseDayStart(from) } : {}), ...(to ? { lte: parseDayEnd(to) } : {}) } }
        : {}),
    };

    let opening = 0;
    if (from) {
      const before = await prisma.ledgerEntry.aggregate({
        where: { ...base, entry_date: { lt: parseDayStart(from) } },
        _sum: { debit: true, credit: true },
      });
      opening = (before._sum.debit || 0) - (before._sum.credit || 0);
    }

    const [all, total] = await Promise.all([
      prisma.ledgerEntry.findMany({ where, orderBy: [{ entry_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }] }),
      prisma.ledgerEntry.count({ where }),
    ]);
    let running = opening;
    const withBalance = all.map((e) => {
      running += e.debit - e.credit;
      return { ...e, balance: running };
    });

    return res.json({ entries: withBalance.slice(skip, skip + limit), total, page, limit });
  } catch (err) {
    console.error('Ledger error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// GET /api/customers/:id/invoices — invoices for a customer
router.get('/:id/invoices', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { page, limit, skip } = pageParams(req.query, 20);

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where: { customer_id: req.params.id, business_id: businessId, is_deleted: false },
        orderBy: { invoice_date: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          invoice_number: true,
          invoice_date: true,
          due_date: true,
          status: true,
          total_amount: true,
          amount_paid: true,
          balance_due: true,
        },
      }),
      prisma.invoice.count({
        where: { customer_id: req.params.id, business_id: businessId, is_deleted: false },
      }),
    ]);

    return res.json({ invoices, total, page, limit });
  } catch (err) {
    console.error('Customer invoices error:', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// POST /api/customers — create
router.post('/', async (req, res) => {
  const businessId = req.user.businessId;
  const fields = parseParty(req.body);
  const balanceType = req.body.balance_type === 'CR' ? 'CR' : 'DR';
  if (req.body.balance_type && !['DR', 'CR'].includes(req.body.balance_type)) {
    throw new HttpError(400, "balance_type must be 'DR' or 'CR'", 'VALIDATION');
  }
  const openingPaise = rupeesToPaise(req.body.opening_balance, 'opening balance');
  const creditLimit = rupeesToPaise(req.body.credit_limit, 'credit limit');
  const creditLimitType = ['soft', 'hard'].includes(req.body.credit_limit_type) ? req.body.credit_limit_type : 'soft';
  const creditDays = Math.min(Math.max(parseInt(req.body.credit_days) || 0, 0), 3650);

  const customer = await prisma.$transaction(async (tx) => {
    const created = await tx.customer.create({
      data: {
        business_id: businessId,
        ...fields,
        opening_balance: openingPaise,
        balance_type: balanceType,
        credit_limit: creditLimit,
        credit_limit_type: creditLimitType,
        credit_days: creditDays,
      },
    });

    // The opening balance is a ledger entry INSIDE the active financial year (never year-less),
    // so year-filtered ledgers, balances and carry-forward all see it.
    if (openingPaise > 0) {
      const fy = await getActiveFY(tx, businessId);
      await postCustomerEntry(tx, {
        businessId, customerId: created.id, fyId: fy?.id || null,
        debit: balanceType === 'DR' ? openingPaise : 0,
        credit: balanceType === 'CR' ? openingPaise : 0,
        entryType: 'adjustment', referenceId: created.id, referenceType: 'opening_balance',
        narration: 'Opening balance', entryDate: fy ? (todayDate() < fy.start_date ? fy.start_date : todayDate()) : todayDate(),
      });
    }
    return created;
  });

  return res.status(201).json(customer);
});

// PUT /api/customers/:id — update
router.put('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const existing = await prisma.customer.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  const fields = parseParty(req.body, { partial: true });
  const { credit_limit, credit_limit_type, credit_days } = req.body;

  const updated = await prisma.customer.update({
    where: { id: req.params.id },
    data: {
      ...fields,
      ...(credit_limit !== undefined && { credit_limit: rupeesToPaise(credit_limit, 'credit limit') }),
      ...(credit_limit_type !== undefined && { credit_limit_type: ['soft', 'hard'].includes(credit_limit_type) ? credit_limit_type : 'soft' }),
      ...(credit_days !== undefined && { credit_days: Math.min(Math.max(parseInt(credit_days) || 0, 0), 3650) }),
    },
  });
  return res.json(updated);
});

// GET /api/customers/:id/credit-status
router.get('/:id/credit-status', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { credit_limit: true, credit_limit_type: true, credit_days: true },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const agg = await prisma.invoice.aggregate({
      where: {
        customer_id: req.params.id,
        business_id: businessId,
        voucher_type: 'SALE',
        status: { in: ['sent', 'partial'] },
        is_deleted: false,
      },
      _sum: { balance_due: true },
    });
    const current_outstanding = agg._sum.balance_due || 0;
    const available_credit = customer.credit_limit > 0
      ? Math.max(0, customer.credit_limit - current_outstanding)
      : null;

    return res.json({
      credit_limit: customer.credit_limit,
      credit_limit_type: customer.credit_limit_type,
      credit_days: customer.credit_days,
      current_outstanding,
      available_credit,
      over_limit: customer.credit_limit > 0 && current_outstanding > customer.credit_limit,
    });
  } catch (err) {
    console.error('Credit status error:', err);
    return res.status(500).json({ error: 'Failed to fetch credit status' });
  }
});

// DELETE /api/customers/:id — soft delete
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Block delete if customer has outstanding balance (SALE invoices only)
    const outstanding = await prisma.invoice.aggregate({
      where: {
        customer_id: req.params.id,
        business_id: businessId,
        voucher_type: 'SALE',
        status: { in: ['sent', 'partial'] },
        is_deleted: false,
      },
      _sum: { balance_due: true },
    });
    if ((outstanding._sum.balance_due || 0) > 0) {
      return res.status(400).json({ error: 'Cannot delete customer with outstanding dues' });
    }

    await prisma.customer.update({
      where: { id: req.params.id },
      data: { is_deleted: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete customer error:', err);
    return res.status(500).json({ error: 'Failed to delete customer' });
  }
});

module.exports = router;
