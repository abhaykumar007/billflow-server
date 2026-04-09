const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/suppliers — list with search + pagination
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

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({
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
          pan: true,
          opening_balance: true,
          balance_type: true,
          created_at: true,
        },
      }),
      prisma.supplier.count({ where }),
    ]);

    return res.json({ suppliers, total, page: parseInt(page), limit: parseInt(limit) });
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

    // Aggregate from supplier ledger entries
    const ledgerAgg = await prisma.supplierLedgerEntry.aggregate({
      where: { supplier_id: supplier.id, business_id: businessId },
      _sum: { debit: true, credit: true },
    });

    const totalDebit = ledgerAgg._sum.debit || 0;
    const totalCredit = ledgerAgg._sum.credit || 0;
    // For suppliers: CR means you owe them (credit > debit = payable)
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

// GET /api/suppliers/:id/ledger — transaction history
router.get('/:id/ledger', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { from, to, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
      select: { id: true },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const where = {
      supplier_id: req.params.id,
      business_id: businessId,
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
      prisma.supplierLedgerEntry.findMany({
        where,
        orderBy: { entry_date: 'asc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.supplierLedgerEntry.count({ where }),
    ]);

    return res.json({ entries, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Supplier ledger error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// GET /api/suppliers/:id/invoices — purchase invoices
router.get('/:id/invoices', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const { limit = 50, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

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
        take: parseInt(limit),
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

    return res.json({ invoices, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Supplier invoices error:', err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// POST /api/suppliers — create
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
      pan,
      opening_balance = 0,
      balance_type = 'CR',
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const supplier = await prisma.supplier.create({
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
        pan: pan?.trim() || null,
        opening_balance: Math.round((parseFloat(opening_balance) || 0) * 100),
        balance_type,
      },
    });

    // Create opening balance ledger entry if non-zero
    const obAmount = parseFloat(opening_balance) || 0;
    if (obAmount !== 0) {
      await prisma.supplierLedgerEntry.create({
        data: {
          business_id: businessId,
          supplier_id: supplier.id,
          entry_type: 'adjustment',
          reference_id: supplier.id,
          reference_type: 'opening_balance',
          // CR balance_type means you owe them → credit entry
          debit: balance_type === 'DR' ? Math.round(obAmount * 100) : 0,
          credit: balance_type === 'CR' ? Math.round(obAmount * 100) : 0,
          balance: balance_type === 'CR' ? -Math.round(obAmount * 100) : Math.round(obAmount * 100),
          narration: 'Opening balance',
          entry_date: new Date(),
        },
      });
    }

    return res.status(201).json(supplier);
  } catch (err) {
    console.error('Create supplier error:', err);
    const msg = process.env.NODE_ENV === 'development' ? err.message : 'Failed to create supplier';
    return res.status(500).json({ error: msg });
  }
});

// PUT /api/suppliers/:id — update
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const existing = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Supplier not found' });

    const { name, phone, email, address, city, state, pincode, gstin, pan } = req.body;

    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }

    const updated = await prisma.supplier.update({
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
        ...(pan !== undefined && { pan: pan.trim() || null }),
      },
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update supplier error:', err);
    return res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// DELETE /api/suppliers/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const supplier = await prisma.supplier.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // Block delete if supplier has outstanding payable
    const ledgerAgg = await prisma.supplierLedgerEntry.aggregate({
      where: { supplier_id: req.params.id, business_id: businessId },
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
