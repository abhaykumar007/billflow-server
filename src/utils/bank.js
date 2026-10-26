// Bank / cash balances, computed from source records (never from a stored column).
//   balance = opening + payments received − payments paid − expenses + transfers in − transfers out
async function computeBalances(client, businessId, accountIds) {
  if (accountIds.length === 0) return new Map();
  const inIds = { in: accountIds };
  const [accounts, rec, paid, exp, tin, tout] = await Promise.all([
    client.bankAccount.findMany({ where: { id: inIds, business_id: businessId }, select: { id: true, opening_balance: true } }),
    client.payment.groupBy({ by: ['bank_account_id'], where: { business_id: businessId, bank_account_id: inIds, payment_type: 'RECEIVED', is_reversed: false }, _sum: { amount: true } }),
    client.payment.groupBy({ by: ['bank_account_id'], where: { business_id: businessId, bank_account_id: inIds, payment_type: 'PAID', is_reversed: false }, _sum: { amount: true } }),
    client.expense.groupBy({ by: ['bank_account_id'], where: { business_id: businessId, bank_account_id: inIds, is_deleted: false }, _sum: { amount: true } }),
    client.fundTransfer.groupBy({ by: ['to_account_id'], where: { business_id: businessId, to_account_id: inIds }, _sum: { amount: true } }),
    client.fundTransfer.groupBy({ by: ['from_account_id'], where: { business_id: businessId, from_account_id: inIds }, _sum: { amount: true } }),
  ]);
  const m = (rows, key) => new Map(rows.map((r) => [r[key], r._sum.amount || 0]));
  const R = m(rec, 'bank_account_id');
  const P = m(paid, 'bank_account_id');
  const E = m(exp, 'bank_account_id');
  const TI = m(tin, 'to_account_id');
  const TO = m(tout, 'from_account_id');
  const out = new Map();
  for (const a of accounts) {
    out.set(a.id, (a.opening_balance || 0) + (R.get(a.id) || 0) - (P.get(a.id) || 0) - (E.get(a.id) || 0) + (TI.get(a.id) || 0) - (TO.get(a.id) || 0));
  }
  return out;
}

async function computeBalance(client, bankAccountId, businessId) {
  const map = await computeBalances(client, businessId, [bankAccountId]);
  return map.has(bankAccountId) ? map.get(bankAccountId) : null;
}

module.exports = { computeBalance, computeBalances };
