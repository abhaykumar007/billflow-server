const express = require('express');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const {
  effectiveDesign, sanitizeDesign, lockedPaths, validateImage, validateUpi, PAPERS,
} = require('../services/billDesign');
const { renderBill, sampleInvoice } = require('../services/billRenderer');

const router = express.Router();
router.use(authenticateToken);

async function loadBusiness(businessId) {
  return prisma.business.findUnique({ where: { id: businessId } });
}

// The bank account shown on the bill: the chosen one, else the first active account.
async function bankFor(businessId, design) {
  if (!design.extras.bank) return null;
  const where = { business_id: businessId, is_deleted: false, is_active: true };
  if (design.extras.bank_account_id) where.id = design.extras.bank_account_id;
  return prisma.bankAccount.findFirst({ where, orderBy: { created_at: 'asc' } });
}

async function payload(business) {
  const accounts = await prisma.bankAccount.findMany({
    where: { business_id: business.id, is_deleted: false, is_active: true },
    select: { id: true, account_name: true, bank_name: true, account_number: true, ifsc_code: true },
    orderBy: { created_at: 'asc' },
  });
  return {
    design: effectiveDesign(business.bill_design, business),
    locked: lockedPaths(business),
    logo_data: business.logo_data || null,
    logo_url: business.logo_url || null,
    signature_data: business.signature_data || null,
    upi_id: business.upi_id || null,
    gst_registered: !!business.gstin,
    bank_accounts: accounts,
  };
}

// GET /api/bill-design
router.get('/', async (req, res) => {
  try {
    const business = await loadBusiness(req.user.businessId);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    return res.json(await payload(business));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load bill design' });
  }
});

// PUT /api/bill-design  { design }
router.put('/', requireRole(...MANAGERS), async (req, res) => {
  try {
    const business = await loadBusiness(req.user.businessId);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!req.body || typeof req.body.design !== 'object' || req.body.design === null) return res.status(400).json({ error: 'design is required' });
    const design = sanitizeDesign(req.body.design, business);
    const updated = await prisma.business.update({ where: { id: business.id }, data: { bill_design: design } });
    return res.json(await payload(updated));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save bill design' });
  }
});

// PUT /api/bill-design/assets  { logo_data?, signature_data?, upi_id? }   (null or '' clears, missing leaves as is)
router.put('/assets', requireRole(...MANAGERS), async (req, res) => {
  try {
    const body = req.body || {};
    const data = {};
    for (const key of ['logo_data', 'signature_data']) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v === null || v === '') data[key] = null;
      else if (validateImage(v)) data[key] = v;
      else return res.status(400).json({ error: `${key === 'logo_data' ? 'Logo' : 'Signature'} must be a PNG, JPEG or WebP image under about 300 KB` });
    }
    if ('upi_id' in body) {
      const v = body.upi_id;
      if (v === null || v === '') data.upi_id = null;
      else if (validateUpi(v)) data.upi_id = String(v).trim();
      else return res.status(400).json({ error: 'Enter a valid UPI ID, like shop@okbank' });
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    const updated = await prisma.business.update({ where: { id: req.user.businessId }, data });
    return res.json(await payload(updated));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save' });
  }
});

// POST /api/bill-design/preview  { design?, paper? }  ->  { html }  (a sample bill using the unsaved design)
router.post('/preview', async (req, res) => {
  try {
    const business = await loadBusiness(req.user.businessId);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    const body = req.body || {};
    const paper = PAPERS.includes(body.paper) ? body.paper : undefined;
    const design = sanitizeDesign(body.design && typeof body.design === 'object' ? body.design : business.bill_design || {}, business);
    const html = await renderBill({ invoice: sampleInvoice(business), business, design, paper, bank: await bankFor(business.id, design) });
    return res.json({ html, paper: paper || design.paper });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to build preview' });
  }
});

module.exports = router;
