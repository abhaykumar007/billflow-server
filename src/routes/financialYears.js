const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Helper: build label and date range from a year like 2025 (meaning FY 2025-26)
function buildFYData(startYear) {
  const start = new Date(startYear, 3, 1);   // April 1
  const end   = new Date(startYear + 1, 2, 31, 23, 59, 59, 999); // March 31
  const shortEnd = String(startYear + 1).slice(2);
  const label = `FY ${startYear}-${shortEnd}`;
  return { label, start_date: start, end_date: end };
}

/**
 * Shared carry-forward helper.
 * Copies the last ledger balance for every customer and supplier from any prior FY
 * into newFyId as an opening entry dated at newFy.start_date.
 * Uses deterministic findFirst-per-entity instead of the fragile distinct+orderBy pattern.
 */
async function runCarryForward(tx, businessId, oldFy, newFyId, newFy) {
  const entryDate = new Date(newFy.start_date);

  // ── Customer carry-forward ───────────────────────────────────────────────
  // Step 1: get distinct customer IDs that have entries outside the new FY
  const customerIdRows = await tx.ledgerEntry.findMany({
    where: { business_id: businessId, financial_year_id: { not: newFyId } },
    select: { customer_id: true },
    distinct: ['customer_id'],
  });

  // Step 2: for each customer fetch their most recent entry with a stable sort
  const customerLastEntries = await Promise.all(
    customerIdRows.map(({ customer_id }) =>
      tx.ledgerEntry.findFirst({
        where: {
          business_id: businessId,
          customer_id,
          financial_year_id: { not: newFyId },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      })
    )
  );

  // ── Supplier carry-forward ───────────────────────────────────────────────
  const supplierIdRows = await tx.supplierLedgerEntry.findMany({
    where: { business_id: businessId, financial_year_id: { not: newFyId } },
    select: { supplier_id: true },
    distinct: ['supplier_id'],
  });

  const supplierLastEntries = await Promise.all(
    supplierIdRows.map(({ supplier_id }) =>
      tx.supplierLedgerEntry.findFirst({
        where: {
          business_id: businessId,
          supplier_id,
          financial_year_id: { not: newFyId },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      })
    )
  );

  // Build DB operations for all non-zero balances
  const ops = [];

  for (const entry of customerLastEntries) {
    if (!entry || entry.balance === 0) continue;
    const bal = entry.balance;
    ops.push(
      tx.ledgerEntry.create({
        data: {
          business_id: businessId,
          financial_year_id: newFyId,
          customer_id: entry.customer_id,
          entry_type: 'carry_forward',
          reference_type: 'carry_forward',
          reference_id: oldFy.id,
          debit: bal > 0 ? bal : 0,
          credit: bal < 0 ? -bal : 0,
          balance: bal,
          narration: `Balance carried forward from ${oldFy.label}`,
          entry_date: entryDate,
        },
      })
    );
  }

  for (const entry of supplierLastEntries) {
    if (!entry || entry.balance === 0) continue;
    const bal = entry.balance;
    ops.push(
      tx.supplierLedgerEntry.create({
        data: {
          business_id: businessId,
          financial_year_id: newFyId,
          supplier_id: entry.supplier_id,
          entry_type: 'carry_forward',
          reference_type: 'carry_forward',
          reference_id: oldFy.id,
          debit: bal < 0 ? -bal : 0,
          credit: bal > 0 ? bal : 0,
          balance: bal,
          narration: `Balance carried forward from ${oldFy.label}`,
          entry_date: entryDate,
        },
      })
    );
  }

  if (ops.length > 0) {
    await Promise.all(ops);
  }
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

// GET /api/financial-years/close/checklist — pending items before closing
router.get('/close/checklist', async (req, res) => {
  try {
    const businessId = req.user.businessId;

    const activeFy = await prisma.financialYear.findFirst({
      where: { business_id: businessId, is_active: true },
    });
    if (!activeFy) return res.status(404).json({ error: 'No active financial year found' });

    const [unpaidInvoices, unsettledPurchases, openAdvances, openEstimates] = await Promise.all([
      // Unpaid/partial SALE invoices
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          financial_year_id: activeFy.id,
          voucher_type: 'SALE',
          status: { in: ['sent', 'partial'] },
          is_deleted: false,
        },
        _count: { id: true },
        _sum: { balance_due: true },
      }),
      // Unsettled PURCHASE bills
      prisma.invoice.aggregate({
        where: {
          business_id: businessId,
          financial_year_id: activeFy.id,
          voucher_type: 'PURCHASE',
          status: { in: ['sent', 'partial'] },
          is_deleted: false,
        },
        _count: { id: true },
        _sum: { balance_due: true },
      }),
      // Open advance payments (not yet applied)
      prisma.payment.aggregate({
        where: {
          business_id: businessId,
          financial_year_id: activeFy.id,
          advance_payment: true,
          advance_balance_remaining: { gt: 0 },
          is_reversed: false,
        },
        _count: { id: true },
        _sum: { advance_balance_remaining: true },
      }),
      // Open estimates (not converted, not cancelled, not expired)
      prisma.invoice.count({
        where: {
          business_id: businessId,
          financial_year_id: activeFy.id,
          voucher_type: 'ESTIMATE',
          status: { notIn: ['converted', 'cancelled'] },
          is_deleted: false,
        },
      }),
    ]);

    return res.json({
      financial_year: { id: activeFy.id, label: activeFy.label },
      unpaid_invoices: {
        count: unpaidInvoices._count.id || 0,
        total_outstanding: unpaidInvoices._sum.balance_due || 0,
      },
      unsettled_purchase_bills: {
        count: unsettledPurchases._count.id || 0,
        total_payable: unsettledPurchases._sum.balance_due || 0,
      },
      open_advances: {
        count: openAdvances._count.id || 0,
        total_amount: openAdvances._sum.advance_balance_remaining || 0,
      },
      open_estimates: {
        count: openEstimates,
      },
    });
  } catch (err) {
    console.error('FY checklist error:', err);
    return res.status(500).json({ error: 'Failed to fetch checklist' });
  }
});

// PUT /api/financial-years/:id/activate — switch active financial year + carry-forward
router.put('/:id/activate', async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    const newFy = await prisma.financialYear.findFirst({
      where: { id, business_id: businessId },
    });
    if (!newFy) return res.status(404).json({ error: 'Financial year not found' });

    // Find the currently active FY before switching
    const oldFy = await prisma.financialYear.findFirst({
      where: { business_id: businessId, is_active: true },
    });

    // Deactivate all, then activate the selected one
    await prisma.$transaction([
      prisma.financialYear.updateMany({
        where: { business_id: businessId },
        data: { is_active: false },
      }),
      prisma.financialYear.update({
        where: { id },
        data: { is_active: true },
      }),
    ]);

    // Carry-forward: only if switching to a different FY
    if (oldFy && oldFy.id !== id) {
      const alreadyDone = await prisma.ledgerEntry.findFirst({
        where: { business_id: businessId, financial_year_id: id, reference_type: 'carry_forward' },
      });
      if (!alreadyDone) {
        await prisma.$transaction((tx) => runCarryForward(tx, businessId, oldFy, id, newFy));
      }
    }

    const updated = await prisma.financialYear.findUnique({ where: { id } });
    return res.json({ ...updated, carry_forward_done: !!(oldFy && oldFy.id !== id) });
  } catch (err) {
    console.error('FY activate error:', err);
    return res.status(500).json({ error: 'Failed to activate financial year' });
  }
});

// POST /api/financial-years/:id/close — close the active financial year
// Body: { force: true } to close despite pending items
router.post('/:id/close', async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;
  const force = req.body?.force === true;

  try {
    const fy = await prisma.financialYear.findFirst({
      where: { id, business_id: businessId },
    });
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });
    if (!fy.is_active) return res.status(400).json({ error: 'Only the active financial year can be closed' });
    if (fy.is_closed) return res.status(400).json({ error: 'Financial year is already closed' });

    // If not forcing, check for pending items
    if (!force) {
      const [unpaidCount, openAdvances, openEstimates] = await Promise.all([
        prisma.invoice.count({
          where: {
            business_id: businessId,
            financial_year_id: id,
            status: { in: ['sent', 'partial'] },
            voucher_type: { in: ['SALE', 'PURCHASE'] },
            is_deleted: false,
          },
        }),
        prisma.payment.count({
          where: {
            business_id: businessId,
            financial_year_id: id,
            advance_payment: true,
            advance_balance_remaining: { gt: 0 },
            is_reversed: false,
          },
        }),
        prisma.invoice.count({
          where: {
            business_id: businessId,
            financial_year_id: id,
            voucher_type: 'ESTIMATE',
            status: { notIn: ['converted', 'cancelled'] },
            is_deleted: false,
          },
        }),
      ]);

      const hasPending = unpaidCount > 0 || openAdvances > 0 || openEstimates > 0;
      if (hasPending) {
        return res.status(409).json({
          error: 'There are pending items. Pass { force: true } to close anyway.',
          code: 'PENDING_ITEMS',
          pending: { unpaid_invoices: unpaidCount, open_advances: openAdvances, open_estimates: openEstimates },
        });
      }
    }

    // Determine the next FY label and dates
    const currentStartYear = fy.start_date.getFullYear();
    const nextStartYear = currentStartYear + 1;
    const { label: newLabel, start_date: newStart, end_date: newEnd } = buildFYData(nextStartYear);

    // All steps in one transaction
    const newFy = await prisma.$transaction(async (tx) => {
      // 1. Mark current FY as closed + locked
      await tx.financialYear.update({
        where: { id },
        data: {
          is_closed: true,
          is_locked: true,
          closed_at: new Date(),
          closed_by_id: req.user.userId,
          is_active: false,
        },
      });

      // 2. Create or find the next FY
      let nextFy = await tx.financialYear.findFirst({
        where: { business_id: businessId, label: newLabel },
      });
      if (!nextFy) {
        nextFy = await tx.financialYear.create({
          data: {
            business_id: businessId,
            label: newLabel,
            start_date: newStart,
            end_date: newEnd,
            is_active: true,
          },
        });
      } else {
        await tx.financialYear.update({
          where: { id: nextFy.id },
          data: { is_active: true },
        });
      }

      // 3. Run carry-forward (idempotent check inside)
      const alreadyDone = await tx.ledgerEntry.findFirst({
        where: { business_id: businessId, financial_year_id: nextFy.id, reference_type: 'carry_forward' },
      });
      if (!alreadyDone) {
        await runCarryForward(tx, businessId, fy, nextFy.id, nextFy);
      }

      // 4. Stock snapshot — capture current stock into new FY's opening_stock_snapshot (S1-G)
      const products = await tx.product.findMany({
        where: { business_id: businessId, is_active: true, is_deleted: false },
        select: { id: true, stock_quantity: true },
      });
      const stockSnapshot = {};
      products.forEach((p) => { stockSnapshot[p.id] = p.stock_quantity; });

      await tx.financialYear.update({
        where: { id: nextFy.id },
        data: { opening_stock_snapshot: stockSnapshot },
      });

      return nextFy;
    });

    return res.json({ success: true, new_financial_year_id: newFy.id, new_financial_year_label: newFy.label });
  } catch (err) {
    console.error('FY close error:', err);
    return res.status(500).json({ error: 'Failed to close financial year' });
  }
});

// PUT /api/financial-years/:id/lock — toggle lock/unlock
router.put('/:id/lock', async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    const fy = await prisma.financialYear.findFirst({
      where: { id, business_id: businessId },
    });
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    // Toggle: if locked → unlock, if unlocked → lock
    const updated = await prisma.financialYear.update({
      where: { id },
      data: { is_locked: !fy.is_locked },
    });

    return res.json(updated);
  } catch (err) {
    console.error('FY lock toggle error:', err);
    return res.status(500).json({ error: 'Failed to update financial year lock' });
  }
});

module.exports = router;
