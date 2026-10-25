const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { HttpError } = require('../utils/httpError');
const { computeBalance, computeBalances } = require('../utils/bank');
const { parseDayStart, parseDayEnd } = require('../utils/time');
const { rupeesToPaise } = require('../utils/validate');

router.use(authenticateToken);

// GET /api/bank-accounts
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  const accounts = await prisma.bankAccount.findMany({
    where: { business_id: businessId, is_deleted: false },
    orderBy: { created_at: 'asc' },
  });
  const balances = await computeBalances(prisma, businessId, accounts.map((a) => a.id));
  return res.json(accounts.map((acc) => ({ ...acc, current_balance: balances.get(acc.id) ?? 0 })));
});

// POST /api/bank-accounts
router.post('/', requireRole(...MANAGERS), async (req, res) => {
  const { account_name, bank_name, account_number, ifsc_code, opening_balance } = req.body;
  const businessId = req.user.businessId;

  if (!account_name?.trim()) throw new HttpError(400, 'Account name is required', 'VALIDATION');
  const ifsc = ifsc_code?.trim().toUpperCase() || null;
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new HttpError(400, 'Enter a valid IFSC code', 'VALIDATION');
  const openingPaise = rupeesToPaise(opening_balance, 'opening balance');

  const account = await prisma.bankAccount.create({
    data: {
      business_id: businessId,
      account_name: account_name.trim(),
      bank_name: bank_name?.trim() || null,
      account_number: account_number?.trim() || null,
      ifsc_code: ifsc,
      opening_balance: openingPaise,
      current_balance: openingPaise,
    },
  });
  return res.status(201).json({ ...account, current_balance: openingPaise });
});

// PUT /api/bank-accounts/:id
router.put('/:id', requireRole(...MANAGERS), async (req, res) => {
  const { account_name, bank_name, account_number, ifsc_code, opening_balance, is_active } = req.body;
  const businessId = req.user.businessId;

  const existing = await prisma.bankAccount.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) throw new HttpError(404, 'Bank account not found', 'NOT_FOUND');

  const data = {};
  if (account_name !== undefined) {
    if (!account_name.trim()) throw new HttpError(400, 'Account name cannot be empty', 'VALIDATION');
    data.account_name = account_name.trim();
  }
  if (bank_name !== undefined) data.bank_name = bank_name?.trim() || null;
  if (account_number !== undefined) data.account_number = account_number?.trim() || null;
  if (ifsc_code !== undefined) {
    const ifsc = ifsc_code?.trim().toUpperCase() || null;
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new HttpError(400, 'Enter a valid IFSC code', 'VALIDATION');
    data.ifsc_code = ifsc;
  }
  if (opening_balance !== undefined) {
    data.opening_balance = rupeesToPaise(opening_balance, 'opening balance');
    data.current_balance = data.opening_balance;
  }
  if (is_active !== undefined) data.is_active = Boolean(is_active);

  const account = await prisma.bankAccount.update({ where: { id: req.params.id }, data });
  const current_balance = await computeBalance(prisma, account.id, businessId);
  return res.json({ ...account, current_balance });
});

// DELETE /api/bank-accounts/:id - only an empty account (zero balance) can be removed
router.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  const businessId = req.user.businessId;
  const existing = await prisma.bankAccount.findFirst({
    where: { id: req.params.id, business_id: businessId, is_deleted: false },
  });
  if (!existing) throw new HttpError(404, 'Bank account not found', 'NOT_FOUND');

  const balance = await computeBalance(prisma, existing.id, businessId);
  if (balance !== 0) {
    throw new HttpError(409, `This account still has a balance of ₹${(balance / 100).toFixed(2)}. Transfer it out first.`, 'NON_ZERO_BALANCE');
  }
  await prisma.bankAccount.update({ where: { id: req.params.id }, data: { is_deleted: true } });
  return res.json({ message: 'Bank account deleted' });
});

// GET /api/bank-accounts/:id/transactions
// Returns a merged, chronological list of payments + expenses + fund-transfers for this account
router.get('/:id/transactions', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;

  try {
    const account = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, business_id: businessId },
    });
    if (!account) return res.status(404).json({ error: 'Bank account not found' });

    const dateFilter = {};
    if (from) dateFilter.gte = parseDayStart(from);
    if (to) dateFilter.lte = parseDayEnd(to);

    const [payments, expenses, transfersFrom, transfersTo] = await Promise.all([
      prisma.payment.findMany({
        where: {
          bank_account_id: req.params.id,
          business_id: businessId,
          is_reversed: false,
          ...(Object.keys(dateFilter).length && { payment_date: dateFilter }),
        },
        include: {
          customer: { select: { name: true } },
          supplier: { select: { name: true } },
          invoice: { select: { invoice_number: true } },
        },
        orderBy: { payment_date: 'desc' },
      }),
      prisma.expense.findMany({
        where: {
          bank_account_id: req.params.id,
          business_id: businessId,
          is_deleted: false,
          ...(Object.keys(dateFilter).length && { expense_date: dateFilter }),
        },
        orderBy: { expense_date: 'desc' },
      }),
      prisma.fundTransfer.findMany({
        where: {
          from_account_id: req.params.id,
          business_id: businessId,
          ...(Object.keys(dateFilter).length && { transfer_date: dateFilter }),
        },
        include: { to_account: { select: { account_name: true } } },
        orderBy: { transfer_date: 'desc' },
      }),
      prisma.fundTransfer.findMany({
        where: {
          to_account_id: req.params.id,
          business_id: businessId,
          ...(Object.keys(dateFilter).length && { transfer_date: dateFilter }),
        },
        include: { from_account: { select: { account_name: true } } },
        orderBy: { transfer_date: 'desc' },
      }),
    ]);

    // Normalise into a common shape
    const txns = [
      ...payments.map((p) => ({
        id: p.id,
        type: 'payment',
        date: p.payment_date,
        narration: p.customer
          ? `Receipt from ${p.customer.name}${p.invoice ? ` (#${p.invoice.invoice_number})` : ''}`
          : p.supplier
          ? `Payment to ${p.supplier.name}${p.invoice ? ` (#${p.invoice.invoice_number})` : ''}`
          : 'Payment',
        debit: p.payment_type === 'PAID' ? p.amount : 0,
        credit: p.payment_type === 'RECEIVED' ? p.amount : 0,
        reference: p.reference_number,
        payment_mode: p.payment_mode,
      })),
      ...expenses.map((e) => ({
        id: e.id,
        type: 'expense',
        date: e.expense_date,
        narration: `Expense – ${e.category}${e.description ? ': ' + e.description : ''}`,
        debit: e.amount,
        credit: 0,
        reference: null,
        payment_mode: e.payment_mode,
      })),
      ...transfersFrom.map((t) => ({
        id: t.id,
        type: 'transfer_out',
        date: t.transfer_date,
        narration: `Transfer to ${t.to_account.account_name}`,
        debit: t.amount,
        credit: 0,
        reference: t.reference_number,
        payment_mode: null,
      })),
      ...transfersTo.map((t) => ({
        id: t.id,
        type: 'transfer_in',
        date: t.transfer_date,
        narration: `Transfer from ${t.from_account.account_name}`,
        debit: 0,
        credit: t.amount,
        reference: t.reference_number,
        payment_mode: null,
      })),
    ];

    // Sort descending by date
    txns.sort((a, b) => new Date(b.date) - new Date(a.date));

    const current_balance = await computeBalance(prisma, req.params.id, businessId);
    return res.json({ account: { ...account, current_balance }, transactions: txns });
  } catch (err) {
    console.error('Bank account transactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/bank-accounts/cash-book
// Cash book = every CASH movement not tied to a bank account: cash payments (incl. the cash
// part of split payments) and cash expenses. It is continuous across financial years, with
// an opening balance (all cash before `from`) and a running balance on every line.
router.get('/cash-book', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;
  const fromD = from ? parseDayStart(from) : null;
  const toD = to ? parseDayEnd(to) : null;

  const payWhere = {
    business_id: businessId,
    bank_account_id: null,
    is_reversed: false,
    OR: [{ payment_mode: 'cash' }, { splits: { some: { payment_mode: 'cash' } } }],
  };
  const expWhere = { business_id: businessId, payment_mode: 'cash', bank_account_id: null, is_deleted: false };

  const [payments, expenses] = await Promise.all([
    prisma.payment.findMany({
      where: payWhere,
      include: {
        customer: { select: { name: true } },
        supplier: { select: { name: true } },
        invoice: { select: { invoice_number: true } },
        splits: true,
      },
      orderBy: [{ payment_date: 'asc' }, { created_at: 'asc' }],
    }),
    prisma.expense.findMany({ where: expWhere, orderBy: [{ expense_date: 'asc' }, { created_at: 'asc' }] }),
  ]);

  // cash portion of a payment: whole amount if paid in cash, else the cash splits
  const cashPart = (p) => (p.payment_mode === 'cash'
    ? p.amount
    : p.splits.filter((x) => x.payment_mode === 'cash').reduce((sum, x) => sum + x.amount, 0));

  const all = [
    ...payments.map((p) => {
      const cash = cashPart(p);
      return {
        id: p.id, type: 'payment', date: p.payment_date,
        narration: p.payment_type === 'PAID'
          ? `Payment to ${p.supplier?.name || p.customer?.name || 'party'}${p.invoice ? ` (#${p.invoice.invoice_number})` : ''}`
          : `Receipt from ${p.customer?.name || p.supplier?.name || 'party'}${p.invoice ? ` (#${p.invoice.invoice_number})` : ''}`,
        debit: p.payment_type === 'PAID' ? cash : 0,      // cash out
        credit: p.payment_type === 'RECEIVED' ? cash : 0, // cash in
        reference: p.reference_number,
      };
    }),
    ...expenses.map((e) => ({
      id: e.id, type: 'expense', date: e.expense_date,
      narration: `Expense – ${e.category}${e.description ? ': ' + e.description : ''}`,
      debit: e.amount, credit: 0, reference: null,
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let opening = 0;
  const inRange = [];
  for (const t of all) {
    const d = new Date(t.date);
    if (fromD && d < fromD) opening += t.credit - t.debit;
    else if (!toD || d <= toD) inRange.push(t);
  }
  let running = opening;
  const transactions = inRange.map((t) => {
    running += t.credit - t.debit;
    return { ...t, balance: running };
  });
  const totalDebit = inRange.reduce((s, t) => s + t.debit, 0);
  const totalCredit = inRange.reduce((s, t) => s + t.credit, 0);

  // newest first for display, like the other books
  return res.json({
    transactions: transactions.reverse(),
    totalDebit,
    totalCredit,
    opening_balance: opening,
    closing_balance: running,
  });
});

module.exports = router;
