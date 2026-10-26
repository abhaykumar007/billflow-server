const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');
const { parseDayStart, parseDayEnd } = require('../utils/time');

router.use(authenticateToken);
router.use(attachFinancialYear);

// Running balances are always RECOMPUTED here from debit/credit in (entry_date, created_at)
// order, so back-dated entries can never leave the displayed running balance out of order.
//   customer: + = customer owes us    (debit − credit)
//   supplier: + = we owe the supplier (credit − debit)
function withRunningBalance(entries, opening, sign) {
  let running = opening;
  return entries.map((e) => {
    running += sign * (e.debit - e.credit);
    return { ...e, balance: running };
  });
}

const orderAsc = [{ entry_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }];

function dateRange(from, to) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: parseDayStart(from) } : {}),
    ...(to ? { lte: parseDayEnd(to) } : {}),
  };
}

// GET /api/ledger — combined customer ledger entries (used by Payments page Ledger tab)
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  const { customer_id, from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);

  const where = {
    business_id: businessId,
    ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}),
    ...(customer_id ? { customer_id } : {}),
    ...(from || to ? { entry_date: dateRange(from, to) } : {}),
  };

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ entry_date: 'desc' }, { created_at: 'desc' }],
      take: limit,
      include: { customer: { select: { id: true, name: true } } },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);
  return res.json({ entries, total });
});

// ── Customer Ledger ───────────────────────────────────────────────────────────

// GET /api/ledger/customers — all customers with their balance in the selected year
router.get('/customers', async (req, res) => {
  const businessId = req.user.businessId;
  const { search = '' } = req.query;

  const [customers, totals] = await Promise.all([
    prisma.customer.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        ...(search
          ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true, email: true, city: true, opening_balance: true, balance_type: true },
    }),
    prisma.ledgerEntry.groupBy({
      by: ['customer_id'],
      where: { business_id: businessId, ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}) },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const balanceOf = new Map(totals.map((t) => [t.customer_id, (t._sum.debit || 0) - (t._sum.credit || 0)]));

  const result = customers.map((c) => ({
    id: c.id, name: c.name, phone: c.phone, email: c.email, city: c.city,
    balance: balanceOf.get(c.id) || 0,
    balance_type: c.balance_type,
  }));
  return res.json({ customers: result, total: result.length });
});

// GET /api/ledger/customers/:id — full ledger for one customer
router.get('/customers/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const fyId = req.query.financial_year_id || req.financialYear?.id || null;

  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
    select: {
      id: true, name: true, phone: true, email: true, address: true, city: true, state: true,
      gstin: true, opening_balance: true, balance_type: true,
    },
  });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const base = { business_id: businessId, customer_id: req.params.id, ...(fyId ? { financial_year_id: fyId } : {}) };

  // Opening for the view = everything in the year before `from` (the year's own
  // carry-forward / opening-balance lines are ordinary entries and are included).
  let opening = 0;
  if (from) {
    const before = await prisma.ledgerEntry.aggregate({
      where: { ...base, entry_date: { lt: parseDayStart(from) } },
      _sum: { debit: true, credit: true },
    });
    opening = (before._sum.debit || 0) - (before._sum.credit || 0);
  }

  const raw = await prisma.ledgerEntry.findMany({
    where: { ...base, ...(from || to ? { entry_date: dateRange(from, to) } : {}) },
    orderBy: orderAsc,
  });
  const entries = withRunningBalance(raw, opening, +1);

  const totalDebit = raw.reduce((s, e) => s + e.debit, 0);
  const totalCredit = raw.reduce((s, e) => s + e.credit, 0);

  return res.json({
    customer,
    entries,
    summary: {
      opening_balance: opening,
      total_debit: totalDebit,
      total_credit: totalCredit,
      closing_balance: opening + totalDebit - totalCredit,
    },
  });
});

// ── Supplier Ledger ───────────────────────────────────────────────────────────

// GET /api/ledger/suppliers — all suppliers with their balance in the selected year
router.get('/suppliers', async (req, res) => {
  const businessId = req.user.businessId;
  const { search = '' } = req.query;

  const [suppliers, totals] = await Promise.all([
    prisma.supplier.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        ...(search
          ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true, email: true, city: true, opening_balance: true, balance_type: true },
    }),
    prisma.supplierLedgerEntry.groupBy({
      by: ['supplier_id'],
      where: { business_id: businessId, ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}) },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const balanceOf = new Map(totals.map((t) => [t.supplier_id, (t._sum.credit || 0) - (t._sum.debit || 0)]));

  const result = suppliers.map((s) => ({
    id: s.id, name: s.name, phone: s.phone, email: s.email, city: s.city,
    balance: balanceOf.get(s.id) || 0, // + = payable
    balance_type: s.balance_type,
  }));
  return res.json({ suppliers: result, total: result.length });
});

// GET /api/ledger/suppliers/:id — full ledger for one supplier
router.get('/suppliers/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const fyId = req.query.financial_year_id || req.financialYear?.id || null;

  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
    select: {
      id: true, name: true, phone: true, email: true, address: true, city: true, state: true,
      gstin: true, pan: true, opening_balance: true, balance_type: true,
    },
  });
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

  const base = { business_id: businessId, supplier_id: req.params.id, ...(fyId ? { financial_year_id: fyId } : {}) };

  let opening = 0;
  if (from) {
    const before = await prisma.supplierLedgerEntry.aggregate({
      where: { ...base, entry_date: { lt: parseDayStart(from) } },
      _sum: { debit: true, credit: true },
    });
    opening = (before._sum.credit || 0) - (before._sum.debit || 0);
  }

  const raw = await prisma.supplierLedgerEntry.findMany({
    where: { ...base, ...(from || to ? { entry_date: dateRange(from, to) } : {}) },
    orderBy: orderAsc,
  });
  const entries = withRunningBalance(raw, opening, -1);

  const totalDebit = raw.reduce((s, e) => s + e.debit, 0);
  const totalCredit = raw.reduce((s, e) => s + e.credit, 0);

  return res.json({
    supplier,
    entries,
    summary: {
      opening_balance: opening,
      total_debit: totalDebit,
      total_credit: totalCredit,
      closing_balance: opening + totalCredit - totalDebit,
    },
  });
});

module.exports = router;
