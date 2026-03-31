const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

function parseDateRange(from, to) {
  const where = {};
  if (from || to) {
    where.invoice_date = {};
    if (from) where.invoice_date.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
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

  const dateRange = parseDateRange(from, to);

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        status: { notIn: ['draft', 'cancelled'] },
        ...dateRange,
      },
      select: {
        invoice_date: true,
        total_amount: true,
        tax_amount: true,
        subtotal: true,
        discount_amount: true,
      },
      orderBy: { invoice_date: 'asc' },
    });

    const total_sales = invoices.reduce((s, i) => s + i.total_amount, 0);
    const total_tax = invoices.reduce((s, i) => s + i.tax_amount, 0);
    const total_discount = invoices.reduce((s, i) => s + i.discount_amount, 0);
    const invoice_count = invoices.length;

    // Daily breakdown for chart
    const dailyMap = {};
    for (const inv of invoices) {
      const day = inv.invoice_date.toISOString().split('T')[0];
      if (!dailyMap[day]) dailyMap[day] = { date: day, amount: 0, count: 0 };
      dailyMap[day].amount += inv.total_amount;
      dailyMap[day].count += 1;
    }
    const daily = Object.values(dailyMap);

    res.json({ total_sales, total_tax, total_discount, invoice_count, daily });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sales summary' });
  }
});

// GET /api/reports/outstanding
router.get('/outstanding', async (req, res) => {
  const businessId = req.user.businessId;

  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
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

  const where = { business_id: businessId, is_reversed: false };
  if (from || to) {
    where.payment_date = {};
    if (from) where.payment_date.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.payment_date.lte = toDate;
    }
  }

  try {
    const payments = await prisma.payment.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoice_number: true } },
      },
      orderBy: { payment_date: 'desc' },
    });

    const total_collected = payments.reduce((s, p) => s + p.amount, 0);

    const modeMap = {};
    for (const p of payments) {
      if (!modeMap[p.payment_mode]) {
        modeMap[p.payment_mode] = { mode: p.payment_mode, amount: 0, count: 0 };
      }
      modeMap[p.payment_mode].amount += p.amount;
      modeMap[p.payment_mode].count += 1;
    }
    const by_mode = Object.values(modeMap).sort((a, b) => b.amount - a.amount);

    res.json({ total_collected, payment_count: payments.length, by_mode, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// GET /api/reports/gst-summary?from=&to=
router.get('/gst-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const invoiceWhere = {
    business_id: businessId,
    is_deleted: false,
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to),
  };

  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { state: true },
    });

    const items = await prisma.invoiceItem.findMany({
      where: { invoice: invoiceWhere },
      include: {
        invoice: {
          include: { customer: { select: { state: true } } },
        },
      },
    });

    const taxRateMap = {};
    let total_cgst = 0, total_sgst = 0, total_igst = 0, total_taxable = 0;

    for (const item of items) {
      if (item.tax_rate === 0) continue;

      const customerState = item.invoice.customer?.state;
      const businessState = business?.state;
      const isInterState =
        businessState && customerState &&
        businessState.toLowerCase().trim() !== customerState.toLowerCase().trim();

      const taxableAmount = item.amount - item.tax_amount;
      total_taxable += taxableAmount;

      const rate = item.tax_rate;
      if (!taxRateMap[rate]) {
        taxRateMap[rate] = { tax_rate: rate, taxable_amount: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 };
      }
      taxRateMap[rate].taxable_amount += taxableAmount;
      taxRateMap[rate].total_tax += item.tax_amount;

      if (isInterState) {
        taxRateMap[rate].igst += item.tax_amount;
        total_igst += item.tax_amount;
      } else {
        const half = Math.round(item.tax_amount / 2);
        taxRateMap[rate].cgst += half;
        taxRateMap[rate].sgst += half;
        total_cgst += half;
        total_sgst += half;
      }
    }

    const by_rate = Object.values(taxRateMap).sort((a, b) => b.tax_rate - a.tax_rate);
    const total_tax = total_cgst + total_sgst + total_igst;

    res.json({ total_taxable, total_cgst, total_sgst, total_igst, total_tax, by_rate });
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
    status: { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to),
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
