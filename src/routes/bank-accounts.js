const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Compute current balance for a bank account dynamically
async function computeBalance(bankAccountId, businessId) {
  const [account, paymentsIn, paymentsOut, expensesOut, transfersIn, transfersOut] = await Promise.all([
    prisma.bankAccount.findFirst({
      where: { id: bankAccountId, business_id: businessId },
      select: { opening_balance: true },
    }),
    prisma.payment.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, payment_type: 'RECEIVED', is_reversed: false },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, payment_type: 'PAID', is_reversed: false },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { bank_account_id: bankAccountId, business_id: businessId, is_deleted: false },
      _sum: { amount: true },
    }),
    prisma.fundTransfer.aggregate({
      where: { to_account_id: bankAccountId, business_id: businessId },
      _sum: { amount: true },
    }),
    prisma.fundTransfer.aggregate({
      where: { from_account_id: bankAccountId, business_id: businessId },
      _sum: { amount: true },
    }),
  ]);

  if (!account) return null;
  return (account.opening_balance || 0)
    + (paymentsIn._sum.amount || 0)
    - (paymentsOut._sum.amount || 0)
    - (expensesOut._sum.amount || 0)
    + (transfersIn._sum.amount || 0)
    - (transfersOut._sum.amount || 0);
}

// GET /api/bank-accounts
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: { business_id: businessId, is_deleted: false },
      orderBy: { created_at: 'asc' },
    });

    // Attach computed balance to each account
    const withBalance = await Promise.all(
      accounts.map(async (acc) => ({
        ...acc,
        current_balance: await computeBalance(acc.id, businessId),
      }))
    );

    return res.json(withBalance);
  } catch (err) {
    console.error('Bank accounts list error:', err);
    return res.status(500).json({ error: 'Failed to fetch bank accounts' });
  }
});

// POST /api/bank-accounts
router.post('/', async (req, res) => {
  const { account_name, bank_name, account_number, ifsc_code, opening_balance } = req.body;
  const businessId = req.user.businessId;

  if (!account_name?.trim()) return res.status(400).json({ error: 'Account name is required' });

  const openingPaise = opening_balance ? Math.round(parseFloat(opening_balance) * 100) : 0;

  try {
    const account = await prisma.bankAccount.create({
      data: {
        business_id: businessId,
        account_name: account_name.trim(),
        bank_name: bank_name?.trim() || null,
        account_number: account_number?.trim() || null,
        ifsc_code: ifsc_code?.trim() || null,
        opening_balance: openingPaise,
        current_balance: openingPaise,
      },
    });
    return res.status(201).json({ ...account, current_balance: openingPaise });
  } catch (err) {
    console.error('Create bank account error:', err);
    return res.status(500).json({ error: 'Failed to create bank account' });
  }
});

// PUT /api/bank-accounts/:id
router.put('/:id', async (req, res) => {
  const { account_name, bank_name, account_number, ifsc_code, opening_balance, is_active } = req.body;
  const businessId = req.user.businessId;

  try {
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Bank account not found' });

    const data = {};
    if (account_name !== undefined) data.account_name = account_name.trim();
    if (bank_name !== undefined) data.bank_name = bank_name?.trim() || null;
    if (account_number !== undefined) data.account_number = account_number?.trim() || null;
    if (ifsc_code !== undefined) data.ifsc_code = ifsc_code?.trim() || null;
    if (opening_balance !== undefined) {
      data.opening_balance = Math.round(parseFloat(opening_balance) * 100);
      data.current_balance = data.opening_balance;
    }
    if (is_active !== undefined) data.is_active = is_active;

    const account = await prisma.bankAccount.update({ where: { id: req.params.id }, data });
    const current_balance = await computeBalance(account.id, businessId);
    return res.json({ ...account, current_balance });
  } catch (err) {
    console.error('Update bank account error:', err);
    return res.status(500).json({ error: 'Failed to update bank account' });
  }
});

// DELETE /api/bank-accounts/:id
router.delete('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, business_id: businessId, is_deleted: false },
    });
    if (!existing) return res.status(404).json({ error: 'Bank account not found' });

    await prisma.bankAccount.update({
      where: { id: req.params.id },
      data: { is_deleted: true },
    });
    return res.json({ message: 'Bank account deleted' });
  } catch (err) {
    console.error('Delete bank account error:', err);
    return res.status(500).json({ error: 'Failed to delete bank account' });
  }
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
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to + 'T23:59:59');

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

    const current_balance = await computeBalance(req.params.id, businessId);
    return res.json({ account: { ...account, current_balance }, transactions: txns });
  } catch (err) {
    console.error('Bank account transactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/bank-accounts/cash-book
// Cash book = all payments/expenses with payment_mode='cash' and no bank_account_id
router.get('/cash-book', async (req, res) => {
  const businessId = req.user.businessId;
  const { from, to } = req.query;

  const dateFilter = {};
  if (from) dateFilter.gte = new Date(from);
  if (to) dateFilter.lte = new Date(to + 'T23:59:59');

  try {
    const [payments, expenses] = await Promise.all([
      prisma.payment.findMany({
        where: {
          business_id: businessId,
          payment_mode: 'cash',
          bank_account_id: null,
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
          business_id: businessId,
          payment_mode: 'cash',
          bank_account_id: null,
          is_deleted: false,
          ...(Object.keys(dateFilter).length && { expense_date: dateFilter }),
        },
        orderBy: { expense_date: 'desc' },
      }),
    ]);

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
      })),
      ...expenses.map((e) => ({
        id: e.id,
        type: 'expense',
        date: e.expense_date,
        narration: `Expense – ${e.category}${e.description ? ': ' + e.description : ''}`,
        debit: e.amount,
        credit: 0,
        reference: null,
      })),
    ];

    txns.sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalDebit = txns.reduce((s, t) => s + t.debit, 0);
    const totalCredit = txns.reduce((s, t) => s + t.credit, 0);

    return res.json({ transactions: txns, totalDebit, totalCredit });
  } catch (err) {
    console.error('Cash book error:', err);
    return res.status(500).json({ error: 'Failed to fetch cash book' });
  }
});

module.exports = router;
