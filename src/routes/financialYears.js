const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { lockRow } = require('../utils/lock');

router.use(authenticateToken);

// Helper: build label and date range from a year like 2025 (meaning FY 2025-26).
// Explicit UTC so the result does not depend on the server's timezone.
function buildFYData(startYear) {
  const start = new Date(Date.UTC(startYear, 3, 1));                          // April 1
  const end   = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999));    // March 31
  const shortEnd = String(startYear + 1).slice(2);
  const label = `FY ${startYear}-${shortEnd}`;
  return { label, start_date: start, end_date: end };
}

/**
 * Carry-forward: closing balance of prevFy -> opening entry in curFy.
 *
 * The closing balance is the SUM of everything posted in prevFy (which already
 * includes prevFy's own carry-forward), so balances chain correctly across any
 * number of years and do not depend on entry ordering. Idempotent per party:
 * a customer/supplier that already has a carry-forward entry in curFy is skipped.
 */
async function carryForwardInto(tx, businessId, prevFy, curFy) {
  const entryDate = new Date(curFy.start_date);

  const [custTotals, suppTotals, custDone, suppDone] = await Promise.all([
    tx.ledgerEntry.groupBy({
      by: ['customer_id'],
      where: { business_id: businessId, financial_year_id: prevFy.id },
      _sum: { debit: true, credit: true },
    }),
    tx.supplierLedgerEntry.groupBy({
      by: ['supplier_id'],
      where: { business_id: businessId, financial_year_id: prevFy.id },
      _sum: { debit: true, credit: true },
    }),
    tx.ledgerEntry.findMany({
      where: { business_id: businessId, financial_year_id: curFy.id, entry_type: 'carry_forward' },
      select: { customer_id: true },
    }),
    tx.supplierLedgerEntry.findMany({
      where: { business_id: businessId, financial_year_id: curFy.id, entry_type: 'carry_forward' },
      select: { supplier_id: true },
    }),
  ]);
  const custSkip = new Set(custDone.map((r) => r.customer_id));
  const suppSkip = new Set(suppDone.map((r) => r.supplier_id));

  const custRows = [];
  for (const t of custTotals) {
    if (custSkip.has(t.customer_id)) continue;
    const bal = (t._sum.debit || 0) - (t._sum.credit || 0); // + = customer owes us
    if (bal === 0) continue;
    custRows.push({
      business_id: businessId, financial_year_id: curFy.id, customer_id: t.customer_id,
      entry_type: 'carry_forward', reference_type: 'carry_forward', reference_id: prevFy.id,
      debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0, balance: bal,
      narration: `Balance carried forward from ${prevFy.label}`, entry_date: entryDate,
    });
  }

  const suppRows = [];
  for (const t of suppTotals) {
    if (suppSkip.has(t.supplier_id)) continue;
    const bal = (t._sum.credit || 0) - (t._sum.debit || 0); // + = we owe supplier
    if (bal === 0) continue;
    suppRows.push({
      business_id: businessId, financial_year_id: curFy.id, supplier_id: t.supplier_id,
      entry_type: 'carry_forward', reference_type: 'carry_forward', reference_id: prevFy.id,
      debit: bal < 0 ? -bal : 0, credit: bal > 0 ? bal : 0, balance: bal,
      narration: `Balance carried forward from ${prevFy.label}`, entry_date: entryDate,
    });
  }

  if (custRows.length) await tx.ledgerEntry.createMany({ data: custRows });
  if (suppRows.length) await tx.supplierLedgerEntry.createMany({ data: suppRows });
}

// Carries balances through every year between the first one and `targetFy`
// (a year skipped over still gets its chain link, so nothing is lost).
async function ensureCarryForwardChain(tx, businessId, targetFy) {
  const years = await tx.financialYear.findMany({
    where: { business_id: businessId, start_date: { lte: targetFy.start_date } },
    orderBy: { start_date: 'asc' },
  });
  for (let i = 1; i < years.length; i++) {
    await carryForwardInto(tx, businessId, years[i - 1], years[i]);
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
router.post('/', requireRole(...MANAGERS), async (req, res) => {
  const { start_year } = req.body;

  const yr = parseInt(start_year, 10);
  if (!Number.isInteger(yr) || yr < 2000 || yr > 2100) {
    return res.status(400).json({ error: 'start_year must be a year between 2000 and 2100 (e.g. 2025 for FY 2025-26)' });
  }
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

// PUT /api/financial-years/:id/activate - make this the business's CURRENT year (new entries default to it).
// Only moves forward: to just LOOK at an older year, send the X-Financial-Year-Id header instead.
router.put('/:id/activate', requireRole(...MANAGERS), async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    const newFy = await prisma.financialYear.findFirst({ where: { id, business_id: businessId } });
    if (!newFy) return res.status(404).json({ error: 'Financial year not found' });
    if (newFy.is_closed) {
      return res.status(400).json({ error: 'A closed financial year cannot be made current.', code: 'FY_CLOSED' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'financialYear', id);
      const oldFy = await tx.financialYear.findFirst({ where: { business_id: businessId, is_active: true } });
      if (oldFy && oldFy.id !== id && oldFy.start_date > newFy.start_date) {
        const err = new Error('Cannot make an earlier year current');
        err.status = 400;
        throw err;
      }

      // one transaction: switch + carry-forward either both happen or neither does
      await tx.financialYear.updateMany({ where: { business_id: businessId }, data: { is_active: false } });
      await tx.financialYear.update({ where: { id }, data: { is_active: true } });
      await ensureCarryForwardChain(tx, businessId, newFy);
      return { switched: !!oldFy && oldFy.id !== id };
    });

    const updated = await prisma.financialYear.findUnique({ where: { id } });
    return res.json({ ...updated, carry_forward_done: result.switched });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: 'To view an earlier year, select it as a view; it cannot be made the current year.', code: 'FY_BACKWARD' });
    }
    console.error('FY activate error:', err);
    return res.status(500).json({ error: 'Failed to activate financial year' });
  }
});

// POST /api/financial-years/:id/close — close the active financial year
// Body: { force: true } to close despite pending items
router.post('/:id/close', requireRole(...MANAGERS), async (req, res) => {
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
    const currentStartYear = fy.start_date.getUTCFullYear();
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

      // 3. Carry balances forward (chained + idempotent per party)
      await ensureCarryForwardChain(tx, businessId, nextFy);

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

// PUT /api/financial-years/:id/lock - lock or unlock. Body { locked: true|false } (toggles if omitted).
// A CLOSED year is permanently locked.
router.put('/:id/lock', requireRole(...MANAGERS), async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    const fy = await prisma.financialYear.findFirst({ where: { id, business_id: businessId } });
    if (!fy) return res.status(404).json({ error: 'Financial year not found' });

    const target = typeof req.body?.locked === 'boolean' ? req.body.locked : !fy.is_locked;
    if (fy.is_closed && !target) {
      return res.status(400).json({ error: 'A closed financial year cannot be unlocked.', code: 'FY_CLOSED' });
    }

    const updated = await prisma.financialYear.update({ where: { id }, data: { is_locked: target } });
    console.info(`[audit] FY ${fy.label} ${target ? 'locked' : 'unlocked'} by user ${req.user.userId}`);
    return res.json(updated);
  } catch (err) {
    console.error('FY lock toggle error:', err);
    return res.status(500).json({ error: 'Failed to update financial year lock' });
  }
});

module.exports = router;
