// Row-level locks inside a transaction. Serialises read-modify-write sequences
// (running ledger balance, payment totals, advance usage, stock) so two
// concurrent requests cannot both read the same "last balance".
const TABLES = {
  customer: '"Customer"',
  supplier: '"Supplier"',
  invoice: '"Invoice"',
  product: '"Product"',
  bankAccount: '"bank_accounts"',
  financialYear: '"FinancialYear"',
  payment: '"Payment"',
};

async function lockRow(tx, kind, id) {
  const table = TABLES[kind];
  if (!table) throw new Error(`lockRow: unknown kind ${kind}`);
  if (!id) return;
  await tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, id);
}

// Lock several rows in a stable order to avoid deadlocks.
async function lockRows(tx, kind, ids) {
  const sorted = [...new Set(ids.filter(Boolean))].sort();
  for (const id of sorted) await lockRow(tx, kind, id);
}

module.exports = { lockRow, lockRows };
