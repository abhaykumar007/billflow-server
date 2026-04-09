const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');

router.use(authenticateToken);
router.use(attachFinancialYear);

// Builds invoice_date filter; defaults to FY boundaries when from/to are absent
function parseDateRange(from, to, financialYear = null) {
  const effectiveFrom = from || (financialYear ? financialYear.start_date : null);
  const effectiveTo   = to   || (financialYear ? financialYear.end_date   : null);
  const where = {};
  if (effectiveFrom || effectiveTo) {
    where.invoice_date = {};
    if (effectiveFrom) where.invoice_date.gte = new Date(effectiveFrom);
    if (effectiveTo) {
      const toDate = new Date(effectiveTo);
      toDate.setHours(23, 59, 59, 999);
      where.invoice_date.lte = toDate;
    }
  }
  return where;
}

// GET /api/reports/sales-summary?from=&to=
router.get('/sales-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const baseWhere = {
    business_id: businessId,
    is_deleted: false,
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const [sales, saleReturns] = await Promise.all([
      prisma.invoice.findMany({
        where: { ...baseWhere, voucher_type: 'SALE' },
        select: { invoice_date: true, total_amount: true, tax_amount: true, subtotal: true, discount_amount: true },
        orderBy: { invoice_date: 'asc' },
      }),
      prisma.invoice.findMany({
        where: { ...baseWhere, voucher_type: 'SALE_RETURN' },
        select: { invoice_date: true, total_amount: true, tax_amount: true },
      }),
    ]);

    const gross_sales = sales.reduce((s, i) => s + i.total_amount, 0);
    const total_returns = saleReturns.reduce((s, i) => s + i.total_amount, 0);
    const net_sales = gross_sales - total_returns;
    const total_tax = sales.reduce((s, i) => s + i.tax_amount, 0);
    const total_discount = sales.reduce((s, i) => s + i.discount_amount, 0);

    // Daily breakdown for chart (sales only, not returns)
    const dailyMap = {};
    for (const inv of sales) {
      const day = inv.invoice_date.toISOString().split('T')[0];
      if (!dailyMap[day]) dailyMap[day] = { date: day, amount: 0, count: 0 };
      dailyMap[day].amount += inv.total_amount;
      dailyMap[day].count += 1;
    }
    const daily = Object.values(dailyMap);

    res.json({ gross_sales, total_returns, net_sales, total_tax, total_discount, invoice_count: sales.length, return_count: saleReturns.length, daily });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sales summary' });
  }
});

// GET /api/reports/outstanding
router.get('/outstanding', async (req, res) => {
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        ...fyFilter,
        is_deleted: false,
        voucher_type: 'SALE',
        status: { in: ['sent', 'partial'] },
        balance_due: { gt: 0 },
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { due_date: 'asc' },
    });

    const now = new Date();

    const customerMap = {};
    for (const inv of invoices) {
      const cid = inv.customer_id;
      if (!customerMap[cid]) {
        customerMap[cid] = {
          customer: inv.customer,
          invoices: [],
          total_due: 0,
          current: 0,      // not yet due
          overdue_1_30: 0,
          overdue_31_60: 0,
          overdue_60_plus: 0,
        };
      }

      const dueDate = inv.due_date ? new Date(inv.due_date) : null;
      const overdueDays = dueDate
        ? Math.floor((now - dueDate) / (1000 * 60 * 60 * 24))
        : 0;

      customerMap[cid].invoices.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        balance_due: inv.balance_due,
        status: inv.status,
        overdue_days: Math.max(0, overdueDays),
      });
      customerMap[cid].total_due += inv.balance_due;

      if (overdueDays <= 0) customerMap[cid].current += inv.balance_due;
      else if (overdueDays <= 30) customerMap[cid].overdue_1_30 += inv.balance_due;
      else if (overdueDays <= 60) customerMap[cid].overdue_31_60 += inv.balance_due;
      else customerMap[cid].overdue_60_plus += inv.balance_due;
    }

    const customers = Object.values(customerMap).sort((a, b) => b.total_due - a.total_due);
    const grand_total = customers.reduce((s, c) => s + c.total_due, 0);

    res.json({ customers, grand_total, invoice_count: invoices.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch outstanding report' });
  }
});

// GET /api/reports/collections?from=&to=
router.get('/collections', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fy = req.financialYear;

  const effectiveFrom = from || (fy ? fy.start_date : null);
  const effectiveTo   = to   || (fy ? fy.end_date   : null);

  const where = {
    business_id: businessId,
    is_reversed: false,
    ...(fy ? { financial_year_id: fy.id } : {}),
  };
  if (effectiveFrom || effectiveTo) {
    where.payment_date = {};
    if (effectiveFrom) where.payment_date.gte = new Date(effectiveFrom);
    if (effectiveTo) {
      const toDate = new Date(effectiveTo);
      toDate.setHours(23, 59, 59, 999);
      where.payment_date.lte = toDate;
    }
  }

  try {
    const payments = await prisma.payment.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoice_number: true } },
      },
      orderBy: { payment_date: 'desc' },
    });

    const total_received = payments
      .filter((p) => p.payment_type === 'RECEIVED')
      .reduce((s, p) => s + p.amount, 0);
    const total_paid = payments
      .filter((p) => p.payment_type === 'PAID')
      .reduce((s, p) => s + p.amount, 0);

    const modeMap = {};
    for (const p of payments) {
      if (!modeMap[p.payment_mode]) {
        modeMap[p.payment_mode] = { mode: p.payment_mode, amount: 0, count: 0 };
      }
      modeMap[p.payment_mode].amount += p.amount;
      modeMap[p.payment_mode].count += 1;
    }
    const by_mode = Object.values(modeMap).sort((a, b) => b.amount - a.amount);

    res.json({ total_received, total_paid, payment_count: payments.length, by_mode, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// GET /api/reports/purchase-summary?from=&to=
router.get('/purchase-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const baseWhere = {
    business_id: businessId,
    is_deleted: false,
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const [purchases, returns] = await Promise.all([
      prisma.invoice.findMany({
        where: { ...baseWhere, voucher_type: 'PURCHASE' },
        select: { invoice_date: true, total_amount: true, tax_amount: true, subtotal: true, discount_amount: true },
        orderBy: { invoice_date: 'asc' },
      }),
      prisma.invoice.findMany({
        where: { ...baseWhere, voucher_type: 'PURCHASE_RETURN' },
        select: { invoice_date: true, total_amount: true, tax_amount: true },
      }),
    ]);

    const total_purchases = purchases.reduce((s, i) => s + i.total_amount, 0);
    const total_returns = returns.reduce((s, i) => s + i.total_amount, 0);
    const net_purchases = total_purchases - total_returns;
    const total_tax = purchases.reduce((s, i) => s + i.tax_amount, 0);
    const total_discount = purchases.reduce((s, i) => s + i.discount_amount, 0);

    const dailyMap = {};
    for (const inv of purchases) {
      const day = inv.invoice_date.toISOString().split('T')[0];
      if (!dailyMap[day]) dailyMap[day] = { date: day, amount: 0, count: 0 };
      dailyMap[day].amount += inv.total_amount;
      dailyMap[day].count += 1;
    }
    const daily = Object.values(dailyMap);

    res.json({ total_purchases, total_returns, net_purchases, total_tax, total_discount, invoice_count: purchases.length, return_count: returns.length, daily });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch purchase summary' });
  }
});

// GET /api/reports/outstanding-payable
router.get('/outstanding-payable', async (req, res) => {
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        ...fyFilter,
        is_deleted: false,
        voucher_type: 'PURCHASE',
        status: { notIn: ['draft', 'cancelled'] },
        balance_due: { gt: 0 },
      },
      include: {
        supplier: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { invoice_date: 'asc' },
    });

    const now = new Date();

    const supplierMap = {};
    for (const inv of invoices) {
      const sid = inv.supplier_id;
      if (!sid) continue;
      if (!supplierMap[sid]) {
        supplierMap[sid] = {
          supplier: inv.supplier,
          invoices: [],
          total_due: 0,
          days_0_30: 0,
          days_31_60: 0,
          days_61_90: 0,
          days_90_plus: 0,
        };
      }

      const daysSince = Math.floor((now - new Date(inv.invoice_date)) / (1000 * 60 * 60 * 24));

      supplierMap[sid].invoices.push({
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        balance_due: inv.balance_due,
        days_since: daysSince,
      });
      supplierMap[sid].total_due += inv.balance_due;

      if (daysSince <= 30) supplierMap[sid].days_0_30 += inv.balance_due;
      else if (daysSince <= 60) supplierMap[sid].days_31_60 += inv.balance_due;
      else if (daysSince <= 90) supplierMap[sid].days_61_90 += inv.balance_due;
      else supplierMap[sid].days_90_plus += inv.balance_due;
    }

    const suppliers = Object.values(supplierMap).sort((a, b) => b.total_due - a.total_due);
    const grand_total = suppliers.reduce((s, c) => s + c.total_due, 0);

    res.json({ suppliers, grand_total, invoice_count: invoices.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch outstanding payable' });
  }
});

// GET /api/reports/payments-made?from=&to=
router.get('/payments-made', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fy = req.financialYear;

  const effectiveFrom = from || (fy ? fy.start_date : null);
  const effectiveTo   = to   || (fy ? fy.end_date   : null);

  const dateFilter = {};
  if (effectiveFrom || effectiveTo) {
    dateFilter.entry_date = {};
    if (effectiveFrom) dateFilter.entry_date.gte = new Date(effectiveFrom);
    if (effectiveTo) {
      const toDate = new Date(effectiveTo);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.entry_date.lte = toDate;
    }
  }
  const where = {
    business_id: businessId,
    entry_type: 'payment',
    debit: { gt: 0 },
    ...(fy ? { financial_year_id: fy.id } : {}),
    ...dateFilter,
  };

  try {
    const entries = await prisma.supplierLedgerEntry.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { entry_date: 'desc' },
    });

    const total_paid = entries.reduce((s, e) => s + e.debit, 0);

    res.json({ total_paid, payment_count: entries.length, payments: entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments made' });
  }
});

// GET /api/reports/profit-loss?from=&to=
router.get('/profit-loss', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const baseWhere = {
    business_id: businessId,
    is_deleted: false,
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const [sales, saleReturns, purchases, purchaseReturns] = await Promise.all([
      prisma.invoice.aggregate({ where: { ...baseWhere, voucher_type: 'SALE' }, _sum: { total_amount: true, tax_amount: true, subtotal: true }, _count: { id: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, voucher_type: 'SALE_RETURN' }, _sum: { total_amount: true }, _count: { id: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, voucher_type: 'PURCHASE' }, _sum: { total_amount: true, tax_amount: true, subtotal: true }, _count: { id: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, voucher_type: 'PURCHASE_RETURN' }, _sum: { total_amount: true }, _count: { id: true } }),
    ]);

    const gross_sales = sales._sum.total_amount || 0;
    const sales_return = saleReturns._sum.total_amount || 0;
    const net_sales = gross_sales - sales_return;

    const gross_purchases = purchases._sum.total_amount || 0;
    const purchase_return = purchaseReturns._sum.total_amount || 0;
    const net_purchases = gross_purchases - purchase_return;

    const gross_profit = net_sales - net_purchases;
    const sales_tax = sales._sum.tax_amount || 0;
    const purchase_tax = purchases._sum.tax_amount || 0;
    const net_gst_payable = sales_tax - purchase_tax;

    res.json({
      gross_sales, sales_return, net_sales,
      gross_purchases, purchase_return, net_purchases,
      gross_profit,
      sales_invoice_count: sales._count.id,
      purchase_invoice_count: purchases._count.id,
      sales_tax, purchase_tax, net_gst_payable,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch P&L summary' });
  }
});

// GET /api/reports/gst-summary?from=&to=
router.get('/gst-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const baseWhere = {
    business_id: businessId,
    is_deleted: false,
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  function buildTaxMap(items, businessState, getPartyState) {
    const rateMap = {};
    let total_cgst = 0, total_sgst = 0, total_igst = 0, total_taxable = 0;

    for (const item of items) {
      if (item.tax_rate === 0) continue;
      const partyState = getPartyState(item);
      const isInterState =
        businessState && partyState &&
        businessState.toLowerCase().trim() !== partyState.toLowerCase().trim();

      const taxableAmount = item.amount - item.tax_amount;
      total_taxable += taxableAmount;

      const rate = item.tax_rate;
      if (!rateMap[rate]) {
        rateMap[rate] = { tax_rate: rate, taxable_amount: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 };
      }
      rateMap[rate].taxable_amount += taxableAmount;
      rateMap[rate].total_tax += item.tax_amount;

      if (isInterState) {
        rateMap[rate].igst += item.tax_amount;
        total_igst += item.tax_amount;
      } else {
        const half = Math.round(item.tax_amount / 2);
        rateMap[rate].cgst += half;
        rateMap[rate].sgst += half;
        total_cgst += half;
        total_sgst += half;
      }
    }

    const by_rate = Object.values(rateMap).sort((a, b) => b.tax_rate - a.tax_rate);
    const total_tax = total_cgst + total_sgst + total_igst;
    return { total_taxable, total_cgst, total_sgst, total_igst, total_tax, by_rate };
  }

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { state: true },
    });
    const businessState = business?.state;

    const [salesItems, purchaseItems] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: { invoice: { ...baseWhere, voucher_type: { in: ['SALE', 'SALE_RETURN'] } } },
        include: { invoice: { include: { customer: { select: { state: true } } } } },
      }),
      prisma.invoiceItem.findMany({
        where: { invoice: { ...baseWhere, voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] } } },
        include: { invoice: { include: { supplier: { select: { state: true } } } } },
      }),
    ]);

    const sales = buildTaxMap(salesItems, businessState, (item) => item.invoice.customer?.state);
    const purchases = buildTaxMap(purchaseItems, businessState, (item) => item.invoice.supplier?.state);
    const net_gst_payable = sales.total_tax - purchases.total_tax;

    res.json({ sales, purchases, net_gst_payable });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch GST summary' });
  }
});

// GET /api/reports/product-sales?from=&to=&limit=10
router.get('/product-sales', async (req, res) => {
  const { from, to, limit = 10 } = req.query;
  const businessId = req.user.businessId;

  const invoiceWhere = {
    business_id: businessId,
    is_deleted: false,
    voucher_type: 'SALE',
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const items = await prisma.invoiceItem.findMany({
      where: { invoice: invoiceWhere },
      include: {
        product: { select: { id: true, name: true, unit: true } },
      },
    });

    const productMap = {};
    for (const item of items) {
      const key = item.product_id || `desc:${item.description}`;
      if (!productMap[key]) {
        productMap[key] = {
          product_id: item.product_id,
          name: item.product?.name || item.description,
          unit: item.product?.unit || item.unit,
          quantity: 0,
          revenue: 0,
          times_sold: 0,
        };
      }
      productMap[key].quantity += item.quantity;
      productMap[key].revenue += item.amount;
      productMap[key].times_sold += 1;
    }

    const products = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, parseInt(limit));

    const total_revenue = products.reduce((s, p) => s + p.revenue, 0);

    res.json({ products, total_revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product sales' });
  }
});

module.exports = router;
