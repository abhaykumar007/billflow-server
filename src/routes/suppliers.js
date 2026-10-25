const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { parseParty, rupeesToPaise, pageParams } = require('../utils/validate');
const { parseDayStart, parseDayEnd, todayDate } = require('../utils/time');
const { postSupplierEntry, getActiveFY } = require('../utils/ledger');

router.use(authenticateToken);

// GET /api/suppliers — list with search + pagination
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

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({
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
          pan: true,
          opening_balance: true,
          balance_type: true,
          created_at: true,
        },
      }),
      prisma.supplier.count({ where }),
    ]);

    return res.json({ suppliers, total, page, limit });
  } catch (err) {
    console.error('List suppliers error:', err);
    return res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// GET /api/suppliers/:id — single supplier with balance summary
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Payable = balance in the CURRENT financial year, which already includes everything
    // carried forward. Summing every year would count carried-forward balances twice.
    const activeFy = await getActiveFY(prisma, businessId);
    const ledgerAgg = activeFy
      ? await prisma.supplierLedgerEntry.aggregate({
          where: { supplier_id: supplier.id, business_id: businessId, financial_year_id: activeFy.id },
          _sum: { debit: true, credit: true },
        })
      : { _sum: {} };

    const totalDebit = ledgerAgg._sum.debit || 0;
    const totalCredit = ledgerAgg._sum.credit || 0;
    // For suppliers: credit > debit means we owe them (payable)
    const payable = totalCredit - totalDebit;

    return res.json({
      ...supplier,
      summary: {
        totalDebit,
        totalCredit,
        payable: Math.max(0, payable),
        balance: payable,
      },
    });
  } catch (err) {
    console.error('Get supplier error:', err);
    return res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

// GET /api/suppliers/:id/ledger — transaction history, running balance recomputed
router.get('/:id/ledger', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { from, to } = req.query;
    const { page, limit, skip } = pageParams(req.query);

    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const fyId = req.headers['x-financial-year-id'];
    const base = { supplier_id: req.params.id, business_id: businessId, ...(fyId ? { financial_year_id: fyId } : {}) };
    const where = {
      ...base,
      ...(from || to
        ? { entry_date: { ...(from ? { gte: parseDayStart(from) } : {}), ...(to ? { lte: parseDayEnd(to) } : {}) } }
        : {}),
    };

    let opening = 0;
    if (from) {
      const before = await prisma.supplierLedgerEntry.aggregate({
        where: { ...base, entry_date: { lt: parseDayStart(from) } },
        _sum: { debit: true, credit: true },
      });
      opening = (before._sum.credit || 0) - (before._sum.debit || 0);
    }

    const [all, total] = await Promise.all([
      prisma.supplierLedgerEntry.findMany({ where, orderBy: [{ entry_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }] }),
      prisma.supplierLedgerEntry.count({ where }),
    ]);
    let running = opening;
    const withBalance = all.map((e) => {
      running += e.credit - e.debit;
      return { ...e, balance: running };
    });

    return res.json({ entries: withBalance.slice(skip, skip + limit), total, page, limit });
  } catch (err) {
    console.error('Supplier ledger error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// GET /api/suppliers/:id/invoices — purchase invoices
router.get('/:id/invoices', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { page, limit, skip } = pageParams(req.query);

    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const where = {
      business_id: businessId,
      supplier_id: supplier.id,
      voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] },
      is_deleted: false,
    };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { invoice_date: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          invoice_number: true,
          voucher_type: true,
          invoice_date: true,
          status: true,
          total_amount: true,
          balance_due: true,
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    return res.json({ invoices, total, page, limit });
  } catch (err) {
    console.error('Supplier invoices error:', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// POST /api/suppliers — create
router.post('/', async (req, res) => {
  const businessId = req.user.businessId;
  const fields = parseParty(req.body);
  const balanceType = req.body.balance_type === 'DR' ? 'DR' : 'CR';
  if (req.body.balance_type && !['DR', 'CR'].includes(req.body.balance_type)) {
    throw new HttpError(400, "balance_type must be 'DR' or 'CR'", 'VALIDATION');
  }
  const openingPaise = rupeesToPaise(req.body.opening_balance, 'opening balance');

  const supplier = await prisma.$transaction(async (tx) => {
    const created = await tx.supplier.create({
      data: { business_id: businessId, ...fields, opening_balance: openingPaise, balance_type: balanceType },
    });

    // CR = we owe the supplier = a CREDIT line; the supplier ledger is positive when payable.
    if (openingPaise > 0) {
      const fy = await getActiveFY(tx, businessId);
      await postSupplierEntry(tx, {
        businessId, supplierId: created.id, fyId: fy?.id || null,
        debit: balanceType === 'DR' ? openingPaise : 0,
        credit: balanceType === 'CR' ? openingPaise : 0,
        entryType: 'adjustment', referenceId: created.id, referenceType: 'opening_balance',
        narration: 'Opening balance', entryDate: fy ? (todayDate() < fy.start_date ? fy.start_date : todayDate()) : todayDate(),
      });
    }
    return created;
  });

  return res.status(201).json(supplier);
});

// PUT /api/suppliers/:id — update
router.put('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const existing = await prisma.supplier.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });

  const fields = parseParty(req.body, { partial: true });
  const updated = await prisma.supplier.update({ where: { id: req.params.id }, data: fields });
  return res.json(updated);
});

// DELETE /api/suppliers/:id — soft delete
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Block delete if supplier has outstanding payable
    const activeFy = await getActiveFY(prisma, businessId);
    const ledgerAgg = await prisma.supplierLedgerEntry.aggregate({
      where: { supplier_id: req.params.id, business_id: businessId, ...(activeFy ? { financial_year_id: activeFy.id } : {}) },
      _sum: { debit: true, credit: true },
    });
    const payable = (ledgerAgg._sum.credit || 0) - (ledgerAgg._sum.debit || 0);
    if (payable > 0) {
      return res.status(400).json({ error: 'Cannot delete supplier with outstanding payable' });
    }

    await prisma.supplier.update({
      where: { id: req.params.id },
      data: { is_deleted: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete supplier error:', err);
    return res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

module.exports = router;
