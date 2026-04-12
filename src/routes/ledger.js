const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);
router.use(attachFinancialYear);

// GET /api/ledger — combined customer ledger entries (used by Payments page Ledger tab)
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  const { customer_id, from, to, limit = 100 } = req.query;

  try {
    const where = {
      business_id: businessId,
      ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}),
      ...(customer_id ? { customer_id } : {}),
      ...(from || to
        ? {
            entry_date: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to + 'T23:59:59') } : {}),
            },
          }
        : {}),
    };

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        orderBy: [{ entry_date: 'desc' }, { created_at: 'desc' }],
        take: parseInt(limit),
        include: { customer: { select: { id: true, name: true } } },
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    return res.json({ entries, total });
  } catch (err) {
    console.error('Ledger root error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger entries' });
  }
});

// ── Customer Ledger ───────────────────────────────────────────────────────────

// GET /api/ledger/customers — list all customers with their current balance
router.get('/customers', async (req, res) => {
  const businessId = req.user.businessId;
  const { search = '' } = req.query;

  try {
    const customers = await prisma.customer.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
        opening_balance: true,
        balance_type: true,
        ledgerEntries: {
          where: req.financialYear ? { financial_year_id: req.financialYear.id } : undefined,
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { balance: true },
        },
      },
    });

    const result = customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      city: c.city,
      // Last entry balance is the running balance; fall back to opening_balance
      balance: c.ledgerEntries.length > 0 ? c.ledgerEntries[0].balance : c.opening_balance,
      balance_type: c.balance_type,
    }));

    return res.json({ customers: result, total: result.length });
  } catch (err) {
    console.error('Ledger customers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch customer balances' });
  }
});

// GET /api/ledger/customers/:id — full ledger for one customer
router.get('/customers/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const financial_year_id = req.query.financial_year_id || req.financialYear?.id || null;

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        city: true,
        state: true,
        gstin: true,
        opening_balance: true,
        balance_type: true,
      },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const where = {
      business_id: businessId,
      customer_id: req.params.id,
    };
    if (financial_year_id) where.financial_year_id = financial_year_id;
    if (from || to) {
      where.entry_date = {};
      if (from) where.entry_date.gte = new Date(from);
      if (to) where.entry_date.lte = new Date(to + 'T23:59:59');
    }

    const entries = await prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ entry_date: 'asc' }, { created_at: 'asc' }],
    });

    // Opening balance for this view:
    // - If the current FY has a carry_forward entry, that entry IS the opening balance
    //   (it's already included in entries), so opening = 0 to avoid double-counting.
    // - Otherwise fall back to the closing balance of the prior FY, or the customer's
    //   initial opening_balance if no prior entries exist.
    let openingBalance = customer.opening_balance;
    if (financial_year_id) {
      const carryForwardEntry = entries.find((e) => e.reference_type === 'carry_forward');
      if (carryForwardEntry) {
        openingBalance = 0;
      } else {
        const prevEntry = await prisma.ledgerEntry.findFirst({
          where: {
            business_id: businessId,
            customer_id: req.params.id,
            financial_year_id: { not: financial_year_id },
          },
          orderBy: { created_at: 'desc' },
        });
        if (prevEntry) openingBalance = prevEntry.balance;
      }
    }

    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
    const closingBalance =
      entries.length > 0 ? entries[entries.length - 1].balance : openingBalance;

    return res.json({
      customer,
      entries,
      summary: {
        opening_balance: openingBalance,
        total_debit: totalDebit,
        total_credit: totalCredit,
        closing_balance: closingBalance,
      },
    });
  } catch (err) {
    console.error('Customer ledger detail error:', err);
    return res.status(500).json({ error: 'Failed to fetch customer ledger' });
  }
});

// ── Supplier Ledger ───────────────────────────────────────────────────────────

// GET /api/ledger/suppliers — list all suppliers with their current balance
router.get('/suppliers', async (req, res) => {
  const businessId = req.user.businessId;
  const { search = '' } = req.query;

  try {
    const suppliers = await prisma.supplier.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
        opening_balance: true,
        balance_type: true,
        ledgerEntries: {
          where: req.financialYear ? { financial_year_id: req.financialYear.id } : undefined,
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { balance: true },
        },
      },
    });

    const result = suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      phone: s.phone,
      email: s.email,
      city: s.city,
      balance: s.ledgerEntries.length > 0 ? s.ledgerEntries[0].balance : s.opening_balance,
      balance_type: s.balance_type,
    }));

    return res.json({ suppliers: result, total: result.length });
  } catch (err) {
    console.error('Ledger suppliers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch supplier balances' });
  }
});

// GET /api/ledger/suppliers/:id — full ledger for one supplier
router.get('/suppliers/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const financial_year_id = req.query.financial_year_id || req.financialYear?.id || null;

  try {
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        city: true,
        state: true,
        gstin: true,
        pan: true,
        opening_balance: true,
        balance_type: true,
      },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const where = {
      business_id: businessId,
      supplier_id: req.params.id,
    };
    if (financial_year_id) where.financial_year_id = financial_year_id;
    if (from || to) {
      where.entry_date = {};
      if (from) where.entry_date.gte = new Date(from);
      if (to) where.entry_date.lte = new Date(to + 'T23:59:59');
    }

    const entries = await prisma.supplierLedgerEntry.findMany({
      where,
      orderBy: [{ entry_date: 'asc' }, { created_at: 'asc' }],
    });

    // Opening balance for this view:
    // - If the current FY has a carry_forward entry, that entry IS the opening balance
    //   (it's already included in entries), so opening = 0 to avoid double-counting.
    // - Otherwise fall back to the closing balance of the prior FY, or the supplier's
    //   initial opening_balance if no prior entries exist.
    let openingBalance = supplier.opening_balance;
    if (financial_year_id) {
      const carryForwardEntry = entries.find((e) => e.reference_type === 'carry_forward');
      if (carryForwardEntry) {
        openingBalance = 0;
      } else {
        const prevEntry = await prisma.supplierLedgerEntry.findFirst({
          where: {
            business_id: businessId,
            supplier_id: req.params.id,
            financial_year_id: { not: financial_year_id },
          },
          orderBy: { created_at: 'desc' },
        });
        if (prevEntry) openingBalance = prevEntry.balance;
      }
    }

    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
    const closingBalance =
      entries.length > 0 ? entries[entries.length - 1].balance : openingBalance;

    return res.json({
      supplier,
      entries,
      summary: {
        opening_balance: openingBalance,
        total_debit: totalDebit,
        total_credit: totalCredit,
        closing_balance: closingBalance,
      },
    });
  } catch (err) {
    console.error('Supplier ledger detail error:', err);
    return res.status(500).json({ error: 'Failed to fetch supplier ledger' });
  }
});

module.exports = router;
