const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/dashboard/summary
router.get('/summary', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const now = new Date();

    // Today: midnight to now
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // This month: 1st of month to now
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Run all queries in parallel
    const [
      todaySalesResult,
      invoicesTodayCount,
      outstandingResult,
      monthCollectedResult,
      recentInvoices,
      topCustomers,
    ] = await Promise.all([
      // Today's sales total (finalized invoices created today)
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          status: { in: ['sent', 'paid', 'partial'] },
          invoice_date: { gte: todayStart, lt: todayEnd },
          is_deleted: false,
        },
        _sum: { total_amount: true },
      }),

      // Count of invoices today
      prisma.invoice.count({
        where: {
          business_id: businessId,
          invoice_date: { gte: todayStart, lt: todayEnd },
          status: { not: 'cancelled' },
          is_deleted: false,
        },
      }),

      // Total outstanding (balance_due across all unpaid invoices)
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          status: { in: ['sent', 'partial'] },
          is_deleted: false,
        },
        _sum: { balance_due: true },
      }),

      // Total received this month (payments)
      prisma.payment.aggregate({
        where: {
          business_id: businessId,
          payment_date: { gte: monthStart },
          is_reversed: false,
        },
        _sum: { amount: true },
      }),

      // Recent 5 invoices
      prisma.invoice.findMany({
        where: { business_id: businessId, is_deleted: false },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: {
          id: true,
          invoice_number: true,
          invoice_date: true,
          status: true,
          total_amount: true,
          balance_due: true,
          customer: { select: { name: true } },
        },
      }),

      // Top 5 customers by outstanding balance
      prisma.invoice.groupBy({
        by: ['customer_id'],
        where: {
          business_id: businessId,
          status: { in: ['sent', 'partial'] },
          is_deleted: false,
        },
        _sum: { balance_due: true },
        orderBy: { _sum: { balance_due: 'desc' } },
        take: 5,
      }),
    ]);

    // Enrich top customers with names
    const customerIds = topCustomers.map((c) => c.customer_id);
    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, name: true, phone: true },
    });
    const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));

    const enrichedTopCustomers = topCustomers.map((tc) => ({
      customer: customerMap[tc.customer_id] || { id: tc.customer_id, name: 'Unknown' },
      outstanding: tc._sum.balance_due || 0,
    }));

    return res.json({
      todaySales: todaySalesResult._sum.total_amount || 0,
      invoicesToday: invoicesTodayCount,
      totalOutstanding: outstandingResult._sum.balance_due || 0,
      monthCollected: monthCollectedResult._sum.amount || 0,
      recentInvoices,
      topCustomers: enrichedTopCustomers,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
