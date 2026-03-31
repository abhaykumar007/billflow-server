const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { checkInvoiceLimit } = require('../middleware/planLimit');

router.use(authenticateToken);

// GET /api/invoices/next-number — must be before /:id
router.get('/next-number', async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: {
        invoice_prefix: true,
        invoice_next_number: true,
        financial_year_start: true,
      },
    });

    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const fyStart = business.financial_year_start || 4;
    const year = month >= fyStart ? now.getFullYear() : now.getFullYear() - 1;
    const number = String(business.invoice_next_number).padStart(4, '0');
    const invoiceNumber = `${business.invoice_prefix}-${year}-${number}`;

    res.json({ invoiceNumber, nextNumber: business.invoice_next_number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch next invoice number' });
  }
});

// GET /api/invoices
router.get('/', async (req, res) => {
  try {
    const { status, customerId, from, to, search, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      business_id: req.user.businessId,
      is_deleted: false,
    };

    if (status === 'unpaid') {
      where.status = { in: ['sent', 'partial'] };
    } else if (status) {
      where.status = status;
    }

    if (customerId) where.customer_id = customerId;

    if (from || to) {
      where.invoice_date = {};
      if (from) where.invoice_date.gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        where.invoice_date.lte = toDate;
      }
    }

    if (search) {
      where.OR = [
        { invoice_number: { contains: search, mode: 'insensitive' } },
        { customer: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { invoice_date: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ invoices, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: req.params.id,
        business_id: req.user.businessId,
        is_deleted: false,
      },
      include: {
        customer: true,
        items: {
          include: {
            product: { select: { id: true, name: true, unit: true } },
          },
          orderBy: { created_at: 'asc' },
        },
        payments: {
          where: { is_reversed: false },
          orderBy: { payment_date: 'desc' },
        },
        creator: { select: { id: true, name: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices
router.post('/', checkInvoiceLimit, async (req, res) => {
  try {
    const {
      customer_id,
      invoice_number: providedNumber,
      invoice_date,
      due_date,
      status = 'draft',
      items,
      discount_amount = 0,
      notes,
      terms,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'Customer is required' });
    if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

    const customer = await prisma.customer.findFirst({
      where: { id: customer_id, business_id: req.user.businessId, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Recalculate totals server-side from submitted items (values in paise)
    const subtotal = items.reduce((sum, item) => sum + Math.round(item.amount || 0), 0);
    const tax_amount = items.reduce((sum, item) => sum + Math.round(item.tax_amount || 0), 0);
    const total_amount = subtotal - Math.round(discount_amount) + tax_amount;
    const balance_due = total_amount;

    const invoice = await prisma.$transaction(async (tx) => {
      // Determine invoice number
      let finalNumber = providedNumber;
      if (!finalNumber) {
        const business = await tx.business.findUnique({
          where: { id: req.user.businessId },
          select: {
            invoice_prefix: true,
            invoice_next_number: true,
            financial_year_start: true,
          },
        });
        const now = new Date();
        const month = now.getMonth() + 1;
        const fyStart = business.financial_year_start || 4;
        const year = month >= fyStart ? now.getFullYear() : now.getFullYear() - 1;
        finalNumber = `${business.invoice_prefix}-${year}-${String(business.invoice_next_number).padStart(4, '0')}`;
      }

      // Ensure uniqueness
      const existing = await tx.invoice.findFirst({
        where: {
          business_id: req.user.businessId,
          invoice_number: finalNumber,
          is_deleted: false,
        },
      });
      if (existing) throw Object.assign(new Error('Invoice number already exists'), { code: 'DUPLICATE_NUMBER' });

      const newInvoice = await tx.invoice.create({
        data: {
          business_id: req.user.businessId,
          customer_id,
          invoice_number: finalNumber,
          invoice_date: invoice_date ? new Date(invoice_date) : new Date(),
          due_date: due_date ? new Date(due_date) : null,
          status,
          subtotal,
          discount_amount: Math.round(discount_amount),
          tax_amount,
          total_amount,
          amount_paid: 0,
          balance_due,
          notes: notes || null,
          terms: terms || null,
          created_by: req.user.userId,
          items: {
            create: items.map((item) => ({
              product_id: item.product_id || null,
              description: item.description,
              quantity: Number(item.quantity),
              unit: item.unit || 'pcs',
              rate: Math.round(item.rate || 0),
              discount_percent: Number(item.discount_percent || 0),
              tax_rate: Number(item.tax_rate || 0),
              tax_amount: Math.round(item.tax_amount || 0),
              amount: Math.round(item.amount || 0),
            })),
          },
        },
        include: { customer: true, items: true },
      });

      // Increment counter
      await tx.business.update({
        where: { id: req.user.businessId },
        data: { invoice_next_number: { increment: 1 } },
      });

      // Ledger entry only for non-draft
      if (status !== 'draft') {
        const lastEntry = await tx.ledgerEntry.findFirst({
          where: { business_id: req.user.businessId, customer_id },
          orderBy: { created_at: 'desc' },
        });
        const prevBalance = lastEntry ? lastEntry.balance : 0;

        await tx.ledgerEntry.create({
          data: {
            business_id: req.user.businessId,
            customer_id,
            entry_type: 'invoice',
            reference_id: newInvoice.id,
            reference_type: 'Invoice',
            debit: total_amount,
            credit: 0,
            balance: prevBalance + total_amount,
            narration: `Invoice ${finalNumber}`,
            entry_date: invoice_date ? new Date(invoice_date) : new Date(),
          },
        });

        // Deduct inventory
        for (const item of items) {
          if (item.product_id) {
            const product = await tx.product.findUnique({ where: { id: item.product_id } });
            if (product?.track_inventory) {
              await tx.product.update({
                where: { id: item.product_id },
                data: { stock_quantity: { decrement: Math.round(Number(item.quantity)) } },
              });
            }
          }
        }
      }

      return newInvoice;
    });

    res.status(201).json(invoice);
  } catch (err) {
    console.error(err);
    if (err.code === 'DUPLICATE_NUMBER') {
      return res.status(400).json({ error: 'Invoice number already exists' });
    }
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// PUT /api/invoices/:id — only drafts can be edited
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be edited' });

    const { customer_id, invoice_date, due_date, items, discount_amount = 0, notes, terms } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

    const subtotal = items.reduce((sum, item) => sum + Math.round(item.amount || 0), 0);
    const tax_amount = items.reduce((sum, item) => sum + Math.round(item.tax_amount || 0), 0);
    const total_amount = subtotal - Math.round(discount_amount) + tax_amount;
    const balance_due = total_amount - existing.amount_paid;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoice_id: req.params.id } });

      return tx.invoice.update({
        where: { id: req.params.id },
        data: {
          customer_id: customer_id || existing.customer_id,
          invoice_date: invoice_date ? new Date(invoice_date) : existing.invoice_date,
          due_date: due_date ? new Date(due_date) : existing.due_date,
          subtotal,
          discount_amount: Math.round(discount_amount),
          tax_amount,
          total_amount,
          balance_due,
          notes: notes || null,
          terms: terms || null,
          items: {
            create: items.map((item) => ({
              product_id: item.product_id || null,
              description: item.description,
              quantity: Number(item.quantity),
              unit: item.unit || 'pcs',
              rate: Math.round(item.rate || 0),
              discount_percent: Number(item.discount_percent || 0),
              tax_rate: Number(item.tax_rate || 0),
              tax_amount: Math.round(item.tax_amount || 0),
              amount: Math.round(item.amount || 0),
            })),
          },
        },
        include: { customer: true, items: true },
      });
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// POST /api/invoices/:id/send — finalize a draft invoice
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be sent' });

    const updated = await prisma.$transaction(async (tx) => {
      const updatedInvoice = await tx.invoice.update({
        where: { id: req.params.id },
        data: { status: 'sent' },
      });

      // Create ledger debit entry
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { business_id: req.user.businessId, customer_id: invoice.customer_id },
        orderBy: { created_at: 'desc' },
      });
      const prevBalance = lastEntry ? lastEntry.balance : 0;

      await tx.ledgerEntry.create({
        data: {
          business_id: req.user.businessId,
          customer_id: invoice.customer_id,
          entry_type: 'invoice',
          reference_id: req.params.id,
          reference_type: 'Invoice',
          debit: invoice.total_amount,
          credit: 0,
          balance: prevBalance + invoice.total_amount,
          narration: `Invoice ${invoice.invoice_number}`,
          entry_date: invoice.invoice_date,
        },
      });

      // Deduct inventory
      const items = await tx.invoiceItem.findMany({ where: { invoice_id: req.params.id } });
      for (const item of items) {
        if (item.product_id) {
          const product = await tx.product.findUnique({ where: { id: item.product_id } });
          if (product?.track_inventory) {
            await tx.product.update({
              where: { id: item.product_id },
              data: { stock_quantity: { decrement: Math.round(item.quantity) } },
            });
          }
        }
      }

      return updatedInvoice;
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send invoice' });
  }
});

// DELETE /api/invoices/:id — cancel invoice
router.delete('/:id', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Cannot cancel a fully paid invoice' });

    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: req.params.id },
        data: { status: 'cancelled', is_deleted: true },
      });

      // Reversal ledger entry for sent/partial invoices
      if (['sent', 'partial'].includes(invoice.status)) {
        const lastEntry = await tx.ledgerEntry.findFirst({
          where: { business_id: req.user.businessId, customer_id: invoice.customer_id },
          orderBy: { created_at: 'desc' },
        });
        const prevBalance = lastEntry ? lastEntry.balance : 0;
        const reversalAmount = invoice.total_amount - invoice.amount_paid;

        await tx.ledgerEntry.create({
          data: {
            business_id: req.user.businessId,
            customer_id: invoice.customer_id,
            entry_type: 'adjustment',
            reference_id: req.params.id,
            reference_type: 'Invoice',
            debit: 0,
            credit: reversalAmount,
            balance: prevBalance - reversalAmount,
            narration: `Cancelled: Invoice ${invoice.invoice_number}`,
            entry_date: new Date(),
          },
        });

        // Restore inventory
        const items = await tx.invoiceItem.findMany({ where: { invoice_id: req.params.id } });
        for (const item of items) {
          if (item.product_id) {
            const product = await tx.product.findUnique({ where: { id: item.product_id } });
            if (product?.track_inventory) {
              await tx.product.update({
                where: { id: item.product_id },
                data: { stock_quantity: { increment: Math.round(item.quantity) } },
              });
            }
          }
        }
      }
    });

    res.json({ message: 'Invoice cancelled successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel invoice' });
  }
});

module.exports = router;
