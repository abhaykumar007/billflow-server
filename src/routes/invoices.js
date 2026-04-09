const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { checkInvoiceLimit } = require('../middleware/planLimit');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);

const SALE_TYPES = ['SALE', 'SALE_RETURN'];
const PURCHASE_TYPES = ['PURCHASE', 'PURCHASE_RETURN'];

const VOUCHER_PREFIX = {
  SALE: 'SINV',
  PURCHASE: 'PINV',
  SALE_RETURN: 'SRET',
  PURCHASE_RETURN: 'PRET',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Builds the FY short code from start_date, e.g. April 2025 → "2526"
function fyCode(financialYear) {
  const startYear = new Date(financialYear.start_date).getFullYear();
  const endYear = startYear + 1;
  return `${String(startYear).slice(2)}${String(endYear).slice(2)}`;
}

async function getNextInvoiceNumber(tx, voucherType, financialYear, businessId) {
  const isPurchase = PURCHASE_TYPES.includes(voucherType);
  const [fy, business] = await Promise.all([
    tx.financialYear.findUnique({
      where: { id: financialYear.id },
      select: { invoice_next_number: true, purchase_next_number: true },
    }),
    businessId
      ? tx.business.findUnique({ where: { id: businessId }, select: { invoice_prefix: true, purchase_prefix: true } })
      : null,
  ]);
  const nextNum = isPurchase ? fy.purchase_next_number : fy.invoice_next_number;
  // Use user-configured prefix for main types; fall back to hardcoded for returns
  let prefix;
  if (voucherType === 'SALE') prefix = business?.invoice_prefix || 'INV';
  else if (voucherType === 'PURCHASE') prefix = business?.purchase_prefix || 'PUR';
  else prefix = VOUCHER_PREFIX[voucherType] || 'INV';
  const code = fyCode(financialYear);
  return {
    invoiceNumber: `${prefix}-${code}-${String(nextNum).padStart(4, '0')}`,
    isPurchase,
  };
}

async function incrementCounter(tx, financialYearId, isPurchase) {
  await tx.financialYear.update({
    where: { id: financialYearId },
    data: isPurchase
      ? { purchase_next_number: { increment: 1 } }
      : { invoice_next_number: { increment: 1 } },
  });
}

// Adjust stock: direction +1 = increment, -1 = decrement
async function adjustInventory(tx, items, direction) {
  for (const item of items) {
    if (item.product_id) {
      const product = await tx.product.findUnique({ where: { id: item.product_id } });
      if (product?.track_inventory) {
        await tx.product.update({
          where: { id: item.product_id },
          data: { stock_quantity: { increment: direction * Math.round(Number(item.quantity)) } },
        });
      }
    }
  }
}

// Write to customer ledger
async function writeCustomerLedger(tx, businessId, customerId, amount, invoiceNumber, invoiceDate, isCredit = false, financialYearId = null) {
  const last = await tx.ledgerEntry.findFirst({
    where: { business_id: businessId, customer_id: customerId, financial_year_id: financialYearId },
    orderBy: { created_at: 'desc' },
  });
  const prev = last ? last.balance : 0;
  await tx.ledgerEntry.create({
    data: {
      business_id: businessId,
      financial_year_id: financialYearId,
      customer_id: customerId,
      entry_type: 'invoice',
      reference_type: 'Invoice',
      debit: isCredit ? 0 : amount,
      credit: isCredit ? amount : 0,
      balance: isCredit ? prev - amount : prev + amount,
      narration: isCredit ? `Credit Note ${invoiceNumber}` : `Invoice ${invoiceNumber}`,
      entry_date: invoiceDate,
    },
  });
}

// Write to supplier ledger
async function writeSupplierLedger(tx, businessId, supplierId, amount, invoiceNumber, invoiceDate, isDebit = false, financialYearId = null) {
  const last = await tx.supplierLedgerEntry.findFirst({
    where: { business_id: businessId, supplier_id: supplierId, financial_year_id: financialYearId },
    orderBy: { created_at: 'desc' },
  });
  const prev = last ? last.balance : 0;
  await tx.supplierLedgerEntry.create({
    data: {
      business_id: businessId,
      financial_year_id: financialYearId,
      supplier_id: supplierId,
      entry_type: 'invoice',
      reference_type: 'Invoice',
      debit: isDebit ? amount : 0,
      credit: isDebit ? 0 : amount,
      balance: isDebit ? prev - amount : prev + amount,
      narration: isDebit ? `Debit Note ${invoiceNumber}` : `Purchase ${invoiceNumber}`,
      entry_date: invoiceDate,
    },
  });
}

// ── GET /api/invoices/next-number ─────────────────────────────────────────────
router.get('/next-number', attachFinancialYear, async (req, res) => {
  try {
    if (!req.financialYear) {
      return res.status(400).json({ error: 'No active financial year. Please select or create a financial year first.' });
    }
    const { type = 'SALE' } = req.query;
    const isPurchase = PURCHASE_TYPES.includes(type);
    const [fy, business] = await Promise.all([
      prisma.financialYear.findUnique({
        where: { id: req.financialYear.id },
        select: { invoice_next_number: true, purchase_next_number: true },
      }),
      prisma.business.findUnique({
        where: { id: req.user.businessId },
        select: { invoice_prefix: true, purchase_prefix: true },
      }),
    ]);
    const nextNum = isPurchase ? fy.purchase_next_number : fy.invoice_next_number;
    let prefix;
    if (type === 'SALE') prefix = business?.invoice_prefix || 'INV';
    else if (type === 'PURCHASE') prefix = business?.purchase_prefix || 'PUR';
    else prefix = VOUCHER_PREFIX[type] || 'INV';
    const code = fyCode(req.financialYear);
    const invoiceNumber = `${prefix}-${code}-${String(nextNum).padStart(4, '0')}`;

    res.json({ invoiceNumber, nextNumber: nextNum });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch next invoice number' });
  }
});

// ── GET /api/invoices ─────────────────────────────────────────────────────────
router.get('/', attachFinancialYear, async (req, res) => {
  try {
    const { status, customerId, supplierId, type, from, to, search, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      business_id: req.user.businessId,
      is_deleted: false,
    };

    if (req.financialYear) {
      where.financial_year_id = req.financialYear.id;
    }

    if (status === 'unpaid') {
      where.status = { in: ['sent', 'partial'] };
    } else if (status) {
      where.status = status;
    }

    if (type === 'sales') {
      where.voucher_type = { in: ['SALE', 'SALE_RETURN'] };
    } else if (type === 'purchases') {
      where.voucher_type = { in: ['PURCHASE', 'PURCHASE_RETURN'] };
    } else if (type === 'returns') {
      where.voucher_type = { in: ['SALE_RETURN', 'PURCHASE_RETURN'] };
    }

    if (customerId) where.customer_id = customerId;
    if (supplierId) where.supplier_id = supplierId;

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
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          supplier: { select: { id: true, name: true, phone: true } },
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

// ── GET /api/invoices/:id ─────────────────────────────────────────────────────
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
        supplier: true,
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
        linked_invoice: {
          select: { id: true, invoice_number: true, voucher_type: true, invoice_date: true },
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

// ── POST /api/invoices ────────────────────────────────────────────────────────
router.post('/', attachFinancialYear, checkInvoiceLimit, async (req, res) => {
  try {
    const {
      voucher_type = 'SALE',
      customer_id,
      supplier_id,
      linked_invoice_id,
      invoice_number: providedNumber,
      invoice_date,
      due_date,
      status = 'draft',
      items,
      discount_amount = 0,
      notes,
      terms,
    } = req.body;

    if (!req.financialYear) {
      return res.status(400).json({ error: 'No active financial year. Please select or create a financial year first.' });
    }

    if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

    const isSaleType = SALE_TYPES.includes(voucher_type);
    const isPurchaseType = PURCHASE_TYPES.includes(voucher_type);

    if (!isSaleType && !isPurchaseType) {
      return res.status(400).json({ error: 'Invalid voucher_type' });
    }

    // Validate party
    if (isSaleType) {
      if (!customer_id) return res.status(400).json({ error: 'Customer is required for sale invoices' });
      const customer = await prisma.customer.findFirst({
        where: { id: customer_id, business_id: req.user.businessId, is_deleted: false },
      });
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
    } else {
      if (!supplier_id) return res.status(400).json({ error: 'Supplier is required for purchase invoices' });
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplier_id, business_id: req.user.businessId, is_deleted: false },
      });
      if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    }

    const subtotal = items.reduce((sum, item) => sum + Math.round(item.amount || 0), 0);
    const tax_amount = items.reduce((sum, item) => sum + Math.round(item.tax_amount || 0), 0);
    const total_amount = subtotal - Math.round(discount_amount) + tax_amount;

    const invoice = await prisma.$transaction(async (tx) => {
      let finalNumber = providedNumber;
      if (!finalNumber) {
        const { invoiceNumber } = await getNextInvoiceNumber(tx, voucher_type, req.financialYear, req.user.businessId);
        finalNumber = invoiceNumber;
      }

      const existing = await tx.invoice.findFirst({
        where: { business_id: req.user.businessId, invoice_number: finalNumber, is_deleted: false },
      });
      if (existing) throw Object.assign(new Error('Invoice number already exists'), { code: 'DUPLICATE_NUMBER' });

      const newInvoice = await tx.invoice.create({
        data: {
          business_id: req.user.businessId,
          financial_year_id: req.financialYear.id,
          voucher_type,
          customer_id: isSaleType ? customer_id : null,
          supplier_id: isPurchaseType ? supplier_id : null,
          linked_invoice_id: linked_invoice_id || null,
          invoice_number: finalNumber,
          invoice_date: invoice_date ? new Date(invoice_date) : new Date(),
          due_date: due_date ? new Date(due_date) : null,
          status,
          subtotal,
          discount_amount: Math.round(discount_amount),
          tax_amount,
          total_amount,
          amount_paid: 0,
          balance_due: total_amount,
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
        include: { customer: true, supplier: true, items: true },
      });

      await incrementCounter(tx, req.financialYear.id, isPurchaseType);

      if (status !== 'draft') {
        const entryDate = invoice_date ? new Date(invoice_date) : new Date();

        const fyId = req.financialYear.id;
        if (voucher_type === 'SALE') {
          await writeCustomerLedger(tx, req.user.businessId, customer_id, total_amount, finalNumber, entryDate, false, fyId);
          await adjustInventory(tx, items, -1); // decrement stock
        } else if (voucher_type === 'SALE_RETURN') {
          await writeCustomerLedger(tx, req.user.businessId, customer_id, total_amount, finalNumber, entryDate, true, fyId);
          await adjustInventory(tx, items, +1); // restore stock
        } else if (voucher_type === 'PURCHASE') {
          await writeSupplierLedger(tx, req.user.businessId, supplier_id, total_amount, finalNumber, entryDate, false, fyId);
          await adjustInventory(tx, items, +1); // increment stock
        } else if (voucher_type === 'PURCHASE_RETURN') {
          await writeSupplierLedger(tx, req.user.businessId, supplier_id, total_amount, finalNumber, entryDate, true, fyId);
          await adjustInventory(tx, items, -1); // decrement stock
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

// ── PUT /api/invoices/:id — only drafts can be edited ─────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be edited' });

    const { customer_id, supplier_id, invoice_date, due_date, items, discount_amount = 0, notes, terms } = req.body;

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
          customer_id: customer_id !== undefined ? (customer_id || null) : existing.customer_id,
          supplier_id: supplier_id !== undefined ? (supplier_id || null) : existing.supplier_id,
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
        include: { customer: true, supplier: true, items: true },
      });
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ── POST /api/invoices/:id/send — finalize a draft ───────────────────────────
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
      include: { items: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be sent' });

    const updated = await prisma.$transaction(async (tx) => {
      const updatedInvoice = await tx.invoice.update({
        where: { id: req.params.id },
        data: { status: 'sent' },
      });

      const entryDate = invoice.invoice_date;
      const fyId = invoice.financial_year_id;

      if (invoice.voucher_type === 'SALE') {
        await writeCustomerLedger(tx, req.user.businessId, invoice.customer_id, invoice.total_amount, invoice.invoice_number, entryDate, false, fyId);
        await adjustInventory(tx, invoice.items, -1);
      } else if (invoice.voucher_type === 'SALE_RETURN') {
        await writeCustomerLedger(tx, req.user.businessId, invoice.customer_id, invoice.total_amount, invoice.invoice_number, entryDate, true, fyId);
        await adjustInventory(tx, invoice.items, +1);
      } else if (invoice.voucher_type === 'PURCHASE') {
        await writeSupplierLedger(tx, req.user.businessId, invoice.supplier_id, invoice.total_amount, invoice.invoice_number, entryDate, false, fyId);
        await adjustInventory(tx, invoice.items, +1);
      } else if (invoice.voucher_type === 'PURCHASE_RETURN') {
        await writeSupplierLedger(tx, req.user.businessId, invoice.supplier_id, invoice.total_amount, invoice.invoice_number, entryDate, true, fyId);
        await adjustInventory(tx, invoice.items, -1);
      }

      return updatedInvoice;
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finalize invoice' });
  }
});

// ── DELETE /api/invoices/:id — cancel invoice ─────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, business_id: req.user.businessId, is_deleted: false },
      include: { items: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Cannot cancel a fully paid invoice' });

    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: req.params.id },
        data: { status: 'cancelled' },
      });

      if (['sent', 'partial'].includes(invoice.status)) {
        const reversalAmount = invoice.total_amount - invoice.amount_paid;

        const fyId = invoice.financial_year_id;
        if (SALE_TYPES.includes(invoice.voucher_type) && invoice.customer_id) {
          // For SALE: reverse the debit (credit the customer back)
          // For SALE_RETURN: reverse the credit (debit the customer back)
          const isReturn = invoice.voucher_type === 'SALE_RETURN';
          await writeCustomerLedger(
            tx, req.user.businessId, invoice.customer_id,
            reversalAmount, invoice.invoice_number, new Date(),
            !isReturn, fyId  // SALE reversal = credit; SALE_RETURN reversal = debit
          );
          await adjustInventory(tx, invoice.items, invoice.voucher_type === 'SALE' ? +1 : -1);
        } else if (PURCHASE_TYPES.includes(invoice.voucher_type) && invoice.supplier_id) {
          const isReturn = invoice.voucher_type === 'PURCHASE_RETURN';
          await writeSupplierLedger(
            tx, req.user.businessId, invoice.supplier_id,
            reversalAmount, invoice.invoice_number, new Date(),
            !isReturn, fyId  // PURCHASE reversal = debit; PURCHASE_RETURN reversal = credit
          );
          await adjustInventory(tx, invoice.items, invoice.voucher_type === 'PURCHASE' ? -1 : +1);
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
