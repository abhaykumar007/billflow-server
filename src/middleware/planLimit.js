const prisma = require('../utils/prisma');
const { istMonthStart } = require('../utils/time');

const PLAN_LIMITS = {
  free:    { invoicesPerMonth: 50,       users: 1 },
  starter: { invoicesPerMonth: Infinity, users: 2 },
  pro:     { invoicesPerMonth: Infinity, users: 10 },
};

// Returns the plan currently in force for the business, defaulting to 'free'.
// A cancelled subscription keeps its plan until expires_at (as promised to the user).
async function getActivePlan(businessId) {
  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub || sub.plan === 'free') return 'free';
  if (sub.status === 'expired') return 'free';
  if (sub.expires_at && sub.expires_at < new Date()) {
    await prisma.subscription.update({
      where: { business_id: businessId },
      data: { status: 'expired' },
    });
    return 'free';
  }
  return PLAN_LIMITS[sub.plan] ? sub.plan : 'free';
}

// Sale invoices created this (IST) month. Estimates, returns and purchase bills do not count.
async function countInvoicesThisMonth(businessId) {
  const monthStart = istMonthStart();
  return prisma.invoice.count({
    where: {
      business_id: businessId,
      is_deleted: false,
      voucher_type: 'SALE',
      status: { not: 'cancelled' },
      created_at: { gte: monthStart },
    },
  });
}

// Middleware: block SALE invoice creation if the free plan monthly limit is reached
async function checkInvoiceLimit(req, res, next) {
  try {
    if ((req.body?.voucher_type || 'SALE') !== 'SALE') return next();

    const plan = await getActivePlan(req.user.businessId);
    const limit = PLAN_LIMITS[plan]?.invoicesPerMonth ?? 50;
    if (limit === Infinity) return next();

    const count = await countInvoicesThisMonth(req.user.businessId);
    if (count >= limit) {
      return res.status(403).json({
        error: `Free plan allows ${limit} invoices per month. Upgrade to create more.`,
        code: 'PLAN_LIMIT_REACHED',
        limit,
        used: count,
      });
    }
    next();
  } catch (err) {
    console.error('planLimit error:', err);
    next(); // fail open: never block billing because the limiter itself broke
  }
}

module.exports = { checkInvoiceLimit, getActivePlan, countInvoicesThisMonth, PLAN_LIMITS };
