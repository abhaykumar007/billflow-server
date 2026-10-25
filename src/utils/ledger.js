// Ledger posting + shared guards. Every ledger write goes through here so the
// running balance is computed the same way everywhere, under a row lock.
//
// Conventions (paise):
//   Customer ledger   balance = Σ debit − Σ credit   (+ = customer owes us)
//   Supplier ledger   balance = Σ credit − Σ debit   (+ = we owe supplier)
const { lockRow } = require('./lock');
const { HttpError } = require('./httpError');

async function postCustomerEntry(tx, e) {
  const { businessId, customerId, fyId = null, debit = 0, credit = 0, entryType, referenceId = null, referenceType, narration, entryDate } = e;
  await lockRow(tx, 'customer', customerId);
  const agg = await tx.ledgerEntry.aggregate({
    where: { business_id: businessId, customer_id: customerId, financial_year_id: fyId },
    _sum: { debit: true, credit: true },
  });
  const prev = (agg._sum.debit || 0) - (agg._sum.credit || 0);
  return tx.ledgerEntry.create({
    data: {
      business_id: businessId,
      financial_year_id: fyId,
      customer_id: customerId,
      entry_type: entryType,
      reference_id: referenceId,
      reference_type: referenceType,
      debit,
      credit,
      balance: prev + debit - credit,
      narration,
      entry_date: entryDate || new Date(),
    },
  });
}

async function postSupplierEntry(tx, e) {
  const { businessId, supplierId, fyId = null, debit = 0, credit = 0, entryType, referenceId = null, referenceType, narration, entryDate } = e;
  await lockRow(tx, 'supplier', supplierId);
  const agg = await tx.supplierLedgerEntry.aggregate({
    where: { business_id: businessId, supplier_id: supplierId, financial_year_id: fyId },
    _sum: { debit: true, credit: true },
  });
  const prev = (agg._sum.credit || 0) - (agg._sum.debit || 0);
  return tx.supplierLedgerEntry.create({
    data: {
      business_id: businessId,
      financial_year_id: fyId,
      supplier_id: supplierId,
      entry_type: entryType,
      reference_id: referenceId,
      reference_type: referenceType,
      debit,
      credit,
      balance: prev + credit - debit,
      narration,
      entry_date: entryDate || new Date(),
    },
  });
}

// How a voucher type posts to the books, and how a payment against it is classified.
//   post:    side of the party ledger the VOUCHER itself hits
//   settle:  what recording a payment against it means
const VOUCHERS = {
  SALE:            { party: 'CUSTOMER', post: 'debit',  settleType: 'RECEIVED', settleSide: 'credit', stock: -1, label: 'Invoice' },
  SALE_RETURN:     { party: 'CUSTOMER', post: 'credit', settleType: 'PAID',     settleSide: 'debit',  stock: +1, label: 'Credit Note' },
  PURCHASE:        { party: 'SUPPLIER', post: 'credit', settleType: 'PAID',     settleSide: 'debit',  stock: +1, label: 'Purchase' },
  PURCHASE_RETURN: { party: 'SUPPLIER', post: 'debit',  settleType: 'RECEIVED', settleSide: 'credit', stock: -1, label: 'Debit Note' },
};

// Financial-year guards ------------------------------------------------------

function assertFyWritable(fy) {
  if (!fy) throw new HttpError(400, 'No financial year selected. Please select or create a financial year first.', 'NO_FY');
  if (fy.is_closed) throw new HttpError(403, 'Financial year is closed. No transactions can be added to a closed year.', 'FY_CLOSED');
  if (fy.is_locked) throw new HttpError(423, 'This financial year is locked. No changes are allowed.', 'FY_LOCKED');
}

function assertDateInFY(date, fy) {
  if (date < fy.start_date || date > fy.end_date) {
    throw new HttpError(
      400,
      `Date ${date.toISOString().slice(0, 10)} is outside ${fy.label}. Select the correct financial year or change the date.`,
      'DATE_OUTSIDE_FY'
    );
  }
}

// Posting is only allowed into a year whose balances have not yet been carried
// forward into a later year (otherwise that later year's opening balance goes stale).
async function assertCanPost(client, fy) {
  assertFyWritable(fy);
  const later = await client.financialYear.findMany({
    where: { business_id: fy.business_id, start_date: { gt: fy.start_date } },
    select: { id: true },
  });
  if (later.length === 0) return;
  const ids = later.map((l) => l.id);
  const [c, s] = await Promise.all([
    client.ledgerEntry.findFirst({ where: { financial_year_id: { in: ids }, entry_type: 'carry_forward' }, select: { id: true } }),
    client.supplierLedgerEntry.findFirst({ where: { financial_year_id: { in: ids }, entry_type: 'carry_forward' }, select: { id: true } }),
  ]);
  if (c || s) {
    throw new HttpError(
      409,
      `Balances have already been carried forward from ${fy.label}. Record this in the current financial year instead (or issue a credit note).`,
      'FY_ALREADY_CARRIED'
    );
  }
}

async function getActiveFY(client, businessId) {
  return client.financialYear.findFirst({ where: { business_id: businessId, is_active: true } });
}

// FY of an existing record, must be open for edits
async function assertRecordFyWritable(client, fyId) {
  if (!fyId) return null;
  const fy = await client.financialYear.findUnique({ where: { id: fyId } });
  assertFyWritable(fy);
  return fy;
}

// Idempotency-Key header (or body.idempotency_key): lets clients retry a POST safely
function idempotencyKey(req) {
  const k = req.get('idempotency-key') || req.body?.idempotency_key;
  if (!k) return null;
  const s = String(k).trim();
  if (s.length < 8 || s.length > 100) throw new HttpError(400, 'Idempotency-Key must be 8-100 characters', 'VALIDATION');
  return s;
}

module.exports = {
  postCustomerEntry, postSupplierEntry, VOUCHERS,
  assertFyWritable, assertCanPost, assertDateInFY, getActiveFY, assertRecordFyWritable, idempotencyKey,
};
