// Reports for batch-tracked stock (medical / FMCG) and the item-wise sale reports.
//   GET /reports/near-expiry?within=N     stock that expires in the next N days (default: the business's near-expiry setting)
//   GET /reports/expired-stock            stock past its expiry date, still on the shelf
//   GET /reports/batch-stock              every batch with what is left, its value and expiry status
//   GET /reports/batch-sales?from=&to=    sales less returns, per batch
//   GET /reports/item-sales?from=&to=     sales less returns, per item (qty, revenue, cost, profit)
//   GET /reports/mrp-sales?from=&to=      sales less returns, per item and MRP
// Money is in paise. Revenue is the line amount before GST and before any bill-level discount (as in the other sale reports).
const express = require('express');
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { attachFinancialYear } = require('../middleware/financialYear');
const { invoiceDateWhere } = require('../utils/reportHelpers');
const { todayDate, DAY_MS } = require('../utils/time');

const router = express.Router();
// this router shares /api/reports with the older one, so its checks apply only to its own paths
const MINE = ['/near-expiry', '/expired-stock', '/batch-stock', '/item-sales', '/batch-sales', '/mrp-sales'];
router.use(MINE, authenticateToken);
router.use(MINE, attachFinancialYear);

const DATE_PARAM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ID_PARAM = /^[A-Za-z0-9_-]{1,40}$/;
const bad = (res, error) => res.status(400).json({ error, code: 'VALIDATION' });

// Query checks shared by every report here; sets req.q
router.use(MINE, (req, res, next) => {
  const q = {};
  for (const k of ['from', 'to']) {
    const v = req.query[k];
    if (v === undefined || v === '') continue;
    const d = new Date(`${v}T00:00:00Z`);
    if (typeof v !== 'string' || !DATE_PARAM.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return bad(res, `Invalid ${k}: use YYYY-MM-DD`);
    q[k] = v;
  }
  if (q.from && q.to && q.from > q.to) return bad(res, '"from" must not be after "to"');
  if (req.query.product_id !== undefined) {
    if (typeof req.query.product_id !== 'string' || !ID_PARAM.test(req.query.product_id)) return bad(res, 'Invalid product_id');
    q.product_id = req.query.product_id;
  }
  if (req.query.within !== undefined) {
    const w = Number(req.query.within);
    if (!Number.isInteger(w) || w < 1 || w > 730) return bad(res, 'within must be a whole number of days from 1 to 730');
    q.within = w;
  }
  if (req.query.limit !== undefined) {
    const l = Number(req.query.limit);
    if (!Number.isInteger(l) || l < 1 || l > 5000) return bad(res, 'limit must be from 1 to 5000');
    q.limit = l;
  }
  q.sort = ['revenue', 'qty', 'profit', 'name'].includes(req.query.sort) ? req.query.sort : 'revenue';
  q.include_empty = req.query.include_empty === '1';
  req.q = q;
  next();
});

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const fail = (res, err, what) => { console.error(`${what} error:`, err); res.status(500).json({ error: `Failed to fetch ${what}` }); };

async function nearDaysOf(businessId) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { near_expiry_days: true } });
  return b?.near_expiry_days || 90;
}

// Batches with stock on hand, as report rows
function batchRow(b, today, nearDays) {
  const expired = !!b.expiry_date && new Date(b.expiry_date).getTime() < today.getTime();
  const days = b.expiry_date ? daysBetween(b.expiry_date, today) : null;
  const status = expired ? 'expired' : days != null && days <= nearDays ? 'near_expiry' : 'ok';
  return {
    batch_id: b.id, product_id: b.product_id, product_name: b.product.name, unit: b.product.unit,
    batch_no: b.batch_no, expiry_date: day(b.expiry_date), days_to_expiry: days, status,
    quantity: b.quantity, mrp: b.mrp, purchase_price: b.purchase_price,
    value_at_cost: Math.round(b.quantity * b.purchase_price), value_at_mrp: Math.round(b.quantity * b.mrp),
    supplier: b.supplier ? { id: b.supplier.id, name: b.supplier.name } : null,
  };
}
const batchInclude = { product: { select: { name: true, unit: true } }, supplier: { select: { id: true, name: true } } };
const sumRows = (rows) => ({ quantity: round4(rows.reduce((s, r) => s + r.quantity, 0)), value_at_cost: rows.reduce((s, r) => s + r.value_at_cost, 0), value_at_mrp: rows.reduce((s, r) => s + r.value_at_mrp, 0), batches: rows.length });

async function stockRows(req, extraWhere) {
  const businessId = req.user.businessId;
  const where = { business_id: businessId, product: { is_deleted: false }, quantity: { gt: 0 }, ...(req.q.product_id ? { product_id: req.q.product_id } : {}), ...extraWhere };
  const [batches, nearDays] = await Promise.all([
    prisma.batch.findMany({ where, include: batchInclude, orderBy: [{ expiry_date: 'asc' }, { batch_no: 'asc' }] }),
    nearDaysOf(businessId),
  ]);
  return { batches, nearDays };
}

router.get('/near-expiry', async (req, res) => {
  try {
    const today = todayDate();
    const nearDays = req.q.within || (await nearDaysOf(req.user.businessId));
    const until = new Date(today.getTime() + nearDays * DAY_MS);
    const { batches } = await stockRows(req, { expiry_date: { gte: today, lte: until } });
    const rows = batches.map((b) => batchRow(b, today, nearDays));
    res.json({ within_days: nearDays, as_of: day(today), rows, totals: sumRows(rows) });
  } catch (err) { fail(res, err, 'near-expiry report'); }
});

router.get('/expired-stock', async (req, res) => {
  try {
    const today = todayDate();
    const { batches, nearDays } = await stockRows(req, { expiry_date: { lt: today } });
    const rows = batches.map((b) => batchRow(b, today, nearDays));
    res.json({ as_of: day(today), rows, totals: sumRows(rows) });
  } catch (err) { fail(res, err, 'expired stock report'); }
});

router.get('/batch-stock', async (req, res) => {
  try {
    const today = todayDate();
    const businessId = req.user.businessId;
    const where = { business_id: businessId, product: { is_deleted: false }, ...(req.q.include_empty ? {} : { quantity: { not: 0 } }), ...(req.q.product_id ? { product_id: req.q.product_id } : {}) };
    const [batches, nearDays] = await Promise.all([
      prisma.batch.findMany({ where, include: batchInclude, orderBy: [{ product: { name: 'asc' } }, { expiry_date: 'asc' }, { batch_no: 'asc' }] }),
      nearDaysOf(businessId),
    ]);
    const rows = batches.map((b) => batchRow(b, today, nearDays));
    if (['expired', 'near_expiry', 'ok'].includes(req.query.status)) {
      const kept = rows.filter((r) => r.status === req.query.status);
      return res.json({ as_of: day(today), near_expiry_days: nearDays, rows: kept, totals: sumRows(kept) });
    }
    res.json({ as_of: day(today), near_expiry_days: nearDays, rows, totals: sumRows(rows) });
  } catch (err) { fail(res, err, 'batch stock report'); }
});

// Sale and sale-return lines in the period (returns count as minus)
async function saleLines(req) {
  const where = {
    invoice: {
      business_id: req.user.businessId, is_deleted: false, voucher_type: { in: ['SALE', 'SALE_RETURN'] }, status: { notIn: ['draft', 'cancelled'] },
      ...invoiceDateWhere(req.q.from, req.q.to, req.financialYear),
    },
    ...(req.q.product_id ? { product_id: req.q.product_id } : {}),
  };
  const lines = await prisma.invoiceItem.findMany({
    where,
    select: {
      product_id: true, description: true, unit: true, quantity: true, amount: true, tax_amount: true, discount_percent: true, rate: true,
      batch_id: true, batch_no: true, expiry_date: true, mrp: true, cost_price: true, invoice_id: true,
      invoice: { select: { voucher_type: true, rates_include_gst: true } },
      product: { select: { name: true, unit: true, purchase_price: true } },
    },
  });
  return lines.map((l) => {
    const sign = l.invoice.voucher_type === 'SALE_RETURN' ? -1 : 1;
    const unitCost = l.cost_price != null ? l.cost_price : l.product?.purchase_price ?? null;
    return { ...l, sign, unitCost };
  });
}

// One accumulator per group: sales minus returns
function newAcc(init) {
  return { ...init, qty_sold: 0, qty_returned: 0, gross_revenue: 0, returns_amount: 0, tax: 0, cost: 0, cost_known_revenue: 0, bills: new Set() };
}
function addLine(acc, l) {
  if (l.sign > 0) { acc.qty_sold += l.quantity; acc.gross_revenue += l.amount; } else { acc.qty_returned += l.quantity; acc.returns_amount += l.amount; }
  acc.tax += l.sign * l.tax_amount;
  if (l.unitCost != null) { acc.cost += l.sign * Math.round(l.quantity * l.unitCost); acc.cost_known_revenue += l.sign * l.amount; }
  acc.bills.add(l.invoice_id);
}
function finish(acc) {
  const net_qty = round4(acc.qty_sold - acc.qty_returned);
  const net_revenue = acc.gross_revenue - acc.returns_amount;
  // profit is only worked out on lines whose cost is known, so a missing cost never shows as a 100% margin
  const profit = acc.cost_known_revenue - acc.cost;
  const { bills, cost_known_revenue, ...rest } = acc;
  return {
    ...rest, qty_sold: round4(acc.qty_sold), qty_returned: round4(acc.qty_returned), net_qty, net_revenue,
    avg_rate: net_qty > 0 ? Math.round(net_revenue / net_qty) : 0,
    profit, margin_pct: pct(profit, cost_known_revenue), bills: bills.size, cost_complete: Math.abs(cost_known_revenue - net_revenue) < 1,
  };
}
const totalsOf = (rows) => {
  const t = rows.reduce((a, r) => ({ qty_sold: a.qty_sold + r.qty_sold, qty_returned: a.qty_returned + r.qty_returned, net_qty: a.net_qty + r.net_qty, gross_revenue: a.gross_revenue + r.gross_revenue, returns_amount: a.returns_amount + r.returns_amount, net_revenue: a.net_revenue + r.net_revenue, tax: a.tax + r.tax, cost: a.cost + r.cost, profit: a.profit + r.profit }), { qty_sold: 0, qty_returned: 0, net_qty: 0, gross_revenue: 0, returns_amount: 0, net_revenue: 0, tax: 0, cost: 0, profit: 0 });
  return { ...t, qty_sold: round4(t.qty_sold), qty_returned: round4(t.qty_returned), net_qty: round4(t.net_qty), rows: rows.length };
};
const sorter = (sort) => {
  const by = { revenue: (a, b) => b.net_revenue - a.net_revenue, qty: (a, b) => b.net_qty - a.net_qty, profit: (a, b) => b.profit - a.profit, name: (a, b) => String(a.name).localeCompare(String(b.name)) }[sort];
  return (a, b) => by(a, b) || String(a.name).localeCompare(String(b.name));
};

router.get('/item-sales', async (req, res) => {
  try {
    const groups = new Map();
    for (const l of await saleLines(req)) {
      const key = l.product_id || `desc:${l.description}`;
      if (!groups.has(key)) groups.set(key, { acc: newAcc({ product_id: l.product_id, name: l.product?.name || l.description, unit: l.product?.unit || l.unit }), batches: new Set() });
      const g = groups.get(key);
      addLine(g.acc, l);
      if (l.batch_no) g.batches.add(`${l.batch_no}|${l.mrp}`);
    }
    let rows = [...groups.values()].map((g) => ({ ...finish(g.acc), batches_used: g.batches.size })).sort(sorter(req.q.sort));
    const totals = totalsOf(rows);
    if (req.q.limit) rows = rows.slice(0, req.q.limit);
    res.json({ rows, totals });
  } catch (err) { fail(res, err, 'item-wise sales'); }
});

router.get('/batch-sales', async (req, res) => {
  try {
    const lines = (await saleLines(req)).filter((l) => l.batch_id || l.batch_no);
    const groups = new Map();
    for (const l of lines) {
      const key = l.batch_id || `${l.product_id}|${l.batch_no}|${l.mrp}`;
      if (!groups.has(key)) groups.set(key, newAcc({ batch_id: l.batch_id, product_id: l.product_id, name: l.product?.name || l.description, unit: l.product?.unit || l.unit, batch_no: l.batch_no, expiry_date: day(l.expiry_date), mrp: l.mrp }));
      addLine(groups.get(key), l);
    }
    const left = new Map((await prisma.batch.findMany({ where: { id: { in: [...groups.values()].map((g) => g.batch_id).filter(Boolean) } }, select: { id: true, quantity: true } })).map((b) => [b.id, b.quantity]));
    let rows = [...groups.values()].map((g) => ({ ...finish(g), stock_left: g.batch_id && left.has(g.batch_id) ? left.get(g.batch_id) : null }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.expiry_date || '9').localeCompare(String(b.expiry_date || '9')) || String(a.batch_no).localeCompare(String(b.batch_no)));
    const totals = totalsOf(rows);
    if (req.q.limit) rows = rows.slice(0, req.q.limit);
    res.json({ rows, totals });
  } catch (err) { fail(res, err, 'batch-wise sales'); }
});

router.get('/mrp-sales', async (req, res) => {
  try {
    const groups = new Map();
    for (const l of await saleLines(req)) {
      if (!(l.mrp > 0)) continue;
      const key = `${l.product_id || l.description}|${l.mrp}`;
      if (!groups.has(key)) groups.set(key, { acc: newAcc({ product_id: l.product_id, name: l.product?.name || l.description, unit: l.product?.unit || l.unit, mrp: l.mrp }), batches: new Set() });
      const g = groups.get(key);
      addLine(g.acc, l);
      if (l.batch_no) g.batches.add(l.batch_no);
    }
    let rows = [...groups.values()].map((g) => {
      const r = finish(g.acc);
      // what the customer paid per piece (GST included) against the printed MRP
      const paid = r.net_qty > 0 ? Math.round((r.net_revenue + r.tax) / r.net_qty) : 0;
      return { ...r, batches_used: g.batches.size, avg_paid_per_unit: paid, below_mrp_pct: r.net_qty > 0 ? Math.round(((r.mrp - paid) / r.mrp) * 10000) / 100 : 0 };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.mrp - b.mrp);
    const totals = totalsOf(rows);
    if (req.q.limit) rows = rows.slice(0, req.q.limit);
    res.json({ rows, totals });
  } catch (err) { fail(res, err, 'MRP-wise sales'); }
});

module.exports = router;
