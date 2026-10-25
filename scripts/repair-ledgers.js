#!/usr/bin/env node
/**
 * One-off data repair for books written by earlier versions of BillFlow.
 *
 *   node scripts/repair-ledgers.js                  dry run for every business (changes are rolled back)
 *   node scripts/repair-ledgers.js --apply          apply to every business
 *   node scripts/repair-ledgers.js --business <id>  limit to one business
 *
 * What it fixes (per business, per customer / supplier):
 *   1. Ledger lines with no financial year (opening balances) are moved into the business's first year.
 *   2. "advance_adjustment" lines that credited the customer a second time are zeroed
 *      (the advance was already credited when it was received).
 *   3. The carry-forward line of every year is rebuilt from the previous year's true closing balance
 *      (sum of debit/credit), so opening balances and the supplier sign flip are corrected.
 *   4. Every line's stored running `balance` is recomputed.
 *
 * Take a database backup / Neon branch first. Run a dry run and read the summary before --apply.
 */
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
const prisma = require('../src/utils/prisma');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyBusiness = args.includes('--business') ? args[args.indexOf('--business') + 1] : null;

class DryRunRollback extends Error {}

const stats = () => ({ moved_to_fy: 0, advance_adjust_zeroed: 0, carry_created: 0, carry_updated: 0, carry_deleted: 0, balances_rewritten: 0 });

const SPEC = {
  customer: { model: 'ledgerEntry', party: 'customer_id', sign: +1 },   // balance = debit - credit
  supplier: { model: 'supplierLedgerEntry', party: 'supplier_id', sign: -1 }, // balance = credit - debit
};

const orderInFy = (a, b) =>
  (b.entry_type === 'carry_forward') - (a.entry_type === 'carry_forward') ||
  new Date(a.entry_date) - new Date(b.entry_date) ||
  new Date(a.created_at) - new Date(b.created_at) ||
  (a.id < b.id ? -1 : 1);

async function repairKind(tx, kind, businessId, years, st) {
  const { model, party, sign } = SPEC[kind];

  // 1. year-less lines -> first year
  if (years.length) {
    const r = await tx[model].updateMany({
      where: { business_id: businessId, financial_year_id: null },
      data: { financial_year_id: years[0].id },
    });
    st.moved_to_fy += r.count;
  }

  // 2. advance applications must not credit the ledger a second time
  if (kind === 'customer') {
    const r = await tx.ledgerEntry.updateMany({
      where: { business_id: businessId, entry_type: 'advance_adjustment', credit: { gt: 0 } },
      data: { credit: 0 },
    });
    st.advance_adjust_zeroed += r.count;
  }

  // 3 + 4. walk the years in order
  let closing = new Map(); // party id -> closing balance of the previous year
  for (let i = 0; i < years.length; i++) {
    const fy = years[i];
    const entries = await tx[model].findMany({ where: { business_id: businessId, financial_year_id: fy.id } });

    if (i > 0) {
      const existingCarry = new Map(entries.filter((e) => e.entry_type === 'carry_forward').map((e) => [e[party], e]));
      const wanted = new Map([...closing].filter(([, bal]) => bal !== 0));

      for (const [pid, bal] of wanted) {
        const debit = sign === +1 ? (bal > 0 ? bal : 0) : (bal < 0 ? -bal : 0);
        const credit = sign === +1 ? (bal < 0 ? -bal : 0) : (bal > 0 ? bal : 0);
        const cur = existingCarry.get(pid);
        if (cur) {
          if (cur.debit !== debit || cur.credit !== credit) {
            await tx[model].update({ where: { id: cur.id }, data: { debit, credit, balance: bal } });
            cur.debit = debit; cur.credit = credit;
            st.carry_updated++;
          }
        } else {
          const created = await tx[model].create({
            data: {
              business_id: businessId, financial_year_id: fy.id, [party]: pid,
              entry_type: 'carry_forward', reference_type: 'carry_forward', reference_id: years[i - 1].id,
              debit, credit, balance: bal, narration: `Balance carried forward from ${years[i - 1].label}`,
              entry_date: fy.start_date,
            },
          });
          entries.push(created);
          st.carry_created++;
        }
      }
      for (const [pid, cur] of existingCarry) {
        if (!wanted.has(pid)) {
          await tx[model].delete({ where: { id: cur.id } });
          entries.splice(entries.indexOf(cur), 1);
          st.carry_deleted++;
        }
      }
    }

    // recompute stored running balances per party, in a stable order
    const byParty = new Map();
    for (const e of entries) {
      if (!byParty.has(e[party])) byParty.set(e[party], []);
      byParty.get(e[party]).push(e);
    }
    const nextClosing = new Map();
    for (const [pid, list] of byParty) {
      list.sort(orderInFy);
      let running = 0;
      for (const e of list) {
        running += sign * (e.debit - e.credit);
        if (e.balance !== running) {
          await tx[model].update({ where: { id: e.id }, data: { balance: running } });
          st.balances_rewritten++;
        }
      }
      nextClosing.set(pid, running);
    }
    closing = nextClosing;
  }
}

async function main() {
  const businesses = await prisma.business.findMany({
    where: onlyBusiness ? { id: onlyBusiness } : undefined,
    select: { id: true, name: true },
  });
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} for ${businesses.length} business(es)\n`);

  for (const b of businesses) {
    const st = stats();
    try {
      await prisma.$transaction(async (tx) => {
        const years = await tx.financialYear.findMany({ where: { business_id: b.id }, orderBy: { start_date: 'asc' } });
        await repairKind(tx, 'customer', b.id, years, st);
        await repairKind(tx, 'supplier', b.id, years, st);
        if (!APPLY) throw new DryRunRollback();
      }, { timeout: 120000, maxWait: 20000 });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) {
        console.error(`FAILED for ${b.name} (${b.id}):`, e.message);
        continue;
      }
    }
    const changed = Object.values(st).some((n) => n > 0);
    console.log(`${changed ? '*' : ' '} ${b.name} (${b.id})`, changed ? JSON.stringify(st) : 'nothing to fix');
  }
  if (!APPLY) console.log('\nDry run only. Nothing was changed. Re-run with --apply to write the fixes.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
