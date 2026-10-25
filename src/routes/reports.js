const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');
const { parseDayStart, parseDayEnd, todayDate, DAY_MS } = require('../utils/time');
const { dateRange, invoiceDateWhere, ymd, gstLines, sumBy } = require('../utils/reportHelpers');

router.use(authenticateToken);
router.use(attachFinancialYear);

const istTime = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);

// Builds the invoice_date filter; defaults to FY boundaries. Calendar-date based (see utils/time.js).
function parseDateRange(from, to, financialYear = null) {
  return invoiceDateWhere(from, to, financialYear);
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
  try {
    // All open invoices regardless of financial year: money owed is owed whichever year it was billed in.
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId, is_deleted: false, voucher_type: 'SALE',
        status: { in: ['sent', 'partial'] }, balance_due: { gt: 0 },
      },
      include: { customer: { select: { id: true, name: true, phone: true } } },
      orderBy: { due_date: 'asc' },
    });

    const today = todayDate();
    const customerMap = {};
    for (const inv of invoices) {
      const cid = inv.customer_id || '__none__';
      if (!customerMap[cid]) {
        customerMap[cid] = { customer: inv.customer, invoices: [], total_due: 0, current: 0, overdue_1_30: 0, overdue_31_60: 0, overdue_60_plus: 0 };
      }
      const overdueDays = inv.due_date ? Math.floor((today - new Date(inv.due_date)) / DAY_MS) : 0;
      customerMap[cid].invoices.push({
        id: inv.id, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, due_date: inv.due_date,
        balance_due: inv.balance_due, status: inv.status, overdue_days: Math.max(0, overdueDays),
      });
      customerMap[cid].total_due += inv.balance_due;
      if (overdueDays <= 0) customerMap[cid].current += inv.balance_due;
      else if (overdueDays <= 30) customerMap[cid].overdue_1_30 += inv.balance_due;
      else if (overdueDays <= 60) customerMap[cid].overdue_31_60 += inv.balance_due;
      else customerMap[cid].overdue_60_plus += inv.balance_due;
    }
    const customers = Object.values(customerMap).sort((a, b) => b.total_due - a.total_due);
    res.json({ customers, grand_total: customers.reduce((s, c) => s + c.total_due, 0), invoice_count: invoices.length });
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
  const range = dateRange(from, to, fy);
  const where = {
    business_id: businessId, is_reversed: false,
    ...(fy && !from && !to ? { financial_year_id: fy.id } : {}),
    ...(Object.keys(range).length ? { payment_date: range } : {}),
  };
  try {
    const payments = await prisma.payment.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoice_number: true } },
        splits: true,
      },
      orderBy: { payment_date: 'desc' },
    });
    const total_received = payments.filter((p) => p.payment_type === 'RECEIVED').reduce((s, p) => s + p.amount, 0);
    const total_paid = payments.filter((p) => p.payment_type === 'PAID').reduce((s, p) => s + p.amount, 0);

    // Split payments have payment_mode = null; attribute each leg to its own mode.
    const modeMap = {};
    const add = (mode, amount) => {
      const k = mode || 'unknown';
      if (!modeMap[k]) modeMap[k] = { mode: k, amount: 0, count: 0 };
      modeMap[k].amount += amount;
      modeMap[k].count += 1;
    };
    for (const p of payments) {
      if (p.splits && p.splits.length) p.splits.forEach((sp) => add(sp.payment_mode, sp.amount));
      else add(p.payment_mode, p.amount);
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
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId, is_deleted: false, voucher_type: 'PURCHASE',
        status: { notIn: ['draft', 'cancelled'] }, balance_due: { gt: 0 },
      },
      include: { supplier: { select: { id: true, name: true, phone: true } } },
      orderBy: { invoice_date: 'asc' },
    });
    const today = todayDate();
    const supplierMap = {};
    for (const inv of invoices) {
      const sid = inv.supplier_id;
      if (!sid) continue;
      if (!supplierMap[sid]) {
        supplierMap[sid] = { supplier: inv.supplier, invoices: [], total_due: 0, days_0_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 };
      }
      const daysSince = Math.floor((today - new Date(inv.invoice_date)) / DAY_MS);
      supplierMap[sid].invoices.push({ id: inv.id, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, balance_due: inv.balance_due, days_since: daysSince });
      supplierMap[sid].total_due += inv.balance_due;
      if (daysSince <= 30) supplierMap[sid].days_0_30 += inv.balance_due;
      else if (daysSince <= 60) supplierMap[sid].days_31_60 += inv.balance_due;
      else if (daysSince <= 90) supplierMap[sid].days_61_90 += inv.balance_due;
      else supplierMap[sid].days_90_plus += inv.balance_due;
    }
    const suppliers = Object.values(supplierMap).sort((a, b) => b.total_due - a.total_due);
    res.json({ suppliers, grand_total: suppliers.reduce((s, c) => s + c.total_due, 0), invoice_count: invoices.length });
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
  const range = dateRange(from, to, fy);
  try {
    const rows = await prisma.payment.findMany({
      where: {
        business_id: businessId, payment_type: 'PAID', is_reversed: false,
        ...(Object.keys(range).length ? { payment_date: range } : {}),
      },
      include: { supplier: { select: { id: true, name: true } }, invoice: { select: { invoice_number: true } } },
      orderBy: { payment_date: 'desc' },
    });
    // keep the earlier response shape (ledger-style rows) so existing clients keep working
    const payments = rows.map((p) => ({
      id: p.id, supplier: p.supplier, supplier_id: p.supplier_id, entry_date: p.payment_date, entry_type: 'payment',
      debit: p.amount, credit: 0, narration: p.invoice ? `Payment against ${p.invoice.invoice_number}` : (p.notes || 'Payment'),
      payment_mode: p.payment_mode,
    }));
    res.json({ total_paid: rows.reduce((s, p) => s + p.amount, 0), payment_count: rows.length, payments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments made' });
  }
});

// GET /api/reports/profit-loss?from=&to=
router.get('/profit-loss', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  const range = dateRange(from, to, fy);
  const invWhere = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...(Object.keys(range).length ? { invoice_date: range } : {}) };
  const expWhere = { business_id: businessId, is_deleted: false, ...(Object.keys(range).length ? { expense_date: range } : {}) };
  try {
    const [saleAgg, saleReturnAgg, saleItems, saleReturnItems, expenses] = await Promise.all([
      prisma.invoice.aggregate({ where: { ...invWhere, voucher_type: 'SALE' }, _sum: { total_amount: true, tax_amount: true, subtotal: true, discount_amount: true }, _count: { id: true } }),
      prisma.invoice.aggregate({ where: { ...invWhere, voucher_type: 'SALE_RETURN' }, _sum: { total_amount: true, tax_amount: true, subtotal: true, discount_amount: true }, _count: { id: true } }),
      prisma.invoiceItem.findMany({ where: { invoice: { ...invWhere, voucher_type: 'SALE' } }, select: { quantity: true, product_id: true, product: { select: { purchase_price: true } } } }),
      prisma.invoiceItem.findMany({ where: { invoice: { ...invWhere, voucher_type: 'SALE_RETURN' } }, select: { quantity: true, product_id: true, product: { select: { purchase_price: true } } } }),
      prisma.expense.findMany({ where: expWhere, select: { category: true, amount: true } }),
    ]);

    // Revenue = taxable value (GST collected is a liability, not income).
    const taxable = (a) => (a._sum.subtotal || 0) - (a._sum.discount_amount || 0);
    const gross_sales = taxable(saleAgg);
    const sale_returns = taxable(saleReturnAgg);
    const net_sales_after_returns = gross_sales - sale_returns;

    let cogs = 0; let items_without_cost = 0;
    for (const it of saleItems) {
      const pp = it.product?.purchase_price;
      if (pp) cogs += Math.round(it.quantity * pp); else items_without_cost += 1;
    }
    for (const it of saleReturnItems) {
      const pp = it.product?.purchase_price;
      if (pp) cogs -= Math.round(it.quantity * pp);
    }
    const gross_profit = net_sales_after_returns - cogs;

    const categoryMap = {};
    for (const e of expenses) {
      const cat = e.category || 'Uncategorized';
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, amount: 0 };
      categoryMap[cat].amount += e.amount;
    }
    const expenses_breakdown = Object.values(categoryMap).sort((a, b) => b.amount - a.amount);
    const total_expenses = expenses.reduce((s, e) => s + e.amount, 0);

    return res.json({
      period: { from: ymd(range.gte), to: ymd(range.lte) },
      basis: 'taxable_value',
      gross_sales, sale_returns, net_sales_after_returns,
      cogs, gross_profit, expenses_breakdown, total_expenses,
      net_profit: gross_profit - total_expenses,
      sales_invoice_count: saleAgg._count.id, return_invoice_count: saleReturnAgg._count.id,
      sales_tax: (saleAgg._sum.tax_amount || 0) - (saleReturnAgg._sum.tax_amount || 0),
      // COGS uses each product's CURRENT purchase price (no stock-valuation layers); lines with no cost price count as zero cost.
      cogs_incomplete: items_without_cost > 0,
      items_without_cost,
    });
  } catch (err) {
    console.error('P&L error:', err);
    return res.status(500).json({ error: 'Failed to fetch P&L' });
  }
});

// GET /api/reports/gst-summary?from=&to=
router.get('/gst-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const baseWhere = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...invoiceDateWhere(from, to, req.financialYear) };
  const build = (rows) => {
    const rateMap = {};
    for (const r of rows) {
      if (!rateMap[r.rate]) rateMap[r.rate] = { tax_rate: r.rate, taxable_amount: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 };
      const m = rateMap[r.rate];
      m.taxable_amount += r.taxable; m.cgst += r.cgst; m.sgst += r.sgst; m.igst += r.igst; m.total_tax += r.tax;
    }
    const by_rate = Object.values(rateMap).sort((a, b) => b.tax_rate - a.tax_rate);
    return {
      total_taxable: sumBy(rows, 'taxable'), total_cgst: sumBy(rows, 'cgst'), total_sgst: sumBy(rows, 'sgst'),
      total_igst: sumBy(rows, 'igst'), total_tax: sumBy(rows, 'tax'), by_rate,
    };
  };
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const sel = { id: true, voucher_type: true, subtotal: true, discount_amount: true, items: true };
    const [sInv, pInv] = await Promise.all([
      prisma.invoice.findMany({ where: { ...baseWhere, voucher_type: { in: ['SALE', 'SALE_RETURN'] } }, select: { ...sel, customer: { select: { state: true } } } }),
      prisma.invoice.findMany({ where: { ...baseWhere, voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] } }, select: { ...sel, supplier: { select: { state: true } } } }),
    ]);
    const sales = build(gstLines(sInv, business?.state));
    const purchases = build(gstLines(pInv, business?.state));
    res.json({ sales, purchases, net_gst_payable: sales.total_tax - purchases.total_tax });
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

// GET /api/reports/stock-summary
router.get('/stock-summary', async (req, res) => {
  const businessId = req.user.businessId;
  const fy = req.financialYear;

  try {
    const products = await prisma.product.findMany({
      where: { business_id: businessId, is_deleted: false, is_active: true },
      select: {
        id: true,
        name: true,
        unit: true,
        purchase_price: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (products.length === 0) {
      return res.json({ products: [], totals: { total_closing_qty: 0, total_stock_value: 0 } });
    }

    const productIds = products.map((p) => p.id);
    const snapshot = fy?.opening_stock_snapshot || {};

    // Invoice filter: only confirmed invoices in active FY
    const invoiceWhere = {
      business_id: businessId,
      is_deleted: false,
      status: { notIn: ['draft', 'cancelled'] },
      ...(fy ? { financial_year_id: fy.id } : {}),
    };

    // Query per-voucher-type breakdown in parallel
    const [purchasedAgg, purchaseReturnAgg, soldAgg, saleReturnAgg] = await Promise.all([
      prisma.invoiceItem.groupBy({
        by: ['product_id'],
        where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE' } },
        _sum: { quantity: true },
      }),
      prisma.invoiceItem.groupBy({
        by: ['product_id'],
        where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE_RETURN' } },
        _sum: { quantity: true },
      }),
      prisma.invoiceItem.groupBy({
        by: ['product_id'],
        where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE' } },
        _sum: { quantity: true },
      }),
      prisma.invoiceItem.groupBy({
        by: ['product_id'],
        where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE_RETURN' } },
        _sum: { quantity: true },
      }),
    ]);

    const toMap = (agg) => Object.fromEntries(agg.map((r) => [r.product_id, r._sum.quantity || 0]));
    const purchasedMap    = toMap(purchasedAgg);
    const purchaseRetMap  = toMap(purchaseReturnAgg);
    const soldMap         = toMap(soldAgg);
    const saleRetMap      = toMap(saleReturnAgg);

    const result = products.map((p) => {
      const opening_qty      = snapshot[p.id] ?? 0;
      const purchased_qty    = purchasedMap[p.id]   || 0;
      const purchase_return  = purchaseRetMap[p.id]  || 0;
      const sold_qty         = soldMap[p.id]         || 0;
      const sale_return_qty  = saleRetMap[p.id]      || 0;
      const closing_qty      = opening_qty + purchased_qty - purchase_return - sold_qty + sale_return_qty;
      const stock_value      = closing_qty * (p.purchase_price || 0);

      return {
        id: p.id,
        name: p.name,
        unit: p.unit,
        category_name: p.category?.name || null,
        opening_qty,
        purchased_qty,
        purchase_return,
        sold_qty,
        sale_return_qty,
        closing_qty,
        purchase_price: p.purchase_price || 0,
        stock_value,
      };
    });

    const totals = {
      total_closing_qty: result.reduce((s, p) => s + p.closing_qty, 0),
      total_stock_value: result.reduce((s, p) => s + p.stock_value, 0),
    };

    return res.json({ products: result, totals });
  } catch (err) {
    console.error('Stock summary error:', err);
    return res.status(500).json({ error: 'Failed to fetch stock summary' });
  }
});

// GET /api/reports/day-book?date=YYYY-MM-DD
router.get('/day-book', async (req, res) => {
  const { date } = req.query;
  const businessId = req.user.businessId;

  const dayStart = date ? parseDayStart(date) : todayDate();
  const dayEnd = parseDayEnd(dayStart);

  try {
    const [invoices, payments, expenses] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          business_id: businessId,
          is_deleted: false,
          voucher_type: { in: ['SALE', 'PURCHASE', 'SALE_RETURN', 'PURCHASE_RETURN'] },
          status: { notIn: ['draft', 'cancelled'] },
          invoice_date: { gte: dayStart, lte: dayEnd },
        },
        select: {
          id: true,
          invoice_number: true,
          voucher_type: true,
          total_amount: true,
          created_at: true,
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { created_at: 'asc' },
      }),
      prisma.payment.findMany({
        where: {
          business_id: businessId,
          is_reversed: false,
          payment_date: { gte: dayStart, lte: dayEnd },
        },
        select: {
          id: true,
          reference_number: true,
          payment_type: true,
          amount: true,
          created_at: true,
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { created_at: 'asc' },
      }),
      prisma.expense.findMany({
        where: {
          business_id: businessId,
          is_deleted: false,
          expense_date: { gte: dayStart, lte: dayEnd },
        },
        select: {
          id: true,
          category: true,
          amount: true,
          payment_mode: true,
          description: true,
          created_at: true,
        },
        orderBy: { created_at: 'asc' },
      }),
    ]);

    const entries = [];

    for (const inv of invoices) {
      const isSale = inv.voucher_type === 'SALE';
      const isSaleReturn = inv.voucher_type === 'SALE_RETURN';
      entries.push({
        created_at: inv.created_at,
        time: istTime(inv.created_at),
        type: inv.voucher_type,
        reference: inv.invoice_number,
        party: inv.customer?.name || inv.supplier?.name || '—',
        amount: inv.total_amount,
        dr: (isSale || inv.voucher_type === 'PURCHASE_RETURN') ? inv.total_amount : 0,
        cr: (isSaleReturn || inv.voucher_type === 'PURCHASE') ? inv.total_amount : 0,
      });
    }

    for (const pmt of payments) {
      // RECEIVED = customer paid us (cash in), PAID = we paid supplier (cash out)
      const isReceipt = pmt.payment_type === 'RECEIVED';
      entries.push({
        created_at: pmt.created_at,
        time: istTime(pmt.created_at),
        type: isReceipt ? 'RECEIPT' : 'PAYMENT',
        reference: pmt.reference_number || '—',
        party: pmt.customer?.name || pmt.supplier?.name || '—',
        amount: pmt.amount,
        dr: isReceipt ? pmt.amount : 0,
        cr: isReceipt ? 0 : pmt.amount,
      });
    }

    for (const exp of expenses) {
      entries.push({
        created_at: exp.created_at,
        time: istTime(exp.created_at),
        type: 'EXPENSE',
        reference: exp.category,
        party: exp.description || exp.category,
        amount: exp.amount,
        dr: 0,
        cr: exp.amount,
      });
    }

    // Sort all entries chronologically
    entries.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Strip internal created_at from output
    const outputEntries = entries.map(({ created_at, ...rest }) => rest); // eslint-disable-line no-unused-vars

    const totals = {
      total_sales:     invoices.filter(i => i.voucher_type === 'SALE').reduce((s, i) => s + i.total_amount, 0),
      total_purchases: invoices.filter(i => i.voucher_type === 'PURCHASE').reduce((s, i) => s + i.total_amount, 0),
      total_receipts:  payments.filter(p => p.payment_type === 'RECEIVED').reduce((s, p) => s + p.amount, 0),
      total_payments:  payments.filter(p => p.payment_type !== 'RECEIVED').reduce((s, p) => s + p.amount, 0),
      total_expenses:  expenses.reduce((s, e) => s + e.amount, 0),
    };

    return res.json({
      date: targetDate.toISOString().split('T')[0],
      entries: outputEntries,
      totals,
    });
  } catch (err) {
    console.error('Day book error:', err);
    return res.status(500).json({ error: 'Failed to fetch day book' });
  }
});

// ─── Phase 1 Routes ───────────────────────────────────────────────────────────

// GET /api/reports/all-transactions?from=&to=
router.get('/all-transactions', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const _r = dateRange(from, to, req.financialYear);
  const fromDate = _r.gte || new Date(0);
  const toDate = _r.lte || parseDayEnd(todayDate());

  try {
    const [invoices, payments, expenses] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          business_id: businessId,
          is_deleted:  false,
          voucher_type: { in: ['SALE', 'PURCHASE', 'SALE_RETURN', 'PURCHASE_RETURN'] },
          status:       { notIn: ['draft', 'cancelled'] },
          invoice_date: { gte: fromDate, lte: toDate },
        },
        select: {
          id: true, invoice_number: true, voucher_type: true,
          total_amount: true, invoice_date: true,
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { invoice_date: 'asc' },
      }),
      prisma.payment.findMany({
        where: {
          business_id:  businessId,
          is_reversed:  false,
          payment_date: { gte: fromDate, lte: toDate },
        },
        select: {
          id: true, reference_number: true, payment_type: true,
          amount: true, payment_date: true,
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
        },
        orderBy: { payment_date: 'asc' },
      }),
      prisma.expense.findMany({
        where: {
          business_id:  businessId,
          is_deleted:   false,
          expense_date: { gte: fromDate, lte: toDate },
        },
        select: { id: true, category: true, amount: true, description: true, expense_date: true },
        orderBy: { expense_date: 'asc' },
      }),
    ]);

    const entries = [];

    for (const inv of invoices) {
      const isSale          = inv.voucher_type === 'SALE';
      const isPurchReturn   = inv.voucher_type === 'PURCHASE_RETURN';
      entries.push({
        sort_date: inv.invoice_date,
        date:      inv.invoice_date.toISOString().split('T')[0],
        type:      inv.voucher_type,
        reference: inv.invoice_number,
        party:     inv.customer?.name || inv.supplier?.name || '—',
        amount:    inv.total_amount,
        dr: (isSale || isPurchReturn) ? inv.total_amount : 0,
        cr: (!isSale && !isPurchReturn) ? inv.total_amount : 0,
      });
    }

    for (const pmt of payments) {
      const isReceipt = pmt.payment_type === 'RECEIVED';
      entries.push({
        sort_date: pmt.payment_date,
        date:      pmt.payment_date.toISOString().split('T')[0],
        type:      isReceipt ? 'RECEIPT' : 'PAYMENT',
        reference: pmt.reference_number || '—',
        party:     pmt.customer?.name || pmt.supplier?.name || '—',
        amount:    pmt.amount,
        dr: isReceipt ? pmt.amount : 0,
        cr: isReceipt ? 0 : pmt.amount,
      });
    }

    for (const exp of expenses) {
      entries.push({
        sort_date: exp.expense_date,
        date:      exp.expense_date.toISOString().split('T')[0],
        type:      'EXPENSE',
        reference: exp.category,
        party:     exp.description || exp.category,
        amount:    exp.amount,
        dr:        0,
        cr:        exp.amount,
      });
    }

    entries.sort((a, b) => new Date(a.sort_date) - new Date(b.sort_date));
    const outputEntries = entries.map(({ sort_date, ...rest }) => rest); // eslint-disable-line no-unused-vars
    const total_dr = entries.reduce((s, e) => s + e.dr, 0);
    const total_cr = entries.reduce((s, e) => s + e.cr, 0);

    return res.json({ entries: outputEntries, totals: { total_dr, total_cr } });
  } catch (err) {
    console.error('All transactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/reports/expenses?from=&to=
router.get('/expenses', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const _r = dateRange(from, to, req.financialYear);
  const fromDate = _r.gte || new Date(0);
  const toDate = _r.lte || parseDayEnd(todayDate());

  try {
    const expenses = await prisma.expense.findMany({
      where: {
        business_id:  businessId,
        is_deleted:   false,
        expense_date: { gte: fromDate, lte: toDate },
      },
      select: {
        id: true, expense_date: true, category: true,
        description: true, payment_mode: true, amount: true,
      },
      orderBy: { expense_date: 'desc' },
    });

    return res.json({
      expenses: expenses.map((e) => ({
        id:           e.id,
        expense_date: e.expense_date.toISOString().split('T')[0],
        category:     e.category,
        description:  e.description || '',
        payment_mode: e.payment_mode,
        amount:       e.amount,
      })),
      total_amount: expenses.reduce((s, e) => s + e.amount, 0),
      count:        expenses.length,
    });
  } catch (err) {
    console.error('Expenses report error:', err);
    return res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// GET /api/reports/expense-by-category?from=&to=
router.get('/expense-by-category', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const _r = dateRange(from, to, req.financialYear);
  const fromDate = _r.gte || new Date(0);
  const toDate = _r.lte || parseDayEnd(todayDate());

  try {
    const grouped = await prisma.expense.groupBy({
      by:    ['category'],
      where: { business_id: businessId, is_deleted: false, expense_date: { gte: fromDate, lte: toDate } },
      _sum:  { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
    });

    const total_amount = grouped.reduce((s, g) => s + (g._sum.amount || 0), 0);
    const categories   = grouped.map((g) => ({
      category: g.category,
      count:    g._count.id,
      amount:   g._sum.amount || 0,
      pct:      total_amount > 0 ? Math.round(((g._sum.amount || 0) / total_amount) * 100) : 0,
    }));

    return res.json({ categories, total_amount });
  } catch (err) {
    console.error('Expense by category error:', err);
    return res.status(500).json({ error: 'Failed to fetch expense categories' });
  }
});

// GET /api/reports/low-stock?threshold=5
router.get('/low-stock', async (req, res) => {
  const { threshold = 5 } = req.query;
  const businessId = req.user.businessId;
  const fy         = req.financialYear;
  const thresh     = parseFloat(threshold);

  try {
    const products = await prisma.product.findMany({
      where: { business_id: businessId, is_deleted: false, is_active: true },
      select: {
        id: true, name: true, unit: true, purchase_price: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (products.length === 0) {
      return res.json({ products: [], threshold: thresh });
    }

    const productIds = products.map((p) => p.id);
    const snapshot   = fy?.opening_stock_snapshot || {};
    const invoiceWhere = {
      business_id: businessId,
      is_deleted:  false,
      status:      { notIn: ['draft', 'cancelled'] },
      ...(fy ? { financial_year_id: fy.id } : {}),
    };

    const [purchasedAgg, purchaseRetAgg, soldAgg, saleRetAgg] = await Promise.all([
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE_RETURN' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE_RETURN' } }, _sum: { quantity: true } }),
    ]);

    const toMap = (agg) => Object.fromEntries(agg.map((r) => [r.product_id, r._sum.quantity || 0]));
    const pMap = toMap(purchasedAgg);
    const prMap = toMap(purchaseRetAgg);
    const sMap = toMap(soldAgg);
    const srMap = toMap(saleRetAgg);

    const result = products
      .map((p) => {
        const opening     = snapshot[p.id] ?? 0;
        const closing_qty = opening + (pMap[p.id] || 0) - (prMap[p.id] || 0) - (sMap[p.id] || 0) + (srMap[p.id] || 0);
        return {
          id:            p.id,
          name:          p.name,
          category:      p.category?.name || '—',
          unit:          p.unit,
          closing_qty,
          purchase_price: p.purchase_price || 0,
          stock_value:   closing_qty * (p.purchase_price || 0),
        };
      })
      .filter((p) => p.closing_qty <= thresh)
      .sort((a, b) => a.closing_qty - b.closing_qty);

    return res.json({ products: result, threshold: thresh });
  } catch (err) {
    console.error('Low stock error:', err);
    return res.status(500).json({ error: 'Failed to fetch low stock' });
  }
});

// GET /api/reports/item-discounts?from=&to=
router.get('/item-discounts', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const invoiceWhere = {
    business_id: businessId,
    is_deleted:  false,
    voucher_type: 'SALE',
    status:      { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const items = await prisma.invoiceItem.findMany({
      where:   { product_id: { not: null }, invoice: invoiceWhere },
      select: {
        product_id: true, quantity: true, rate: true, discount_percent: true,
        product: { select: { name: true, unit: true } },
      },
    });

    const productMap = {};
    for (const item of items) {
      const discountAmount = Math.round(item.quantity * item.rate * (item.discount_percent / 100));
      if (discountAmount <= 0) continue;
      const key = item.product_id;
      if (!productMap[key]) {
        productMap[key] = {
          product_id:     key,
          name:           item.product?.name || '—',
          unit:           item.product?.unit || '—',
          qty_sold:       0,
          total_discount: 0,
          weighted_pct:   0,
          txn_count:      0,
        };
      }
      productMap[key].qty_sold       += item.quantity;
      productMap[key].total_discount += discountAmount;
      productMap[key].weighted_pct   += item.discount_percent;
      productMap[key].txn_count      += 1;
    }

    const products = Object.values(productMap)
      .map((p) => ({
        ...p,
        avg_discount_pct: p.txn_count > 0 ? Math.round((p.weighted_pct / p.txn_count) * 10) / 10 : 0,
      }))
      .sort((a, b) => b.total_discount - a.total_discount);

    const total_discount = products.reduce((s, p) => s + p.total_discount, 0);

    return res.json({ products, total_discount });
  } catch (err) {
    console.error('Item discounts error:', err);
    return res.status(500).json({ error: 'Failed to fetch item discounts' });
  }
});

// GET /api/reports/discount-report?from=&to=
router.get('/discount-report', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;

  const invoiceWhere = {
    business_id:     businessId,
    is_deleted:      false,
    voucher_type:    'SALE',
    status:          { notIn: ['draft', 'cancelled'] },
    discount_amount: { gt: 0 },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    const invoices = await prisma.invoice.findMany({
      where:   invoiceWhere,
      select: {
        id: true, invoice_number: true, invoice_date: true,
        subtotal: true, discount_amount: true, total_amount: true,
        customer: { select: { name: true } },
      },
      orderBy: { invoice_date: 'desc' },
    });

    const rows = invoices.map((inv) => ({
      invoice_number:  inv.invoice_number,
      date:            inv.invoice_date.toISOString().split('T')[0],
      customer_name:   inv.customer?.name || '—',
      gross_amount:    inv.subtotal + inv.discount_amount,
      discount_amount: inv.discount_amount,
      net_amount:      inv.total_amount,
    }));

    return res.json({
      invoices:       rows,
      total_gross:    rows.reduce((s, r) => s + r.gross_amount, 0),
      total_discount: rows.reduce((s, r) => s + r.discount_amount, 0),
      total_net:      rows.reduce((s, r) => s + r.net_amount, 0),
    });
  } catch (err) {
    console.error('Discount report error:', err);
    return res.status(500).json({ error: 'Failed to fetch discount report' });
  }
});

// GET /api/reports/party-statement?partyId=&partyType=customer|supplier&from=&to=
router.get('/party-statement', async (req, res) => {
  const { partyId, partyType, from, to } = req.query;
  const businessId = req.user.businessId;
  if (!partyId || !partyType) return res.status(400).json({ error: 'partyId and partyType are required' });
  if (!['customer', 'supplier'].includes(partyType)) return res.status(400).json({ error: "partyType must be 'customer' or 'supplier'" });

  const isCustomer = partyType === 'customer';
  const fy = req.financialYear;
  const fromDate = from ? parseDayStart(from) : null;
  const toDate = to ? parseDayEnd(to) : null;
  try {
    const party = await (isCustomer ? prisma.customer : prisma.supplier).findFirst({
      where: { id: partyId, business_id: businessId }, select: { id: true, name: true, phone: true },
    });
    if (!party) return res.status(404).json({ error: `${isCustomer ? 'Customer' : 'Supplier'} not found` });

    const model = isCustomer ? prisma.ledgerEntry : prisma.supplierLedgerEntry;
    const base = { business_id: businessId, [isCustomer ? 'customer_id' : 'supplier_id']: partyId, ...(fy ? { financial_year_id: fy.id } : {}) };
    // sign: customer balance = debit - credit, supplier balance = credit - debit
    const delta = (e) => (isCustomer ? e.debit - e.credit : e.credit - e.debit);

    let opening_balance = 0;
    if (fromDate) {
      const before = await model.aggregate({ where: { ...base, entry_date: { lt: fromDate } }, _sum: { debit: true, credit: true } });
      opening_balance = delta({ debit: before._sum.debit || 0, credit: before._sum.credit || 0 });
    }
    const entries = await model.findMany({
      where: { ...base, ...(fromDate || toDate ? { entry_date: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}) },
      orderBy: [{ entry_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      select: { id: true, entry_date: true, entry_type: true, reference_type: true, narration: true, debit: true, credit: true },
    });
    let running = opening_balance;
    const out = entries.map((e) => { running += delta(e); return { ...e, balance: running, date: ymd(e.entry_date) }; });
    return res.json({ party, opening_balance, closing_balance: running, entries: out });
  } catch (err) {
    console.error('Party statement error:', err);
    return res.status(500).json({ error: 'Failed to fetch party statement' });
  }
});

// GET /api/reports/sale-purchase-by-party?from=&to=&type=customer|supplier
router.get('/sale-purchase-by-party', async (req, res) => {
  const { from, to, type = 'customer' } = req.query;
  const businessId = req.user.businessId;

  const baseWhere = {
    business_id: businessId,
    is_deleted:  false,
    status:      { notIn: ['draft', 'cancelled'] },
    ...parseDateRange(from, to, req.financialYear),
  };

  try {
    if (type === 'customer') {
      const [sales, saleReturns] = await Promise.all([
        prisma.invoice.findMany({
          where:  { ...baseWhere, voucher_type: 'SALE', customer_id: { not: null } },
          select: { customer_id: true, total_amount: true, customer: { select: { name: true, phone: true } } },
        }),
        prisma.invoice.findMany({
          where:  { ...baseWhere, voucher_type: 'SALE_RETURN', customer_id: { not: null } },
          select: { customer_id: true, total_amount: true, customer: { select: { name: true, phone: true } } },
        }),
      ]);

      const partyMap = {};
      for (const inv of sales) {
        const id = inv.customer_id;
        if (!partyMap[id]) partyMap[id] = { name: inv.customer.name, phone: inv.customer.phone || '', total_sale: 0, sale_returns: 0, total_purchase: 0, purchase_returns: 0 };
        partyMap[id].total_sale += inv.total_amount;
      }
      for (const inv of saleReturns) {
        const id = inv.customer_id;
        if (!partyMap[id]) partyMap[id] = { name: inv.customer.name, phone: inv.customer.phone || '', total_sale: 0, sale_returns: 0, total_purchase: 0, purchase_returns: 0 };
        partyMap[id].sale_returns += inv.total_amount;
      }

      const parties = Object.entries(partyMap)
        .map(([id, p]) => ({ id, ...p, net: p.total_sale - p.sale_returns }))
        .sort((a, b) => b.net - a.net);

      return res.json({
        parties,
        totals: {
          total_sale:      parties.reduce((s, p) => s + p.total_sale, 0),
          total_purchase:  0,
          net:             parties.reduce((s, p) => s + p.net, 0),
        },
      });
    } else {
      const [purchases, purchaseReturns] = await Promise.all([
        prisma.invoice.findMany({
          where:  { ...baseWhere, voucher_type: 'PURCHASE', supplier_id: { not: null } },
          select: { supplier_id: true, total_amount: true, supplier: { select: { name: true, phone: true } } },
        }),
        prisma.invoice.findMany({
          where:  { ...baseWhere, voucher_type: 'PURCHASE_RETURN', supplier_id: { not: null } },
          select: { supplier_id: true, total_amount: true, supplier: { select: { name: true, phone: true } } },
        }),
      ]);

      const partyMap = {};
      for (const inv of purchases) {
        const id = inv.supplier_id;
        if (!partyMap[id]) partyMap[id] = { name: inv.supplier.name, phone: inv.supplier.phone || '', total_sale: 0, sale_returns: 0, total_purchase: 0, purchase_returns: 0 };
        partyMap[id].total_purchase += inv.total_amount;
      }
      for (const inv of purchaseReturns) {
        const id = inv.supplier_id;
        if (!partyMap[id]) partyMap[id] = { name: inv.supplier.name, phone: inv.supplier.phone || '', total_sale: 0, sale_returns: 0, total_purchase: 0, purchase_returns: 0 };
        partyMap[id].purchase_returns += inv.total_amount;
      }

      const parties = Object.entries(partyMap)
        .map(([id, p]) => ({ id, ...p, net: p.total_purchase - p.purchase_returns }))
        .sort((a, b) => b.net - a.net);

      return res.json({
        parties,
        totals: {
          total_sale:     0,
          total_purchase: parties.reduce((s, p) => s + p.total_purchase, 0),
          net:            parties.reduce((s, p) => s + p.net, 0),
        },
      });
    }
  } catch (err) {
    console.error('Sale purchase by party error:', err);
    return res.status(500).json({ error: 'Failed to fetch sale purchase by party' });
  }
});

// ─── Phase 2 Routes ──────────────────────────────────────────────────────────

// P2-1: GET /api/reports/bill-wise-profit?from=&to=
router.get('/bill-wise-profit', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        voucher_type: 'SALE',
        status: { notIn: ['draft', 'cancelled'] },
        ...fyFilter,
        ...parseDateRange(from, to, req.financialYear),
      },
      select: {
        id: true,
        invoice_number: true,
        invoice_date: true,
        subtotal: true,
        customer: { select: { name: true } },
        items: {
          select: {
            quantity: true,
            amount: true,
            product: { select: { purchase_price: true } },
          },
        },
      },
      orderBy: { invoice_date: 'asc' },
    });

    let hasAnyIncomplete = false;
    const rows = invoices.map((inv) => {
      let cogs = 0;
      let has_incomplete_cogs = false;
      for (const item of inv.items) {
        if (item.product && item.product.purchase_price != null) {
          cogs += item.quantity * item.product.purchase_price;
        } else {
          has_incomplete_cogs = true;
          hasAnyIncomplete = true;
        }
      }
      const sale_amount = inv.subtotal;
      const profit = sale_amount - cogs;
      const margin_pct = sale_amount > 0 ? (profit / sale_amount) * 100 : 0;
      return {
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        customer_name: inv.customer?.name || '—',
        sale_amount,
        cogs,
        profit,
        margin_pct: Math.round(margin_pct * 100) / 100,
        has_incomplete_cogs,
      };
    }).sort((a, b) => b.profit - a.profit);

    const totals = rows.reduce(
      (acc, r) => ({ total_sales: acc.total_sales + r.sale_amount, total_cogs: acc.total_cogs + r.cogs, total_profit: acc.total_profit + r.profit }),
      { total_sales: 0, total_cogs: 0, total_profit: 0 }
    );
    const avg_margin = totals.total_sales > 0 ? (totals.total_profit / totals.total_sales) * 100 : 0;

    res.json({ invoices: rows, totals: { ...totals, avg_margin: Math.round(avg_margin * 100) / 100 }, has_incomplete_cogs: hasAnyIncomplete });
  } catch (err) {
    console.error('Bill wise profit error:', err);
    res.status(500).json({ error: 'Failed to fetch bill wise profit' });
  }
});

// P2-2: GET /api/reports/item-wise-profit?from=&to=
router.get('/item-wise-profit', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  try {
    const items = await prisma.invoiceItem.findMany({
      where: {
        product_id: { not: null },
        invoice: {
          business_id: businessId,
          is_deleted: false,
          voucher_type: 'SALE',
          status: { notIn: ['draft', 'cancelled'] },
          ...fyFilter,
          ...parseDateRange(from, to, req.financialYear),
        },
      },
      select: {
        quantity: true,
        amount: true,
        product_id: true,
        product: { select: { name: true, unit: true, purchase_price: true } },
      },
    });

    const productMap = {};
    for (const item of items) {
      if (!item.product_id || !item.product) continue;
      const pp = item.product.purchase_price;
      if (pp == null) continue;
      if (!productMap[item.product_id]) {
        productMap[item.product_id] = {
          product_id: item.product_id,
          name: item.product.name,
          unit: item.product.unit,
          qty_sold: 0,
          sale_revenue: 0,
          cogs: 0,
        };
      }
      productMap[item.product_id].qty_sold += item.quantity;
      productMap[item.product_id].sale_revenue += item.amount;
      productMap[item.product_id].cogs += item.quantity * pp;
    }

    const products = Object.values(productMap).map((p) => {
      const gross_profit = p.sale_revenue - p.cogs;
      const margin_pct = p.sale_revenue > 0 ? (gross_profit / p.sale_revenue) * 100 : 0;
      return { ...p, gross_profit, margin_pct: Math.round(margin_pct * 100) / 100 };
    }).sort((a, b) => b.gross_profit - a.gross_profit);

    const totals = products.reduce(
      (acc, p) => ({ sale_revenue: acc.sale_revenue + p.sale_revenue, cogs: acc.cogs + p.cogs, gross_profit: acc.gross_profit + p.gross_profit }),
      { sale_revenue: 0, cogs: 0, gross_profit: 0 }
    );

    res.json({ products, totals });
  } catch (err) {
    console.error('Item wise profit error:', err);
    res.status(500).json({ error: 'Failed to fetch item wise profit' });
  }
});

// P2-3: GET /api/reports/item-category-pl?from=&to=
router.get('/item-category-pl', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  try {
    const items = await prisma.invoiceItem.findMany({
      where: {
        product_id: { not: null },
        invoice: {
          business_id: businessId,
          is_deleted: false,
          voucher_type: 'SALE',
          status: { notIn: ['draft', 'cancelled'] },
          ...fyFilter,
          ...parseDateRange(from, to, req.financialYear),
        },
      },
      select: {
        quantity: true,
        amount: true,
        product: {
          select: {
            purchase_price: true,
            category_id: true,
            category: { select: { name: true } },
          },
        },
      },
    });

    const catMap = {};
    for (const item of items) {
      if (!item.product) continue;
      const pp = item.product.purchase_price;
      if (pp == null) continue;
      const catId = item.product.category_id || '__none__';
      const catName = item.product.category?.name || 'Uncategorised';
      if (!catMap[catId]) {
        catMap[catId] = { category_name: catName, product_count: new Set(), qty_sold: 0, sale_revenue: 0, cogs: 0 };
      }
      if (item.product.category_id) catMap[catId].product_count.add(item.product.category_id);
      catMap[catId].qty_sold += item.quantity;
      catMap[catId].sale_revenue += item.amount;
      catMap[catId].cogs += item.quantity * pp;
    }

    const categories = Object.values(catMap).map((c) => {
      const gross_profit = c.sale_revenue - c.cogs;
      const margin_pct = c.sale_revenue > 0 ? (gross_profit / c.sale_revenue) * 100 : 0;
      return {
        category_name: c.category_name,
        qty_sold: c.qty_sold,
        sale_revenue: c.sale_revenue,
        cogs: c.cogs,
        gross_profit,
        margin_pct: Math.round(margin_pct * 100) / 100,
      };
    }).sort((a, b) => b.gross_profit - a.gross_profit);

    const totals = categories.reduce(
      (acc, c) => ({ sale_revenue: acc.sale_revenue + c.sale_revenue, cogs: acc.cogs + c.cogs, gross_profit: acc.gross_profit + c.gross_profit }),
      { sale_revenue: 0, cogs: 0, gross_profit: 0 }
    );

    res.json({ categories, totals });
  } catch (err) {
    console.error('Item category P&L error:', err);
    res.status(500).json({ error: 'Failed to fetch item category P&L' });
  }
});

// P2-4: GET /api/reports/stock-detail?productId=&from=&to=
router.get('/stock-detail', async (req, res) => {
  const { productId, from, to } = req.query;
  const businessId = req.user.businessId;
  if (!productId) return res.status(400).json({ error: 'productId is required' });
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  try {
    const product = await prisma.product.findFirst({
      where: { id: productId, business_id: businessId, is_deleted: false },
      select: { name: true, unit: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const dateFilter = parseDateRange(from, to, req.financialYear);

    const items = await prisma.invoiceItem.findMany({
      where: {
        product_id: productId,
        invoice: {
          business_id: businessId,
          is_deleted: false,
          voucher_type: { in: ['SALE', 'PURCHASE', 'SALE_RETURN', 'PURCHASE_RETURN'] },
          status: { notIn: ['draft', 'cancelled'] },
          ...fyFilter,
          ...(dateFilter.invoice_date ? { invoice_date: dateFilter.invoice_date } : {}),
        },
      },
      select: {
        quantity: true,
        invoice: {
          select: {
            invoice_number: true,
            invoice_date: true,
            voucher_type: true,
            customer: { select: { name: true } },
            supplier: { select: { name: true } },
          },
        },
      },
      orderBy: { invoice: { invoice_date: 'asc' } },
    });

    const snapshot = req.financialYear?.opening_stock_snapshot || {};
    const opening_qty = snapshot[productId] ?? 0;
    let running = opening_qty;

    const entries = items.map((item) => {
      const vt = item.invoice.voucher_type;
      const isPurchase = vt === 'PURCHASE';
      const isSaleRet = vt === 'SALE_RETURN';
      const isIn = isPurchase || isSaleRet;
      const qty_in  = isIn ? item.quantity : 0;
      const qty_out = isIn ? 0 : item.quantity;
      running += qty_in - qty_out;
      const party = item.invoice.customer?.name || item.invoice.supplier?.name || '—';
      return {
        date: item.invoice.invoice_date,
        voucher_type: vt,
        invoice_number: item.invoice.invoice_number,
        party_name: party,
        qty_in,
        qty_out,
        balance: running,
      };
    });

    res.json({ product, opening_qty, entries, closing_qty: running });
  } catch (err) {
    console.error('Stock detail error:', err);
    res.status(500).json({ error: 'Failed to fetch stock detail' });
  }
});

// P2-5: GET /api/reports/item-by-party?from=&to=&partyType=customer|supplier
router.get('/item-by-party', async (req, res) => {
  const { from, to, partyType = 'customer' } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  const voucherType = partyType === 'supplier' ? 'PURCHASE' : 'SALE';
  try {
    const items = await prisma.invoiceItem.findMany({
      where: {
        product_id: { not: null },
        invoice: {
          business_id: businessId,
          is_deleted: false,
          voucher_type: voucherType,
          status: { notIn: ['draft', 'cancelled'] },
          ...fyFilter,
          ...parseDateRange(from, to, req.financialYear),
        },
      },
      select: {
        quantity: true,
        amount: true,
        product: { select: { name: true, unit: true } },
        invoice: {
          select: {
            customer_id: true,
            supplier_id: true,
            customer: { select: { name: true } },
            supplier: { select: { name: true } },
          },
        },
      },
    });

    const groupMap = {};
    for (const item of items) {
      if (!item.product) continue;
      const partyId = partyType === 'supplier' ? item.invoice.supplier_id : item.invoice.customer_id;
      const partyName = partyType === 'supplier' ? item.invoice.supplier?.name : item.invoice.customer?.name;
      if (!partyId) continue;
      const key = `${item.product_id ?? ''}::${partyId}`;
      if (!groupMap[key]) {
        groupMap[key] = {
          product_name: item.product.name,
          product_unit: item.product.unit,
          party_name: partyName || '—',
          qty: 0,
          amount: 0,
        };
      }
      groupMap[key].qty += item.quantity;
      groupMap[key].amount += item.amount;
    }

    const rows = Object.values(groupMap).sort((a, b) =>
      a.product_name.localeCompare(b.product_name) || a.party_name.localeCompare(b.party_name)
    );

    res.json({ rows });
  } catch (err) {
    console.error('Item by party error:', err);
    res.status(500).json({ error: 'Failed to fetch item by party' });
  }
});

// P2-6: GET /api/reports/stock-by-category
router.get('/stock-by-category', async (req, res) => {
  const businessId = req.user.businessId;
  const fy = req.financialYear;
  try {
    const products = await prisma.product.findMany({
      where: { business_id: businessId, is_deleted: false, is_active: true },
      select: {
        id: true,
        name: true,
        unit: true,
        purchase_price: true,
        category_id: true,
        category: { select: { name: true } },
      },
    });

    if (products.length === 0) return res.json({ categories: [], totals: { total_categories: 0, total_products: 0, total_stock_value: 0 } });

    const productIds = products.map((p) => p.id);
    const snapshot = fy?.opening_stock_snapshot || {};
    const invoiceWhere = {
      business_id: businessId,
      is_deleted: false,
      status: { notIn: ['draft', 'cancelled'] },
      ...(fy ? { financial_year_id: fy.id } : {}),
    };

    const [purchasedAgg, purchaseReturnAgg, soldAgg, saleReturnAgg] = await Promise.all([
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'PURCHASE_RETURN' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE' } }, _sum: { quantity: true } }),
      prisma.invoiceItem.groupBy({ by: ['product_id'], where: { product_id: { in: productIds }, invoice: { ...invoiceWhere, voucher_type: 'SALE_RETURN' } }, _sum: { quantity: true } }),
    ]);

    const toMap = (agg) => Object.fromEntries(agg.map((r) => [r.product_id, r._sum.quantity || 0]));
    const purchasedMap   = toMap(purchasedAgg);
    const purchaseRetMap = toMap(purchaseReturnAgg);
    const soldMap        = toMap(soldAgg);
    const saleRetMap     = toMap(saleReturnAgg);

    const catMap = {};
    for (const p of products) {
      const opening = snapshot[p.id] ?? 0;
      const closing = opening + (purchasedMap[p.id] || 0) - (purchaseRetMap[p.id] || 0) - (soldMap[p.id] || 0) + (saleRetMap[p.id] || 0);
      const value = closing * (p.purchase_price || 0);
      const catId = p.category_id || '__none__';
      const catName = p.category?.name || 'Uncategorised';
      if (!catMap[catId]) catMap[catId] = { category_name: catName, product_count: 0, total_closing_qty: 0, total_stock_value: 0 };
      catMap[catId].product_count += 1;
      catMap[catId].total_closing_qty += closing;
      catMap[catId].total_stock_value += value;
    }

    const categories = Object.values(catMap).sort((a, b) => b.total_stock_value - a.total_stock_value);
    const totals = {
      total_categories: categories.length,
      total_products: products.length,
      total_stock_value: categories.reduce((s, c) => s + c.total_stock_value, 0),
    };

    res.json({ categories, totals });
  } catch (err) {
    console.error('Stock by category error:', err);
    res.status(500).json({ error: 'Failed to fetch stock by category' });
  }
});

// P2-7: GET /api/reports/sale-purchase-by-category?from=&to=
router.get('/sale-purchase-by-category', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  const dateFilter = parseDateRange(from, to, req.financialYear);
  const baseInvoice = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...fyFilter, ...dateFilter };
  try {
    const [saleItems, purchaseItems] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: { product_id: { not: null }, invoice: { ...baseInvoice, voucher_type: 'SALE' } },
        select: { quantity: true, amount: true, product: { select: { category_id: true, category: { select: { name: true } } } } },
      }),
      prisma.invoiceItem.findMany({
        where: { product_id: { not: null }, invoice: { ...baseInvoice, voucher_type: 'PURCHASE' } },
        select: { quantity: true, amount: true, product: { select: { category_id: true, category: { select: { name: true } } } } },
      }),
    ]);

    const catMap = {};
    const ensure = (catId, catName) => {
      if (!catMap[catId]) catMap[catId] = { category_name: catName, sale_qty: 0, sale_amount: 0, purchase_qty: 0, purchase_amount: 0 };
    };
    for (const item of saleItems) {
      if (!item.product) continue;
      const catId = item.product.category_id || '__none__';
      ensure(catId, item.product.category?.name || 'Uncategorised');
      catMap[catId].sale_qty += item.quantity;
      catMap[catId].sale_amount += item.amount;
    }
    for (const item of purchaseItems) {
      if (!item.product) continue;
      const catId = item.product.category_id || '__none__';
      ensure(catId, item.product.category?.name || 'Uncategorised');
      catMap[catId].purchase_qty += item.quantity;
      catMap[catId].purchase_amount += item.amount;
    }

    const categories = Object.values(catMap).map((c) => ({ ...c, net: c.sale_amount - c.purchase_amount }))
      .sort((a, b) => b.sale_amount - a.sale_amount);

    const totals = categories.reduce(
      (acc, c) => ({
        sale_qty: acc.sale_qty + c.sale_qty, sale_amount: acc.sale_amount + c.sale_amount,
        purchase_qty: acc.purchase_qty + c.purchase_qty, purchase_amount: acc.purchase_amount + c.purchase_amount,
        net: acc.net + c.net,
      }),
      { sale_qty: 0, sale_amount: 0, purchase_qty: 0, purchase_amount: 0, net: 0 }
    );

    res.json({ categories, totals });
  } catch (err) {
    console.error('Sale purchase by category error:', err);
    res.status(500).json({ error: 'Failed to fetch sale purchase by category' });
  }
});

// P2-8: GET /api/reports/party-wise-pl?from=&to=
router.get('/party-wise-pl', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        business_id: businessId,
        is_deleted: false,
        voucher_type: 'SALE',
        status: { notIn: ['draft', 'cancelled'] },
        ...fyFilter,
        ...parseDateRange(from, to, req.financialYear),
      },
      select: {
        customer_id: true,
        subtotal: true,
        customer: { select: { name: true } },
        items: { select: { quantity: true, product: { select: { purchase_price: true } } } },
      },
    });

    const partyMap = {};
    for (const inv of invoices) {
      const cid = inv.customer_id || '__none__';
      const cname = inv.customer?.name || 'Walk-in';
      if (!partyMap[cid]) partyMap[cid] = { customer_name: cname, sale_revenue: 0, cogs: 0 };
      partyMap[cid].sale_revenue += inv.subtotal;
      for (const item of inv.items) {
        if (item.product?.purchase_price != null) {
          partyMap[cid].cogs += item.quantity * item.product.purchase_price;
        }
      }
    }

    const customers = Object.values(partyMap).map((c) => {
      const gross_profit = c.sale_revenue - c.cogs;
      const margin_pct = c.sale_revenue > 0 ? (gross_profit / c.sale_revenue) * 100 : 0;
      return { ...c, gross_profit, margin_pct: Math.round(margin_pct * 100) / 100 };
    }).sort((a, b) => b.gross_profit - a.gross_profit);

    const totals = customers.reduce(
      (acc, c) => ({ total_revenue: acc.total_revenue + c.sale_revenue, total_profit: acc.total_profit + c.gross_profit }),
      { total_revenue: 0, total_profit: 0 }
    );
    const avg_margin = totals.total_revenue > 0 ? (totals.total_profit / totals.total_revenue) * 100 : 0;

    res.json({ customers, totals: { ...totals, avg_margin: Math.round(avg_margin * 100) / 100 } });
  } catch (err) {
    console.error('Party wise P&L error:', err);
    res.status(500).json({ error: 'Failed to fetch party wise P&L' });
  }
});

// P2-9: GET /api/reports/all-parties
router.get('/all-parties', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const [customers, suppliers] = await Promise.all([
      prisma.customer.findMany({
        where: { business_id: businessId, is_deleted: false },
        select: { id: true, name: true, phone: true, gstin: true,
          invoices: { where: { is_deleted: false, voucher_type: 'SALE', status: { notIn: ['draft', 'cancelled'] } }, select: { total_amount: true, amount_paid: true, balance_due: true } } },
      }),
      prisma.supplier.findMany({
        where: { business_id: businessId, is_deleted: false },
        select: { id: true, name: true, phone: true, gstin: true,
          invoices: { where: { is_deleted: false, voucher_type: 'PURCHASE', status: { notIn: ['draft', 'cancelled'] } }, select: { total_amount: true, amount_paid: true, balance_due: true } } },
      }),
    ]);
    const mapParty = (p) => {
      const total_invoiced = p.invoices.reduce((s, i) => s + i.total_amount, 0);
      const total_paid = p.invoices.reduce((s, i) => s + i.amount_paid, 0);
      return { id: p.id, name: p.name, phone: p.phone || '', gstin: p.gstin || '', total_invoiced, total_paid, balance: p.invoices.reduce((s, i) => s + i.balance_due, 0) };
    };
    const customerList = customers.map(mapParty).sort((a, b) => b.balance - a.balance);
    const supplierList = suppliers.map(mapParty).sort((a, b) => b.balance - a.balance);
    res.json({
      customers: customerList, suppliers: supplierList,
      total_receivable: customerList.reduce((s, c) => s + c.balance, 0),
      total_payable: supplierList.reduce((s, c) => s + c.balance, 0),
    });
  } catch (err) {
    console.error('All parties error:', err);
    res.status(500).json({ error: 'Failed to fetch all parties' });
  }
});

// P2-10: GET /api/reports/gstr1?from=&to=
router.get('/gstr1', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const invoices = await prisma.invoice.findMany({
      where: { business_id: businessId, is_deleted: false, voucher_type: { in: ['SALE', 'SALE_RETURN'] }, status: { notIn: ['draft', 'cancelled'] }, ...invoiceDateWhere(from, to, req.financialYear) },
      select: {
        id: true, invoice_number: true, invoice_date: true, voucher_type: true, subtotal: true, discount_amount: true,
        customer: { select: { name: true, gstin: true, state: true } },
        items: { select: { amount: true, tax_amount: true, tax_rate: true, quantity: true, product: { select: { hsn_code: true, unit: true, description: true } } } },
      },
      orderBy: { invoice_date: 'asc' },
    });

    const rows = gstLines(invoices, business?.state);
    const b2bMap = {}, b2bInv = {}, cdnr = {}, b2csMap = {}, hsnMap = {};
    let nil_rated_taxable = 0;

    for (const r of rows) {
      const inv = r.inv;
      const gstin = inv.customer?.gstin?.trim();
      if (gstin) {
        const bucket = r.sign < 0 ? cdnr : b2bInv;
        if (!bucket[inv.id]) bucket[inv.id] = { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, gstin, customer_name: inv.customer?.name || 'Unknown', taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0 };
        const b = bucket[inv.id];
        b.taxable += r.taxable; b.igst += r.igst; b.cgst += r.cgst; b.sgst += r.sgst; b.total += r.taxable + r.tax;
      } else {
        const key = `${r.rate}`;
        if (!b2csMap[key]) b2csMap[key] = { rate: r.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
        b2csMap[key].taxable += r.taxable; b2csMap[key].igst += r.igst; b2csMap[key].cgst += r.cgst; b2csMap[key].sgst += r.sgst;
      }
      if (r.rate === 0) nil_rated_taxable += r.taxable;
      const hsn = r.item.product?.hsn_code;
      if (hsn) {
        if (!hsnMap[hsn]) hsnMap[hsn] = { hsn_code: hsn, description: r.item.product?.description || '', uqc: r.item.product?.unit || 'NOS', qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
        const h = hsnMap[hsn];
        h.qty += r.sign * r.item.quantity; h.taxable += r.taxable; h.igst += r.igst; h.cgst += r.cgst; h.sgst += r.sgst;
      }
    }
    // per-GSTIN summary (earlier response shape) built from the invoice-wise rows
    for (const b of Object.values(b2bInv)) {
      if (!b2bMap[b.gstin]) b2bMap[b.gstin] = { gstin: b.gstin, customer_name: b.customer_name, invoice_count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0 };
      const m = b2bMap[b.gstin];
      m.invoice_count += 1; m.taxable += b.taxable; m.igst += b.igst; m.cgst += b.cgst; m.sgst += b.sgst; m.total += b.total;
    }
    const byDate = (a, b) => new Date(a.invoice_date) - new Date(b.invoice_date);
    res.json({
      b2b: Object.values(b2bMap).sort((a, b) => a.gstin.localeCompare(b.gstin)),
      b2b_invoices: Object.values(b2bInv).sort(byDate),
      credit_notes: Object.values(cdnr).sort(byDate),
      b2cs: Object.values(b2csMap).sort((a, b) => a.rate - b.rate),
      nil_rated_taxable,
      hsn_summary: Object.values(hsnMap).sort((a, b) => a.hsn_code.localeCompare(b.hsn_code)),
      period: { from: from || null, to: to || null },
      notes: 'Draft working only. B2CL (inter-state B2C above the threshold), exports and e-invoice IRNs are not separated; verify before filing.',
    });
  } catch (err) {
    console.error('GSTR-1 error:', err);
    res.status(500).json({ error: 'Failed to fetch GSTR-1' });
  }
});

// P2-11: GET /api/reports/gstr3b?from=&to=
router.get('/gstr3b', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const where = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...invoiceDateWhere(from, to, req.financialYear) };
    const sel = { voucher_type: true, subtotal: true, discount_amount: true, items: true };
    const [sInv, pInv] = await Promise.all([
      prisma.invoice.findMany({ where: { ...where, voucher_type: { in: ['SALE', 'SALE_RETURN'] } }, select: { ...sel, customer: { select: { gstin: true, state: true } } } }),
      prisma.invoice.findMany({ where: { ...where, voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] } }, select: { ...sel, supplier: { select: { state: true } } } }),
    ]);
    const sRows = gstLines(sInv, business?.state);
    const pRows = gstLines(pInv, business?.state);
    const taxed = sRows.filter((r) => r.rate > 0);
    const nil = sRows.filter((r) => r.rate === 0);
    const isB2B = (r) => !!r.inv.customer?.gstin?.trim();
    const heads = (rows) => ({ taxable: sumBy(rows, 'taxable'), igst: sumBy(rows, 'igst'), cgst: sumBy(rows, 'cgst'), sgst: sumBy(rows, 'sgst') });
    const out = heads(taxed);
    const itc = heads(pRows.filter((r) => r.rate > 0));
    res.json({
      section_31: {
        outward_taxable_supplies: out,
        nil_rated: { taxable: sumBy(nil, 'taxable') },
        b2b: heads(taxed.filter(isB2B)),
        b2c: heads(taxed.filter((r) => !isB2B(r))),
      },
      section_4: { itc_available: itc },
      section_51: { net_tax_payable: { igst: out.igst - itc.igst, cgst: out.cgst - itc.cgst, sgst: out.sgst - itc.sgst } },
      period: { from: from || null, to: to || null },
      notes: 'Draft working only. ITC is assumed fully eligible (no blocked-credit or reverse-charge handling); cross-head ITC set-off is not applied.',
    });
  } catch (err) {
    console.error('GSTR-3B error:', err);
    res.status(500).json({ error: 'Failed to fetch GSTR-3B' });
  }
});

// P2-12: GET /api/reports/hsn-summary?from=&to=
router.get('/hsn-summary', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const invoices = await prisma.invoice.findMany({
      where: { business_id: businessId, is_deleted: false, voucher_type: { in: ['SALE', 'SALE_RETURN'] }, status: { notIn: ['draft', 'cancelled'] }, ...invoiceDateWhere(from, to, req.financialYear) },
      select: {
        voucher_type: true, subtotal: true, discount_amount: true,
        customer: { select: { state: true } },
        items: { select: { amount: true, tax_amount: true, tax_rate: true, quantity: true, product: { select: { hsn_code: true, unit: true, description: true } } } },
      },
    });
    const hsnMap = {};
    for (const r of gstLines(invoices, business?.state)) {
      const hsn = r.item.product?.hsn_code;
      if (!hsn) continue;
      if (!hsnMap[hsn]) hsnMap[hsn] = { hsn_code: hsn, description: r.item.product?.description || '', uqc: r.item.product?.unit || 'NOS', qty: 0, taxable_value: 0, igst: 0, cgst: 0, sgst: 0, total_tax: 0 };
      const h = hsnMap[hsn];
      h.qty += r.sign * r.item.quantity; h.taxable_value += r.taxable; h.igst += r.igst; h.cgst += r.cgst; h.sgst += r.sgst; h.total_tax += r.tax;
    }
    const rows = Object.values(hsnMap).sort((a, b) => a.hsn_code.localeCompare(b.hsn_code));
    const totals = rows.reduce((acc, r) => ({ taxable_value: acc.taxable_value + r.taxable_value, total_tax: acc.total_tax + r.total_tax }), { taxable_value: 0, total_tax: 0 });
    res.json({ rows, totals });
  } catch (err) {
    console.error('HSN summary error:', err);
    res.status(500).json({ error: 'Failed to fetch HSN summary' });
  }
});

// P2-13: GET /api/reports/gst-rate-report?from=&to=
router.get('/gst-rate-report', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};
  const dateFilter = parseDateRange(from, to, req.financialYear);
  const baseInvoice = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...fyFilter, ...dateFilter };
  try {
    const [saleItems, purchaseItems] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: { invoice: { ...baseInvoice, voucher_type: 'SALE' } },
        select: { amount: true, tax_amount: true, tax_rate: true },
      }),
      prisma.invoiceItem.findMany({
        where: { invoice: { ...baseInvoice, voucher_type: 'PURCHASE' } },
        select: { amount: true, tax_amount: true, tax_rate: true },
      }),
    ]);

    const slabMap = {};
    const ensureSlab = (rate) => {
      if (!slabMap[rate]) slabMap[rate] = { rate, sale_taxable: 0, output_tax: 0, purchase_taxable: 0, input_credit: 0 };
    };
    for (const item of saleItems) {
      ensureSlab(item.tax_rate); slabMap[item.tax_rate].sale_taxable += item.amount; slabMap[item.tax_rate].output_tax += item.tax_amount;
    }
    for (const item of purchaseItems) {
      ensureSlab(item.tax_rate); slabMap[item.tax_rate].purchase_taxable += item.amount; slabMap[item.tax_rate].input_credit += item.tax_amount;
    }

    const slabs = Object.values(slabMap).map((s) => ({ ...s, net_payable: s.output_tax - s.input_credit }))
      .sort((a, b) => a.rate - b.rate);

    const totals = slabs.reduce(
      (acc, s) => ({ sale_taxable: acc.sale_taxable + s.sale_taxable, output_tax: acc.output_tax + s.output_tax, purchase_taxable: acc.purchase_taxable + s.purchase_taxable, input_credit: acc.input_credit + s.input_credit, net_payable: acc.net_payable + s.net_payable }),
      { sale_taxable: 0, output_tax: 0, purchase_taxable: 0, input_credit: 0, net_payable: 0 }
    );

    res.json({ slabs, totals });
  } catch (err) {
    console.error('GST rate report error:', err);
    res.status(500).json({ error: 'Failed to fetch GST rate report' });
  }
});

// ─── P3-1: Cash Flow Statement ────────────────────────────────────────────────
router.get('/cash-flow', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const range = dateRange(from, to, req.financialYear);
  const has = Object.keys(range).length > 0;
  try {
    const [receipts, paymentsToSuppliers, expenses] = await Promise.all([
      prisma.payment.aggregate({ where: { business_id: businessId, payment_type: 'RECEIVED', is_reversed: false, ...(has ? { payment_date: range } : {}) }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { business_id: businessId, payment_type: 'PAID', is_reversed: false, ...(has ? { payment_date: range } : {}) }, _sum: { amount: true } }),
      prisma.expense.aggregate({ where: { business_id: businessId, is_deleted: false, ...(has ? { expense_date: range } : {}) }, _sum: { amount: true } }),
    ]);
    const receipts_from_customers = receipts._sum.amount || 0;
    const payments_to_suppliers = paymentsToSuppliers._sum.amount || 0;
    const expenses_paid = expenses._sum.amount || 0;
    const net_operating = receipts_from_customers - payments_to_suppliers - expenses_paid;
    res.json({
      operating: { receipts_from_customers, payments_to_suppliers, expenses_paid, net_operating },
      investing: { net_investing: 0 }, financing: { net_financing: 0 }, net_change: net_operating,
      notes: 'Direct-method operating cash flow from recorded payments and expenses; investing/financing are not tracked.',
    });
  } catch (err) {
    console.error('Cash flow error:', err);
    res.status(500).json({ error: 'Failed to fetch cash flow' });
  }
});

// ─── P3-2: Trial Balance ───────────────────────────────────────────────────────
router.get('/trial-balance', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  const range = dateRange(from, to, req.financialYear);
  const has = Object.keys(range).length > 0;
  const inv = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...(has ? { invoice_date: range } : {}) };
  try {
    const sum = (vt) => prisma.invoice.aggregate({ where: { ...inv, voucher_type: vt }, _sum: { subtotal: true, discount_amount: true, tax_amount: true, total_amount: true } });
    const pay = (type) => prisma.payment.aggregate({ where: { business_id: businessId, payment_type: type, is_reversed: false, ...(has ? { payment_date: range } : {}) }, _sum: { amount: true } });
    const [sale, purchase, saleRet, purchaseRet, rec, paid, exp] = await Promise.all([
      sum('SALE'), sum('PURCHASE'), sum('SALE_RETURN'), sum('PURCHASE_RETURN'), pay('RECEIVED'), pay('PAID'),
      prisma.expense.aggregate({ where: { business_id: businessId, is_deleted: false, ...(has ? { expense_date: range } : {}) }, _sum: { amount: true } }),
    ]);
    const g = (a, k) => a._sum[k] || 0;
    const taxableOf = (a) => g(a, 'subtotal') - g(a, 'discount_amount');
    const sales = taxableOf(sale) - taxableOf(saleRet);
    const purchases = taxableOf(purchase) - taxableOf(purchaseRet);
    const outputTax = g(sale, 'tax_amount') - g(saleRet, 'tax_amount');
    const inputTax = g(purchase, 'tax_amount') - g(purchaseRet, 'tax_amount');
    const receivables = (g(sale, 'total_amount') - g(saleRet, 'total_amount')) - g(rec, 'amount');
    const payables = (g(purchase, 'total_amount') - g(purchaseRet, 'total_amount')) - g(paid, 'amount');
    const expenseTotal = g(exp, 'amount');
    const cash = g(rec, 'amount') - g(paid, 'amount') - expenseTotal;

    // Every line is a signed balance placed on the Dr or Cr side.
    const line = (account, balance) => (balance >= 0 ? { account, dr: balance, cr: 0 } : { account, dr: 0, cr: -balance });
    const accounts = [
      { account: 'Sales', dr: 0, cr: sales },
      { account: 'Purchases', dr: purchases, cr: 0 },
      { account: 'Expenses', dr: expenseTotal, cr: 0 },
      { account: 'Output GST', dr: 0, cr: outputTax },
      { account: 'Input GST', dr: inputTax, cr: 0 },
      line('Accounts Receivable', receivables),
      line('Accounts Payable (credit balance)', -payables),
      line('Cash / Bank', cash),
    ];
    const total_dr = accounts.reduce((s, a) => s + a.dr, 0);
    const total_cr = accounts.reduce((s, a) => s + a.cr, 0);
    res.json({
      accounts, total_dr, total_cr, balanced: total_dr === total_cr, difference: total_dr - total_cr,
      notes: 'Derived from invoices, payments and expenses (no double-entry journal), so it excludes opening balances, stock and advances; a non-zero difference is expected in those cases.',
    });
  } catch (err) {
    console.error('Trial balance error:', err);
    res.status(500).json({ error: 'Failed to fetch trial balance' });
  }
});

// ─── P3-3: Balance Sheet ───────────────────────────────────────────────────────
router.get('/balance-sheet', async (req, res) => {
  const { asOf } = req.query;
  const businessId = req.user.businessId;
  try {
    // Position as at a date, across ALL financial years (a balance sheet is cumulative, not per-year).
    const upTo = asOf ? { lte: parseDayEnd(asOf) } : undefined;
    const inv = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, ...(upTo ? { invoice_date: upTo } : {}) };
    const sum = (vt) => prisma.invoice.aggregate({ where: { ...inv, voucher_type: vt }, _sum: { total_amount: true } });
    const pay = (type) => prisma.payment.aggregate({ where: { business_id: businessId, payment_type: type, is_reversed: false, ...(upTo ? { payment_date: upTo } : {}) }, _sum: { amount: true } });
    const [sale, purchase, saleRet, purchaseRet, rec, paid, exp, products] = await Promise.all([
      sum('SALE'), sum('PURCHASE'), sum('SALE_RETURN'), sum('PURCHASE_RETURN'), pay('RECEIVED'), pay('PAID'),
      prisma.expense.aggregate({ where: { business_id: businessId, is_deleted: false, ...(upTo ? { expense_date: upTo } : {}) }, _sum: { amount: true } }),
      prisma.product.findMany({ where: { business_id: businessId, is_deleted: false }, select: { purchase_price: true, stock_quantity: true } }),
    ]);
    const g = (a, k) => a._sum[k] || 0;
    // stock_quantity is the CURRENT quantity, so stock value is as of today regardless of asOf
    const stockValue = products.reduce((s, p) => s + Math.round(Math.max(0, p.stock_quantity || 0) * (p.purchase_price || 0)), 0);
    const total_receivable = (g(sale, 'total_amount') - g(saleRet, 'total_amount')) - g(rec, 'amount');
    const total_payable = (g(purchase, 'total_amount') - g(purchaseRet, 'total_amount')) - g(paid, 'amount');
    const cash_and_bank = g(rec, 'amount') - g(paid, 'amount') - g(exp, 'amount');
    const total_assets = stockValue + total_receivable + cash_and_bank;
    res.json({
      assets: { stock_value: stockValue, total_receivable, cash_and_bank, total_assets },
      liabilities: { total_payable, total_liabilities: total_payable },
      // Not a true equity figure: there is no capital / retained-earnings ledger, so this is assets minus liabilities.
      net_worth_estimate: total_assets - total_payable,
      equity: total_assets - total_payable,
      as_of: asOf || ymd(todayDate()),
      notes: 'Indicative only. Built from invoices, payments and expenses (no opening capital, fixed assets, loans or bank opening balances). Stock value uses current quantities at purchase price.',
    });
  } catch (err) {
    console.error('Balance sheet error:', err);
    res.status(500).json({ error: 'Failed to fetch balance sheet' });
  }
});

// ─── P3-4: GSTR-2 (Inward Supply) ─────────────────────────────────────────────
router.get('/gstr2', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const invoices = await prisma.invoice.findMany({
      where: { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] }, ...invoiceDateWhere(from, to, req.financialYear) },
      select: {
        id: true, invoice_number: true, invoice_date: true, voucher_type: true, subtotal: true, discount_amount: true,
        supplier: { select: { name: true, gstin: true, state: true } },
        items: { select: { amount: true, tax_amount: true, tax_rate: true, quantity: true, unit: true, product: { select: { hsn_code: true, name: true } } } },
      },
      orderBy: { invoice_date: 'asc' },
    });
    const b2bMap = {}, unregistered = {}, hsnMap = {};
    for (const r of gstLines(invoices, business?.state)) {
      const inv = r.inv;
      const gstin = inv.supplier?.gstin?.trim();
      if (gstin) {
        if (!b2bMap[gstin]) b2bMap[gstin] = { gstin, supplier_name: inv.supplier.name, invoices: new Set(), taxable: 0, tax: 0, igst: 0, cgst: 0, sgst: 0 };
        const b = b2bMap[gstin];
        b.invoices.add(inv.id); b.taxable += r.taxable; b.tax += r.tax; b.igst += r.igst; b.cgst += r.cgst; b.sgst += r.sgst;
      } else {
        if (!unregistered[inv.id]) unregistered[inv.id] = { invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, supplier_name: inv.supplier?.name || '—', taxable: 0, tax: 0 };
        unregistered[inv.id].taxable += r.taxable; unregistered[inv.id].tax += r.tax;
      }
      const hsn = r.item.product?.hsn_code || 'N/A';
      if (!hsnMap[hsn]) hsnMap[hsn] = { hsn_code: hsn, description: r.item.product?.name || '', uqc: r.item.unit, qty: 0, taxable_value: 0, total_tax: 0 };
      hsnMap[hsn].qty += r.sign * r.item.quantity; hsnMap[hsn].taxable_value += r.taxable; hsnMap[hsn].total_tax += r.tax;
    }
    res.json({
      b2b: Object.values(b2bMap).map(({ invoices: set, ...rest }) => ({ ...rest, invoice_count: set.size })),
      b2cs: Object.values(unregistered),
      hsn_summary: Object.values(hsnMap),
      period: { from: from || null, to: to || null },
    });
  } catch (err) {
    console.error('GSTR-2 error:', err);
    res.status(500).json({ error: 'Failed to fetch GSTR-2' });
  }
});

// ─── P3-5: GSTR-9 (Annual Return) ─────────────────────────────────────────────
router.get('/gstr9', async (req, res) => {
  const { financialYearId } = req.query;
  const businessId = req.user.businessId;
  const fyId = financialYearId || req.financialYear?.id;
  if (!fyId) return res.status(400).json({ error: 'financialYearId is required' });
  try {
    const fy = await prisma.financialYear.findFirst({ where: { id: fyId, business_id: businessId } });
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { state: true } });
    const where = { business_id: businessId, is_deleted: false, status: { notIn: ['draft', 'cancelled'] }, financial_year_id: fyId };
    const [sInv, pInv, expenseAgg] = await Promise.all([
      prisma.invoice.findMany({ where: { ...where, voucher_type: { in: ['SALE', 'SALE_RETURN'] } }, select: { voucher_type: true, subtotal: true, discount_amount: true, customer: { select: { state: true } }, items: true } }),
      prisma.invoice.findMany({ where: { ...where, voucher_type: { in: ['PURCHASE', 'PURCHASE_RETURN'] } }, select: { voucher_type: true, subtotal: true, discount_amount: true, supplier: { select: { state: true } }, items: true } }),
      prisma.expense.aggregate({ where: { business_id: businessId, is_deleted: false, financial_year_id: fyId }, _sum: { amount: true } }),
    ]);
    const s = gstLines(sInv, business?.state);
    const p = gstLines(pInv, business?.state);
    const output_tax = sumBy(s, 'tax');
    const input_credit = sumBy(p, 'tax');
    res.json({
      financial_year: { label: fy.label, start: fy.start_date, end: fy.end_date },
      table_4: { gross_sale_taxable: sumBy(s, 'taxable'), gross_sale_tax: output_tax },
      table_5: { gross_purchase_taxable: sumBy(p, 'taxable'), gross_purchase_tax: input_credit },
      table_6: { output_tax, input_credit, net_tax_payable: output_tax - input_credit },
      expenses_total: expenseAgg._sum.amount || 0,
      notes: 'Annual summary of taxable value and tax, net of returns. Table numbers are indicative and do not follow the official GSTR-9 layout.',
    });
  } catch (err) {
    console.error('GSTR-9 error:', err);
    res.status(500).json({ error: 'Failed to fetch GSTR-9' });
  }
});

// ─── P3-10: Sale Orders Report ─────────────────────────────────────────────────
router.get('/sale-orders', async (req, res) => {
  const { from, to } = req.query;
  const businessId = req.user.businessId;
  try {
    const estimates = await prisma.invoice.findMany({
      where: { business_id: businessId, voucher_type: 'ESTIMATE', is_deleted: false, ...invoiceDateWhere(from, to, req.financialYear) },
      include: { customer: { select: { name: true, phone: true } } },
      orderBy: { invoice_date: 'desc' },
    });
    const rows = estimates.map((e) => ({
      id: e.id, invoice_number: e.invoice_number, invoice_date: e.invoice_date,
      customer_name: e.customer?.name || '—', customer_phone: e.customer?.phone || '',
      status: e.status, valid_until: e.valid_until, total: e.total_amount,
    }));
    const byStatus = { draft: 0, sent: 0, converted: 0, cancelled: 0, expired: 0 };
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const total_value = rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.total, 0);
    const converted_value = rows.filter((r) => r.status === 'converted').reduce((s, r) => s + r.total, 0);
    res.json({ estimates: rows, by_status: byStatus, total_value, converted_value, conversion_rate: rows.length ? (byStatus.converted / rows.length) * 100 : 0 });
  } catch (err) {
    console.error('Sale orders error:', err);
    res.status(500).json({ error: 'Failed to fetch sale orders' });
  }
});

module.exports = router;
