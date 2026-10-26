const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');
const { todayDate, monthStartDate, DAY_MS } = require('../utils/time');

router.use(authenticateToken);

// GET /api/dashboard/summary
router.get('/summary', attachFinancialYear, async (req, res) => {
  try {
    const businessId = req.user.businessId;
    // "Today" / "this month" are IST calendar dates (the server clock is UTC).
    const todayStart = todayDate();
    const todayEnd = new Date(todayStart.getTime() + DAY_MS);
    const monthStart = monthStartDate();

    // Money owed to / by us is NOT limited to the selected year: an unpaid invoice from last
    // year is still owed. Only date-bound figures use dates.
    const openSale = { business_id: businessId, voucher_type: 'SALE', status: { in: ['sent', 'partial'] }, is_deleted: false };
    const openPurchase = { business_id: businessId, voucher_type: 'PURCHASE', status: { in: ['sent', 'partial'] }, is_deleted: false };
    const fyFilter = req.financialYear ? { financial_year_id: req.financialYear.id } : {};

    // Run all queries in parallel
    const [
      todaySalesResult,
      todayPurchasesResult,
      invoicesTodayCount,
      outstandingResult,
      totalPayableResult,
      monthCollectedResult,
      openEstimatesCount,
      recentInvoices,
      topCustomers,
      topSuppliers,
      overdueResult,
      lowStockRows,
    ] = await Promise.all([
      // Today's sales total (SALE invoices created today)
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          voucher_type: 'SALE',
          status: { in: ['sent', 'paid', 'partial'] },
          invoice_date: { gte: todayStart, lt: todayEnd },
          is_deleted: false,
        },
        _sum: { total_amount: true },
      }),

      // Today's purchases total (PURCHASE invoices created today)
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          voucher_type: 'PURCHASE',
          status: { in: ['sent', 'paid', 'partial'] },
          invoice_date: { gte: todayStart, lt: todayEnd },
          is_deleted: false,
        },
        _sum: { total_amount: true },
      }),

      // Count of invoices today (sales only)
      prisma.invoice.count({
        where: {
          business_id: businessId,
          voucher_type: 'SALE',
          invoice_date: { gte: todayStart, lt: todayEnd },
          status: { not: 'cancelled' },
          is_deleted: false,
        },
      }),

      // Total outstanding receivable (SALE balance due)
      prisma.invoice.aggregate({
        where: openSale,
        _sum: { balance_due: true },
      }),

      // Total payable to suppliers (PURCHASE balance due)
      prisma.invoice.aggregate({
        where: openPurchase,
        _sum: { balance_due: true },
      }),

      // Total received this month (customer payments)
      prisma.payment.aggregate({
        where: {
          business_id: businessId,
          party_type: 'CUSTOMER',
          payment_type: 'RECEIVED', // refunds paid out for credit notes are not collections
          payment_date: { gte: monthStart },
          is_reversed: false,
        },
        _sum: { amount: true },
      }),

      // Open estimates count
      prisma.invoice.count({
        where: {
          business_id: businessId,
          ...fyFilter,
          voucher_type: 'ESTIMATE',
          status: { in: ['draft', 'sent'] },
          is_deleted: false,
        },
      }),

      // Recent invoices (excluding estimates)
      prisma.invoice.findMany({
        where: { business_id: businessId, ...fyFilter, is_deleted: false, voucher_type: { not: 'ESTIMATE' } },
        orderBy: { created_at: 'desc' },
        take: 8,
        select: {
          id: true,
          invoice_number: true,
          invoice_date: true,
          voucher_type: true,
          status: true,
          total_amount: true,
          balance_due: true,
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
        },
      }),

      // Top 5 customers by outstanding balance
      prisma.invoice.groupBy({
        by: ['customer_id'],
        where: openSale,
        _sum: { balance_due: true },
        orderBy: { _sum: { balance_due: 'desc' } },
        take: 5,
      }),

      // Top 5 suppliers by outstanding payable
      prisma.invoice.groupBy({
        by: ['supplier_id'],
        where: openPurchase,
        _sum: { balance_due: true },
        orderBy: { _sum: { balance_due: 'desc' } },
        take: 5,
      }),

      // Overdue receivables (due date before today)
      prisma.invoice.aggregate({
        where: { ...openSale, due_date: { lt: todayStart } },
        _count: { id: true },
        _sum: { balance_due: true },
      }),

      // Low-stock products
      prisma.product.findMany({
        where: { business_id: businessId, is_deleted: false, is_active: true, track_inventory: true },
        select: { stock_quantity: true, low_stock_alert: true },
      }),
    ]);

    // Enrich top customers and suppliers with names in parallel
    const customerIds = topCustomers.map((c) => c.customer_id).filter(Boolean);
    const supplierIds = topSuppliers.map((s) => s.supplier_id).filter(Boolean);

    const [customers, suppliers] = await Promise.all([
      customerIds.length
        ? prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true } })
        : [],
      supplierIds.length
        ? prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, phone: true } })
        : [],
    ]);

    const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));
    const supplierMap = Object.fromEntries(suppliers.map((s) => [s.id, s]));

    const enrichedTopCustomers = topCustomers.map((tc) => ({
      customer: customerMap[tc.customer_id] || { id: tc.customer_id, name: 'Unknown' },
      outstanding: tc._sum.balance_due || 0,
    }));

    const enrichedTopSuppliers = topSuppliers.map((ts) => ({
      supplier: supplierMap[ts.supplier_id] || { id: ts.supplier_id, name: 'Unknown' },
      payable: ts._sum.balance_due || 0,
    }));

    return res.json({
      todaySales: todaySalesResult._sum.total_amount || 0,
      todayPurchases: todayPurchasesResult._sum.total_amount || 0,
      invoicesToday: invoicesTodayCount,
      totalOutstanding: outstandingResult._sum.balance_due || 0,
      totalPayable: totalPayableResult._sum.balance_due || 0,
      monthCollected: monthCollectedResult._sum.amount || 0,
      openEstimates: openEstimatesCount,
      overdueCount: overdueResult._count.id || 0,
      overdueAmount: overdueResult._sum.balance_due || 0,
      lowStockCount: lowStockRows.filter((p) => p.stock_quantity <= p.low_stock_alert).length,
      recentInvoices,
      topCustomers: enrichedTopCustomers,
      topSuppliers: enrichedTopSuppliers,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
