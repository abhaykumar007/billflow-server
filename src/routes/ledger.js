const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/ledger — ledger entries, optionally filtered by customer
router.get('/', async (req, res) => {
  const { customer_id, from, to, limit = 50, offset = 0 } = req.query;
  const businessId = req.user.businessId;

  const where = { business_id: businessId };
  if (customer_id) where.customer_id = customer_id;
  if (from || to) {
    where.entry_date = {};
    if (from) where.entry_date.gte = new Date(from);
    if (to) where.entry_date.lte = new Date(to + 'T23:59:59');
  }

  try {
    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
        },
        orderBy: [{ entry_date: 'desc' }, { created_at: 'desc' }],
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    return res.json({ entries, total });
  } catch (err) {
    console.error('Ledger error:', err);
    return res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

module.exports = router;
