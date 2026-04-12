const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);

// GET /api/customers — list with search + pagination
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { search = '', page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

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
        take: parseInt(limit),
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

    const enriched = customers.map((c) => ({
      ...c,
      outstanding: outstandingMap[c.id] || 0,
    }));

    return res.json({ customers: enriched, total, page: parseInt(page), limit: parseInt(limit) });
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

    return res.json({
      ...customer,
      summary: {
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

// GET /api/customers/:id/ledger — transaction history (FY-scoped)
router.get('/:id/ledger', attachFinancialYear, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { from, to, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const where = {
      customer_id: req.params.id,
      business_id: businessId,
      ...(req.financialYear ? { financial_year_id: req.financialYear.id } : {}),
      ...(from || to
        ? {
            entry_date: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        orderBy: { entry_date: 'asc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    return res.json({ entries, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Ledger error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// GET /api/customers/:id/invoices — invoices for a customer
router.get('/:id/invoices', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

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
        take: parseInt(limit),
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

    return res.json({ invoices, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Customer invoices error:', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// POST /api/customers — create
router.post('/', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const {
      name,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      gstin,
      opening_balance = 0,
      balance_type = 'DR',
      credit_limit = 0,
      credit_limit_type = 'soft',
      credit_days = 0,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const customer = await prisma.customer.create({
      data: {
        business_id: businessId,
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        state: state?.trim() || null,
        pincode: pincode?.trim() || null,
        gstin: gstin?.trim() || null,
        opening_balance: Math.round(opening_balance * 100), // rupees → paise
        balance_type,
        credit_limit: Math.round((parseFloat(credit_limit) || 0) * 100), // rupees → paise
        credit_limit_type: ['soft', 'hard'].includes(credit_limit_type) ? credit_limit_type : 'soft',
        credit_days: parseInt(credit_days) || 0,
      },
    });

    // Create opening balance ledger entry if non-zero
    const obAmount = parseFloat(opening_balance) || 0;
    if (obAmount !== 0) {
      await prisma.ledgerEntry.create({
        data: {
          business_id: businessId,
          customer_id: customer.id,
          entry_type: 'adjustment',
          reference_id: customer.id,
          reference_type: 'opening_balance',
          debit: balance_type === 'DR' ? Math.round(obAmount * 100) : 0,
          credit: balance_type === 'CR' ? Math.round(obAmount * 100) : 0,
          balance: balance_type === 'CR' ? -Math.round(obAmount * 100) : Math.round(obAmount * 100),
          narration: 'Opening balance',
          entry_date: new Date(),
        },
      });
    }

    return res.status(201).json(customer);
  } catch (err) {
    console.error('Create customer error:', err);
    const msg = process.env.NODE_ENV === 'development' ? err.message : 'Failed to create customer';
    return res.status(500).json({ error: msg });
  }
});

// PUT /api/customers/:id — update
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.customer.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Customer not found' });

    const {
      name,
      phone,
      email,
      address,
      city,
      state,
      pincode,
      gstin,
      credit_limit,
      credit_limit_type,
      credit_days,
    } = req.body;

    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    const updated = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(phone !== undefined && { phone: phone.trim() || null }),
        ...(email !== undefined && { email: email.trim() || null }),
        ...(address !== undefined && { address: address.trim() || null }),
        ...(city !== undefined && { city: city.trim() || null }),
        ...(state !== undefined && { state: state.trim() || null }),
        ...(pincode !== undefined && { pincode: pincode.trim() || null }),
        ...(gstin !== undefined && { gstin: gstin.trim() || null }),
        ...(credit_limit !== undefined && { credit_limit: Math.round((parseFloat(credit_limit) || 0) * 100) }),
        ...(credit_limit_type !== undefined && { credit_limit_type: ['soft', 'hard'].includes(credit_limit_type) ? credit_limit_type : 'soft' }),
        ...(credit_days !== undefined && { credit_days: parseInt(credit_days) || 0 }),
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update customer error:', err);
    return res.status(500).json({ error: 'Failed to update customer' });
  }
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
router.delete('/:id', async (req, res) => {
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
