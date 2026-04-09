const prisma = require('../utils/prisma');

/**
 * Attaches the active financial year to req.financialYear.
 * Reads from:
 *   1. X-Financial-Year-Id header (explicit override from FY switcher)
 *   2. The business's currently active FY in DB
 *
 * If neither exists, req.financialYear is null — routes decide how to handle.
 */
async function attachFinancialYear(req, res, next) {
  try {
    const overrideId = req.headers['x-financial-year-id'];

    if (overrideId) {
      const fy = await prisma.financialYear.findFirst({
        where: { id: overrideId, business_id: req.user.businessId },
      });
      req.financialYear = fy || null;
    } else {
      const fy = await prisma.financialYear.findFirst({
        where: { business_id: req.user.businessId, is_active: true },
      });
      req.financialYear = fy || null;
    }

    next();
  } catch (err) {
    console.error('attachFinancialYear error:', err);
    next(); // non-fatal — route can handle missing FY
  }
}

module.exports = { attachFinancialYear };
