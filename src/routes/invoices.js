const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { checkInvoiceLimit } = require('../middleware/planLimit');
const { attachFinancialYear, requireUnlockedFY, enforceOpenYear } = require('../middleware/financialYear');
const { HttpError } = require('../utils/httpError');
const { lockRow, lockRows } = require('../utils/lock');
const { computeInvoiceTotals } = require('../utils/money');
const { parseDayStart, parseDayEnd, isValidDate, todayDate } = require('../utils/time');
const {
  postCustomerEntry, postSupplierEntry, VOUCHERS,
  assertCanPost, assertRecordFyWritable, assertDateInFY, idempotencyKey,
} = require('../utils/ledger');

router.use(authenticateToken);

const SALE_TYPES = ['SALE', 'SALE_RETURN'];
const PURCHASE_TYPES = ['PURCHASE', 'PURCHASE_RETURN'];
const ESTIMATE_TYPES = ['ESTIMATE'];
const RETURN_PARENT = { SALE_RETURN: 'SALE', PURCHASE_RETURN: 'PURCHASE' };

const VOUCHER_PREFIX = {
  SALE: 'SINV',
  PURCHASE: 'PINV',
  SALE_RETURN: 'SRET',
  PURCHASE_RETURN: 'PRET',
  ESTIMATE: null, // prefix comes from business.estimate_prefix
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Builds the FY short code from start_date, e.g. April 2025 → "2526"
function fyCode(financialYear) {
  const startYear = new Date(financialYear.start_date).getUTCFullYear();
  const endYear = startYear + 1;
  return `${String(startYear).slice(2)}${String(endYear).slice(2)}`;
}

function counterField(voucherType) {
  if (voucherType === 'ESTIMATE') return 'estimate_next_number';
  return PURCHASE_TYPES.includes(voucherType) ? 'purchase_next_number' : 'invoice_next_number';
}

async function prefixFor(tx, voucherType, businessId) {
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: { invoice_prefix: true, purchase_prefix: true, estimate_prefix: true },
  });
  if (voucherType === 'ESTIMATE') return business?.estimate_prefix || 'EST';
  if (voucherType === 'SALE') return business?.invoice_prefix || 'INV';
  if (voucherType === 'PURCHASE') return business?.purchase_prefix || 'PUR';
  return VOUCHER_PREFIX[voucherType] || 'INV';
}

// Atomically takes the next number. The UPDATE ... increment takes a row lock, so two
// concurrent requests can never be handed the same number.
async function allocateInvoiceNumber(tx, voucherType, financialYear, businessId) {
  const field = counterField(voucherType);
  const updated = await tx.financialYear.update({
    where: { id: financialYear.id },
    data: { [field]: { increment: 1 } },
    select: { [field]: true },
  });
  const seq = updated[field] - 1;
  const prefix = await prefixFor(tx, voucherType, businessId);
  return `${prefix}-${fyCode(financialYear)}-${String(seq).padStart(4, '0')}`;
}

// Stock movement. direction +1 = add, -1 = remove. Quantities are summed per product,
// products are locked in a stable order, and every update is scoped to the business.
// Returns warnings for products that went below zero (selling before receiving stock is
// common in small shops, so this warns instead of blocking).
async function adjustInventory(tx, businessId, items, direction) {
  const perProduct = new Map();
  for (const item of items) {
    if (!item.product_id) continue;
    perProduct.set(item.product_id, (perProduct.get(item.product_id) || 0) + Number(item.quantity));
  }
  if (perProduct.size === 0) return [];

  await lockRows(tx, 'product', [...perProduct.keys()]);
  const products = await tx.product.findMany({
    where: { id: { in: [...perProduct.keys()] }, business_id: businessId },
    select: { id: true, name: true, track_inventory: true, stock_quantity: true },
  });

  const warnings = [];
  for (const product of products) {
    if (!product.track_inventory) continue;
    const delta = direction * perProduct.get(product.id);
    const after = product.stock_quantity + delta;
    await tx.product.update({ where: { id: product.id }, data: { stock_quantity: { increment: delta } } });
    if (after < 0) warnings.push({ product_id: product.id, name: product.name, stock_after: after });
  }
  return warnings;
}

// Posts a finalised voucher to the party ledger and stock.
async function postVoucher(tx, invoice, items, { fyId, entryDate }) {
  const v = VOUCHERS[invoice.voucher_type];
  if (!v) return []; // estimates never touch ledger or stock
  const entry = {
    businessId: invoice.business_id, fyId, entryType: 'invoice', referenceId: invoice.id, referenceType: 'Invoice',
    narration: `${v.label} ${invoice.invoice_number}`, entryDate,
    [v.post]: invoice.total_amount,
  };
  if (v.party === 'CUSTOMER') await postCustomerEntry(tx, { ...entry, customerId: invoice.customer_id });
  else await postSupplierEntry(tx, { ...entry, supplierId: invoice.supplier_id });
  return adjustInventory(tx, invoice.business_id, items, v.stock);
}

// Reverses a posted voucher (cancel): opposite ledger side, opposite stock movement.
async function unpostVoucher(tx, invoice, items, { fyId, entryDate }) {
  const v = VOUCHERS[invoice.voucher_type];
  if (!v) return;
  const reverseSide = v.post === 'debit' ? 'credit' : 'debit';
  const entry = {
    businessId: invoice.business_id, fyId, entryType: 'invoice', referenceId: invoice.id, referenceType: 'Invoice',
    narration: `Cancelled ${v.label} ${invoice.invoice_number}`, entryDate,
    [reverseSide]: invoice.total_amount,
  };
  if (v.party === 'CUSTOMER') await postCustomerEntry(tx, { ...entry, customerId: invoice.customer_id });
  else await postSupplierEntry(tx, { ...entry, supplierId: invoice.supplier_id });
  await adjustInventory(tx, invoice.business_id, items, -v.stock);
}

// Everything a client may reference must belong to the caller's business.
async function validateReferences(tx, businessId, { voucher_type, customer_id, supplier_id, linked_invoice_id, lines }) {
  let customer = null;
  if (SALE_TYPES.includes(voucher_type)) {
    if (!customer_id) throw new HttpError(400, 'Customer is required for sale invoices', 'VALIDATION');
  } else if (PURCHASE_TYPES.includes(voucher_type)) {
    if (!supplier_id) throw new HttpError(400, 'Supplier is required for purchase invoices', 'VALIDATION');
  }
  if (customer_id && !PURCHASE_TYPES.includes(voucher_type)) {
    customer = await tx.customer.findFirst({ where: { id: customer_id, business_id: businessId, is_deleted: false } });
    if (!customer) throw new HttpError(404, 'Customer not found', 'NOT_FOUND');
  }
  if (supplier_id && PURCHASE_TYPES.includes(voucher_type)) {
    const supplier = await tx.supplier.findFirst({ where: { id: supplier_id, business_id: businessId, is_deleted: false } });
    if (!supplier) throw new HttpError(404, 'Supplier not found', 'NOT_FOUND');
  }

  const productIds = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];
  if (productIds.length) {
    const found = await tx.product.count({ where: { id: { in: productIds }, business_id: businessId, is_deleted: false } });
    if (found !== productIds.length) throw new HttpError(404, 'One or more products were not found', 'NOT_FOUND');
  }

  let linked = null;
  if (linked_invoice_id) {
    linked = await tx.invoice.findFirst({
      where: { id: linked_invoice_id, business_id: businessId, is_deleted: false },
      include: { items: true },
    });
    if (!linked) throw new HttpError(404, 'Linked invoice not found', 'NOT_FOUND');
    if (voucher_type in RETURN_PARENT && linked.voucher_type !== RETURN_PARENT[voucher_type]) {
      throw new HttpError(400, `A ${voucher_type.replace('_', ' ').toLowerCase()} must be linked to a ${RETURN_PARENT[voucher_type].toLowerCase()} invoice`, 'VALIDATION');
    }
    if (voucher_type in RETURN_PARENT) {
      const sameParty = SALE_TYPES.includes(voucher_type)
        ? linked.customer_id === customer_id
        : linked.supplier_id === supplier_id;
      if (!sameParty) throw new HttpError(400, 'The return must be for the same party as the original invoice', 'VALIDATION');
    }
  }
  return { customer, linked };
}

const lineKey = (l) => l.product_id || `d:${String(l.description).trim().toLowerCase()}`;

// A return cannot take back more than was sold (minus earlier returns of the same invoice).
async function validateReturnQuantities(tx, businessId, voucherType, linked, lines, excludeInvoiceId) {
  if (!linked || !(voucherType in RETURN_PARENT)) return;
  const original = new Map();
  for (const it of linked.items) original.set(lineKey(it), (original.get(lineKey(it)) || 0) + it.quantity);

  const earlier = await tx.invoice.findMany({
    where: {
      business_id: businessId, linked_invoice_id: linked.id, voucher_type: voucherType,
      is_deleted: false, status: { not: 'cancelled' },
      ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
    },
    include: { items: true },
  });
  const returned = new Map();
  for (const inv of earlier) for (const it of inv.items) returned.set(lineKey(it), (returned.get(lineKey(it)) || 0) + it.quantity);

  const now = new Map();
  for (const l of lines) now.set(lineKey(l), (now.get(lineKey(l)) || 0) + l.quantity);
  for (const [key, qty] of now) {
    if (!original.has(key)) throw new HttpError(400, 'A returned item was not on the original invoice', 'RETURN_ITEM_NOT_FOUND');
    const available = original.get(key) - (returned.get(key) || 0);
    if (qty > available + 1e-9) {
      throw new HttpError(400, `Return quantity (${qty}) exceeds what is left to return (${Math.max(available, 0)})`, 'RETURN_EXCEEDS_ORIGINAL');
    }
  }
}

function parseDates(body, fy) {
  const invoiceDate = body.invoice_date ? parseDayStart(body.invoice_date) : todayDate();
  if (!isValidDate(invoiceDate)) throw new HttpError(400, 'Invalid invoice_date', 'VALIDATION');
  assertDateInFY(invoiceDate, fy);
  const dueDate = body.due_date ? parseDayStart(body.due_date) : null;
  if (dueDate && !isValidDate(dueDate)) throw new HttpError(400, 'Invalid due_date', 'VALIDATION');
  if (dueDate && dueDate < invoiceDate) throw new HttpError(400, 'Due date cannot be before the invoice date', 'VALIDATION');
  const validUntil = body.valid_until ? parseDayStart(body.valid_until) : null;
  if (validUntil && !isValidDate(validUntil)) throw new HttpError(400, 'Invalid valid_until', 'VALIDATION');
  return { invoiceDate, dueDate, validUntil };
}

// ── GET /api/invoices/next-number ─────────────────────────────────────────────
router.get('/next-number', attachFinancialYear, async (req, res) => {
  try {
    if (!req.financialYear) {
      return res.status(400).json({ error: 'No active financial year. Please select or create a financial year first.' });
    }
    const { type = 'SALE' } = req.query;

    // ESTIMATE uses its own counter and prefix
    if (type === 'ESTIMATE') {
      const [fy, business] = await Promise.all([
        prisma.financialYear.findUnique({
          where: { id: req.financialYear.id },
          select: { estimate_next_number: true },
        }),
        prisma.business.findUnique({
          where: { id: req.user.businessId },
          select: { estimate_prefix: true },
        }),
      ]);
      const prefix = business?.estimate_prefix || 'EST';
      const code = fyCode(req.financialYear);
      return res.json({
        invoiceNumber: `${prefix}-${code}-${String(fy.estimate_next_number).padStart(4, '0')}`,
        nextNumber: fy.estimate_next_number,
      });
    }

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
    const { status, customerId, supplierId, type, from, to, search } = req.query;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const skip = (page - 1) * limit;

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
    } else if (type === 'estimates') {
      where.voucher_type = 'ESTIMATE';
    } else {
      // Default: exclude estimates from the main invoice list
      where.voucher_type = { not: 'ESTIMATE' };
    }

    if (customerId) where.customer_id = customerId;
    if (supplierId) where.supplier_id = supplierId;

    if (from || to) {
      where.invoice_date = {};
      if (from) where.invoice_date.gte = parseDayStart(from);
      if (to) where.invoice_date.lte = parseDayEnd(to);
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
        take: limit,
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ invoices, total, page, limit });
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
router.post('/', attachFinancialYear, enforceOpenYear, requireUnlockedFY, checkInvoiceLimit, async (req, res) => {
  const businessId = req.user.businessId;
  const {
    voucher_type = 'SALE', customer_id, supplier_id, linked_invoice_id,
    invoice_number: providedNumber, status = 'draft', items, discount_amount = 0, notes, terms,
  } = req.body;
  const fy = req.financialYear;

  if (![...SALE_TYPES, ...PURCHASE_TYPES, ...ESTIMATE_TYPES].includes(voucher_type)) {
    throw new HttpError(400, 'Invalid voucher_type', 'VALIDATION');
  }
  // the client may not choose any other status (e.g. 'paid')
  if (!['draft', 'sent'].includes(status)) throw new HttpError(400, "status must be 'draft' or 'sent'", 'VALIDATION');
  const isEstimate = voucher_type === 'ESTIMATE';
  const isSale = SALE_TYPES.includes(voucher_type);
  const isPurchase = PURCHASE_TYPES.includes(voucher_type);

  await assertCanPost(prisma, fy);
  const { invoiceDate, dueDate, validUntil } = parseDates(req.body, fy);
  const totals = computeInvoiceTotals(items, discount_amount);   // server is the source of truth
  const key = idempotencyKey(req);

  if (key) {
    const dup = await prisma.invoice.findFirst({
      where: { business_id: businessId, idempotency_key: key },
      include: { customer: true, supplier: true, items: true },
    });
    if (dup) return res.status(200).json({ ...dup, idempotent_replay: true });
  }

  let creditWarning = null;
  let stockWarnings = [];

  const invoice = await prisma.$transaction(async (tx) => {
    const { customer, linked } = await validateReferences(tx, businessId, {
      voucher_type, customer_id, supplier_id, linked_invoice_id, lines: totals.lines,
    });
    await validateReturnQuantities(tx, businessId, voucher_type, linked, totals.lines, null);

    // Credit limit (SALE only)
    if (voucher_type === 'SALE' && customer?.credit_limit > 0) {
      await lockRow(tx, 'customer', customer.id);
      const agg = await tx.invoice.aggregate({
        where: { customer_id, business_id: businessId, voucher_type: 'SALE', status: { in: ['sent', 'partial'] }, is_deleted: false },
        _sum: { balance_due: true },
      });
      const used = agg._sum.balance_due || 0;
      if (used + totals.total_amount > customer.credit_limit) {
        const msg = `Credit limit exceeded. Limit: ₹${(customer.credit_limit / 100).toFixed(2)}, Already used: ₹${(used / 100).toFixed(2)}, This invoice: ₹${(totals.total_amount / 100).toFixed(2)}.`;
        const detail = { code: 'CREDIT_LIMIT_EXCEEDED', credit_limit: customer.credit_limit, credit_used: used, invoice_total: totals.total_amount };
        if (customer.credit_limit_type === 'hard') throw new HttpError(422, msg, 'CREDIT_LIMIT_EXCEEDED', detail);
        creditWarning = { warning: true, message: msg, ...detail };
      }
    }

    const generated = await allocateInvoiceNumber(tx, voucher_type, fy, businessId);
    const finalNumber = providedNumber ? String(providedNumber).trim().slice(0, 40) : generated;

    const created = await tx.invoice.create({
      data: {
        business_id: businessId,
        financial_year_id: fy.id,
        voucher_type,
        customer_id: (isSale || isEstimate) ? (customer_id || null) : null,
        supplier_id: isPurchase ? supplier_id : null,
        linked_invoice_id: linked ? linked.id : null,
        invoice_number: finalNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        valid_until: validUntil,
        status,
        subtotal: totals.subtotal,
        discount_amount: totals.discount_amount,
        tax_amount: totals.tax_amount,
        total_amount: totals.total_amount,
        amount_paid: 0,
        balance_due: totals.total_amount,
        notes: notes ? String(notes).slice(0, 2000) : null,
        terms: terms ? String(terms).slice(0, 2000) : null,
        created_by: req.user.userId,
        idempotency_key: key,
        items: { create: totals.lines },
      },
      include: { customer: true, supplier: true, items: true },
    });

    if (!isEstimate && status !== 'draft') {
      stockWarnings = await postVoucher(tx, created, created.items, { fyId: fy.id, entryDate: invoiceDate });
    }
    return created;
  });

  const extra = {
    ...(creditWarning || {}),
    ...(stockWarnings.length ? { stock_warnings: stockWarnings } : {}),
  };
  return res.status(201).json({ ...invoice, ...extra });
});

// ── PUT /api/invoices/:id — only drafts can be edited ─────────────────────────
router.put('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const existing = await prisma.invoice.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');
  const fy = await assertRecordFyWritable(prisma, existing.financial_year_id);
  if (existing.status !== 'draft') throw new HttpError(400, 'Only draft invoices can be edited', 'VALIDATION');

  const { customer_id, supplier_id, discount_amount = 0, items, notes, terms } = req.body;
  const dates = fy ? parseDates({
    invoice_date: req.body.invoice_date || existing.invoice_date.toISOString().slice(0, 10),
    due_date: req.body.due_date,
    valid_until: req.body.valid_until,
  }, fy) : { invoiceDate: existing.invoice_date, dueDate: null, validUntil: null };
  const totals = computeInvoiceTotals(items, discount_amount);

  const updated = await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'invoice', existing.id);
    const fresh = await tx.invoice.findUnique({ where: { id: existing.id } });
    if (fresh.status !== 'draft') throw new HttpError(409, 'This invoice was just finalised and can no longer be edited', 'CONFLICT');

    const newCustomer = customer_id !== undefined ? (customer_id || null) : existing.customer_id;
    const newSupplier = supplier_id !== undefined ? (supplier_id || null) : existing.supplier_id;
    const { linked } = await validateReferences(tx, businessId, {
      voucher_type: existing.voucher_type, customer_id: newCustomer, supplier_id: newSupplier,
      linked_invoice_id: existing.linked_invoice_id, lines: totals.lines,
    });
    await validateReturnQuantities(tx, businessId, existing.voucher_type, linked, totals.lines, existing.id);

    await tx.invoiceItem.deleteMany({ where: { invoice_id: existing.id } });
    return tx.invoice.update({
      where: { id: existing.id },
      data: {
        customer_id: newCustomer,
        supplier_id: newSupplier,
        invoice_date: dates.invoiceDate,
        due_date: dates.dueDate,
        valid_until: dates.validUntil ?? existing.valid_until,
        subtotal: totals.subtotal,
        discount_amount: totals.discount_amount,
        tax_amount: totals.tax_amount,
        total_amount: totals.total_amount,
        balance_due: totals.total_amount - existing.amount_paid,
        notes: notes ? String(notes).slice(0, 2000) : null,
        terms: terms ? String(terms).slice(0, 2000) : null,
        items: { create: totals.lines },
      },
      include: { customer: true, supplier: true, items: true },
    });
  });

  return res.json(updated);
});

// ── POST /api/invoices/:id/send — finalize a draft ───────────────────────────
router.post('/:id/send', async (req, res) => {
  const businessId = req.user.businessId;
  const preview = await prisma.invoice.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
    select: { financial_year_id: true },
  });
  if (!preview) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');
  const fy = await assertRecordFyWritable(prisma, preview.financial_year_id);
  if (fy) await assertCanPost(prisma, fy);

  const result = await prisma.$transaction(async (tx) => {
    // Atomic draft -> sent. Whoever flips it first wins; a double-click / retry gets 409
    // instead of posting the ledger twice.
    const flipped = await tx.invoice.updateMany({
      where: { id: req.params.id, business_id: businessId, status: 'draft', is_deleted: false },
      data: { status: 'sent' },
    });
    if (flipped.count !== 1) throw new HttpError(409, 'Only draft invoices can be sent (it may already have been sent)', 'CONFLICT');

    const invoice = await tx.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (fy) assertDateInFY(invoice.invoice_date, fy);
    const warnings = await postVoucher(tx, invoice, invoice.items, { fyId: invoice.financial_year_id, entryDate: invoice.invoice_date });
    return { invoice, warnings };
  });

  res.json({ ...result.invoice, ...(result.warnings.length ? { stock_warnings: result.warnings } : {}) });
});

// ── POST /api/invoices/:id/convert — convert estimate → SALE invoice ─────────
router.post('/:id/convert', attachFinancialYear, enforceOpenYear, requireUnlockedFY, async (req, res) => {
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  await assertCanPost(prisma, fy);

  const body = req.body || {};
  const { invoiceDate, dueDate } = parseDates(body, fy);

  const newInvoice = await prisma.$transaction(async (tx) => {
    // atomic guard: only one conversion can win
    const claimed = await tx.invoice.updateMany({
      where: { id: req.params.id, business_id: businessId, voucher_type: 'ESTIMATE', is_deleted: false, status: { in: ['draft', 'sent'] } },
      data: { status: 'converted' },
    });
    if (claimed.count !== 1) {
      const e = await tx.invoice.findFirst({ where: { id: req.params.id, business_id: businessId, is_deleted: false } });
      if (!e) throw new HttpError(404, 'Estimate not found', 'NOT_FOUND');
      if (e.voucher_type !== 'ESTIMATE') throw new HttpError(400, 'Not an estimate', 'VALIDATION');
      throw new HttpError(422, e.status === 'converted' ? 'Estimate already converted' : `Cannot convert a ${e.status} estimate`, 'CONFLICT');
    }

    const estimate = await tx.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!estimate.customer_id) throw new HttpError(400, 'Add a customer to the estimate before converting it to an invoice', 'VALIDATION');
    const customer = await tx.customer.findFirst({ where: { id: estimate.customer_id, business_id: businessId, is_deleted: false } });
    if (!customer) throw new HttpError(404, 'Customer not found', 'NOT_FOUND');

    const invoiceNumber = await allocateInvoiceNumber(tx, 'SALE', fy, businessId);
    return tx.invoice.create({
      data: {
        business_id: businessId,
        financial_year_id: fy.id,
        voucher_type: 'SALE',
        customer_id: estimate.customer_id,
        linked_invoice_id: estimate.id,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        status: 'draft',
        subtotal: estimate.subtotal,
        discount_amount: estimate.discount_amount,
        tax_amount: estimate.tax_amount,
        total_amount: estimate.total_amount,
        amount_paid: 0,
        balance_due: estimate.total_amount,
        notes: estimate.notes,
        terms: estimate.terms,
        created_by: req.user.userId,
        items: {
          create: estimate.items.map((item) => ({
            product_id: item.product_id, description: item.description, quantity: item.quantity,
            unit: item.unit, rate: item.rate, discount_percent: item.discount_percent,
            tax_rate: item.tax_rate, tax_amount: item.tax_amount, amount: item.amount,
          })),
        },
      },
      include: { customer: true, items: true },
    });
  });

  res.status(201).json(newInvoice);
});

// ── DELETE /api/invoices/:id — cancel invoice ─────────────────────────────────
router.delete('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
    include: { items: true },
  });
  if (!invoice) throw new HttpError(404, 'Invoice not found', 'NOT_FOUND');
  if (invoice.status === 'cancelled') throw new HttpError(400, 'Invoice is already cancelled', 'VALIDATION');
  if (invoice.status === 'converted') throw new HttpError(400, 'A converted estimate cannot be cancelled', 'VALIDATION');
  if (invoice.status !== 'draft' && !['owner', 'accountant'].includes(req.user.role)) {
    throw new HttpError(403, 'Only an owner or accountant can cancel a finalised invoice.', 'FORBIDDEN_ROLE');
  }

  const fy = await assertRecordFyWritable(prisma, invoice.financial_year_id);
  const posted = ['sent', 'partial', 'paid'].includes(invoice.status) && VOUCHERS[invoice.voucher_type];
  if (posted) {
    if (fy && !fy.is_active) {
      throw new HttpError(409, 'Only invoices of the current financial year can be cancelled. Issue a credit note instead.', 'FY_NOT_CURRENT');
    }
    if (fy) await assertCanPost(prisma, fy);
  }

  await prisma.$transaction(async (tx) => {
    await lockRow(tx, 'invoice', invoice.id);
    const fresh = await tx.invoice.findUnique({ where: { id: invoice.id } });
    if (fresh.status === 'cancelled') throw new HttpError(409, 'Invoice was already cancelled', 'CONFLICT');
    if (fresh.amount_paid > 0) {
      throw new HttpError(409, 'This invoice has payments. Reverse the payments first, then cancel it.', 'HAS_PAYMENTS');
    }

    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'cancelled', balance_due: 0 } });
    if (['sent', 'partial'].includes(fresh.status) && VOUCHERS[fresh.voucher_type]) {
      const today = todayDate();
      const entryDate = fy && today > fy.end_date ? fy.end_date : today;
      await unpostVoucher(tx, fresh, invoice.items, { fyId: fresh.financial_year_id, entryDate });
    }
  });

  res.json({ message: 'Invoice cancelled successfully' });
});

module.exports = router;
