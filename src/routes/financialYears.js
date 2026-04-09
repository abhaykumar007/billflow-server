const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Helper: build label and date range from a year like 2025 (meaning FY 2025-26)
function buildFYData(startYear) {
  const start = new Date(startYear, 3, 1);   // April 1
  const end   = new Date(startYear + 1, 2, 31, 23, 59, 59, 999); // March 31
  const shortStart = String(startYear).slice(2);
  const shortEnd   = String(startYear + 1).slice(2);
  const label = `FY ${startYear}-${shortEnd}`;
  return { label, start_date: start, end_date: end };
}

// GET /api/financial-years — list all for this business
router.get('/', async (req, res) => {
  try {
    const years = await prisma.financialYear.findMany({
      where: { business_id: req.user.businessId },
      orderBy: { start_date: 'desc' },
    });
    return res.json(years);
  } catch (err) {
    console.error('FY list error:', err);
    return res.status(500).json({ error: 'Failed to fetch financial years' });
  }
});

// POST /api/financial-years — create a financial year
// Body: { start_year: 2025 }  → creates FY 2025-26
router.post('/', async (req, res) => {
  const { start_year } = req.body;

  if (!start_year || isNaN(start_year)) {
    return res.status(400).json({ error: 'start_year is required (e.g. 2025 for FY 2025-26)' });
  }

  const yr = parseInt(start_year, 10);
  const { label, start_date, end_date } = buildFYData(yr);

  try {
    const existing = await prisma.financialYear.findFirst({
      where: { business_id: req.user.businessId, label },
    });
    if (existing) {
      return res.status(409).json({ error: `${label} already exists` });
    }

    const fy = await prisma.financialYear.create({
      data: {
        business_id: req.user.businessId,
        label,
        start_date,
        end_date,
        is_active: false,
      },
    });
    return res.status(201).json(fy);
  } catch (err) {
    console.error('FY create error:', err);
    return res.status(500).json({ error: 'Failed to create financial year' });
  }
});

// PUT /api/financial-years/:id/activate — switch active financial year
router.put('/:id/activate', async (req, res) => {
  const { id } = req.params;

  try {
    const fy = await prisma.financialYear.findFirst({
      where: { id, business_id: req.user.businessId },
    });
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    // Deactivate all, then activate the selected one — in a transaction
    await prisma.$transaction([
      prisma.financialYear.updateMany({
        where: { business_id: req.user.businessId },
        data: { is_active: false },
      }),
      prisma.financialYear.update({
        where: { id },
        data: { is_active: true },
      }),
    ]);

    const updated = await prisma.financialYear.findUnique({ where: { id } });
    return res.json(updated);
  } catch (err) {
    console.error('FY activate error:', err);
    return res.status(500).json({ error: 'Failed to activate financial year' });
  }
});

module.exports = router;
