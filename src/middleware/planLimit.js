const prisma = require('../utils/prisma');

const PLAN_LIMITS = {
  free: { invoicesPerMonth: 50 },
  starter: { invoicesPerMonth: Infinity },
  pro: { invoicesPerMonth: Infinity },
};

// Returns active subscription plan for the business, defaulting to 'free'
async function getActivePlan(businessId) {
  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub || sub.status !== 'active') return 'free';
  // Check expiry for paid plans
  if (sub.plan !== 'free' && sub.expires_at && sub.expires_at < new Date()) {
    // Mark expired
    await prisma.subscription.update({
      where: { business_id: businessId },
      data: { status: 'expired' },
    });
    return 'free';
  }
  return sub.plan;
}

// Middleware: block invoice creation if free plan monthly limit reached
async function checkInvoiceLimit(req, res, next) {
  try {
    const plan = await getActivePlan(req.user.businessId);
    const limit = PLAN_LIMITS[plan]?.invoicesPerMonth ?? 50;
    if (limit === Infinity) return next();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const count = await prisma.invoice.count({
      where: {
        business_id: req.user.businessId,
        is_deleted: false,
        status: { not: 'cancelled' },
        created_at: { gte: monthStart, lt: monthEnd },
      },
    });

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
    next(); // fail open — don't block billing on middleware error
  }
}

module.exports = { checkInvoiceLimit, getActivePlan };
