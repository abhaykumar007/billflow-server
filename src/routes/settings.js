const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole, MANAGERS } = require('../middleware/auth');
const { getActivePlan, PLAN_LIMITS } = require('../middleware/planLimit');
const { sha256 } = require('../utils/session');

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// GST rule 46: invoice number max 16 chars (letters, digits, '-' and '/'). "<PFX>-2526-0001" => prefix <= 5
const PREFIX_RE = /^[A-Z0-9]{1,5}$/;

router.use(authenticateToken);

// GET /api/settings/business
router.get('/business', async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
    });
    if (!business) return res.status(404).json({ error: 'Business not found' });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch business' });
  }
});

// PUT /api/settings/business
router.put('/business', requireRole('owner'), async (req, res) => {
  try {
    const { name, address, city, state, pincode, phone, email, logo_url } = req.body;
    const gstin = req.body.gstin ? String(req.body.gstin).trim().toUpperCase() : null;
    const pan = req.body.pan ? String(req.body.pan).trim().toUpperCase() : null;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Business name is required' });
    if (gstin && !GSTIN_RE.test(gstin)) return res.status(400).json({ error: 'Enter a valid 15-character GSTIN' });
    if (pan && !PAN_RE.test(pan)) return res.status(400).json({ error: 'Enter a valid 10-character PAN' });
    if (logo_url && !/^https:\/\//i.test(logo_url)) return res.status(400).json({ error: 'Logo URL must start with https://' });
    const business = await prisma.business.update({
      where: { id: req.user.businessId },
      data: { name: name.trim(), address, city, state, pincode, gstin, pan, phone, email, logo_url: logo_url || null },
    });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update business' });
  }
});

// GET /api/settings/invoice
router.get('/invoice', async (req, res) => {
  try {
    const [business, activeFY] = await Promise.all([
      prisma.business.findUnique({
        where: { id: req.user.businessId },
        select: {
          invoice_prefix: true,
          purchase_prefix: true,
          default_due_days: true,
          default_notes: true,
          default_terms: true,
          financial_year_start: true,
        },
      }),
      prisma.financialYear.findFirst({
        where: { business_id: req.user.businessId, is_active: true },
        select: { invoice_next_number: true, purchase_next_number: true },
      }),
    ]);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    return res.json({
      ...business,
      invoice_next_number: activeFY?.invoice_next_number ?? 1,
      purchase_next_number: activeFY?.purchase_next_number ?? 1,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch invoice settings' });
  }
});

// PUT /api/settings/invoice
// Highest sequence number already used for a counter family in a financial year
async function maxSequenceUsed(financialYearId, voucherTypes) {
  const rows = await prisma.invoice.findMany({
    where: { financial_year_id: financialYearId, voucher_type: { in: voucherTypes } },
    select: { invoice_number: true },
  });
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.invoice_number);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

router.put('/invoice', requireRole(...MANAGERS), async (req, res) => {
  try {
    const {
      invoice_prefix, invoice_next_number,
      purchase_prefix, purchase_next_number,
      default_due_days, default_notes, default_terms, financial_year_start,
    } = req.body;

    const businessData = {};
    const fyData = {};

    if (invoice_prefix !== undefined) {
      const prefix = String(invoice_prefix).trim().toUpperCase();
      if (!PREFIX_RE.test(prefix)) return res.status(400).json({ error: 'Sale invoice prefix must be 1-5 letters or digits' });
      businessData.invoice_prefix = prefix;
    }
    if (invoice_next_number !== undefined) {
      const num = parseInt(invoice_next_number);
      if (isNaN(num) || num < 1) return res.status(400).json({ error: 'Next sale invoice number must be a positive integer' });
      fyData.invoice_next_number = num;
    }
    if (purchase_prefix !== undefined) {
      const prefix = String(purchase_prefix).trim().toUpperCase();
      if (!PREFIX_RE.test(prefix)) return res.status(400).json({ error: 'Purchase invoice prefix must be 1-5 letters or digits' });
      businessData.purchase_prefix = prefix;
    }
    if (purchase_next_number !== undefined) {
      const num = parseInt(purchase_next_number);
      if (isNaN(num) || num < 1) return res.status(400).json({ error: 'Next purchase invoice number must be a positive integer' });
      fyData.purchase_next_number = num;
    }
    if (default_due_days !== undefined) {
      const days = parseInt(default_due_days);
      if (isNaN(days) || days < 0) return res.status(400).json({ error: 'Due days must be 0 or more' });
      businessData.default_due_days = days;
    }
    if (financial_year_start !== undefined) {
      const month = parseInt(financial_year_start);
      if (isNaN(month) || month < 1 || month > 12) return res.status(400).json({ error: 'Financial year start must be 1–12' });
      businessData.financial_year_start = month;
    }
    if (default_notes !== undefined) businessData.default_notes = default_notes || null;
    if (default_terms !== undefined) businessData.default_terms = default_terms || null;

    // Update business fields and active FY counters in parallel
    const activeFY = await prisma.financialYear.findFirst({
      where: { business_id: req.user.businessId, is_active: true },
      select: { id: true, invoice_next_number: true, purchase_next_number: true },
    });

    // The counter may never be moved to a number that is already in use (duplicate invoice numbers)
    if (activeFY && fyData.invoice_next_number !== undefined) {
      const used = await maxSequenceUsed(activeFY.id, ['SALE', 'SALE_RETURN']);
      if (fyData.invoice_next_number <= used) {
        return res.status(400).json({ error: `Next sale invoice number must be greater than ${used}, the highest already used this year` });
      }
    }
    if (activeFY && fyData.purchase_next_number !== undefined) {
      const used = await maxSequenceUsed(activeFY.id, ['PURCHASE', 'PURCHASE_RETURN']);
      if (fyData.purchase_next_number <= used) {
        return res.status(400).json({ error: `Next purchase number must be greater than ${used}, the highest already used this year` });
      }
    }

    const [business] = await Promise.all([
      prisma.business.update({
        where: { id: req.user.businessId },
        data: businessData,
        select: {
          invoice_prefix: true,
          purchase_prefix: true,
          default_due_days: true,
          default_notes: true,
          default_terms: true,
          financial_year_start: true,
        },
      }),
      activeFY && Object.keys(fyData).length > 0
        ? prisma.financialYear.update({ where: { id: activeFY.id }, data: fyData })
        : Promise.resolve(null),
    ]);

    return res.json({
      ...business,
      invoice_next_number: activeFY ? (fyData.invoice_next_number ?? activeFY.invoice_next_number) : 1,
      purchase_next_number: activeFY ? (fyData.purchase_next_number ?? activeFY.purchase_next_number) : 1,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update invoice settings' });
  }
});

// GET /api/settings/tax
router.get('/tax', async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { default_tax_rate: true, state: true },
    });
    if (!business) return res.status(404).json({ error: 'Business not found' });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch tax settings' });
  }
});

// PUT /api/settings/tax
router.put('/tax', requireRole(...MANAGERS), async (req, res) => {
  try {
    const { default_tax_rate, state } = req.body;
    const data = {};
    if (default_tax_rate !== undefined) {
      const rate = parseFloat(default_tax_rate);
      if (isNaN(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'Tax rate must be between 0 and 100' });
      data.default_tax_rate = rate;
    }
    if (state !== undefined) data.state = state || null;

    const business = await prisma.business.update({
      where: { id: req.user.businessId },
      data,
      select: { default_tax_rate: true, state: true },
    });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update tax settings' });
  }
});

// GET /api/settings/users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { business_id: req.user.businessId },
      select: { id: true, name: true, email: true, phone: true, role: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/settings/users/invite - add a team member (owner only; plan decides how many)
router.post('/users/invite', requireRole('owner'), async (req, res) => {
  try {
    const { name, password, role = 'staff' } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['staff', 'accountant'].includes(role)) {
      return res.status(400).json({ error: 'role must be staff or accountant' });
    }

    const plan = await getActivePlan(req.user.businessId);
    const userLimit = PLAN_LIMITS[plan].users;
    const count = await prisma.user.count({ where: { business_id: req.user.businessId } });
    if (count >= userLimit) {
      return res.status(403).json({
        error: plan === 'free'
          ? 'Multi-user access requires a Starter or Pro plan.'
          : `Your ${plan} plan allows ${userLimit} users.`,
        code: 'PLAN_LIMIT_REACHED',
      });
    }

    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(String(password), 12);
    const user = await prisma.user.create({
      data: { name: String(name).trim(), email, password_hash, role, business_id: req.user.businessId },
      select: { id: true, name: true, email: true, role: true, created_at: true },
    });
    return res.status(201).json(user);
  } catch (err) {
    console.error('Invite user error:', err);
    return res.status(500).json({ error: 'Failed to invite user' });
  }
});

// PUT /api/settings/users/:id/role - owner changes a team member's role
router.put('/users/:id/role', requireRole('owner'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!['staff', 'accountant'].includes(role)) return res.status(400).json({ error: 'role must be staff or accountant' });
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot change your own role' });
    const target = await prisma.user.findFirst({ where: { id: req.params.id, business_id: req.user.businessId } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'The owner role cannot be changed' });
    const user = await prisma.user.update({
      where: { id: target.id },
      data: { role },
      select: { id: true, name: true, email: true, role: true },
    });
    return res.json(user);
  } catch (err) {
    console.error('Change role error:', err);
    return res.status(500).json({ error: 'Failed to change role' });
  }
});

// DELETE /api/settings/users/:id - owner removes a team member and signs them out everywhere
router.delete('/users/:id', requireRole('owner'), async (req, res) => {
  try {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot remove yourself' });
    const target = await prisma.user.findFirst({ where: { id: req.params.id, business_id: req.user.businessId } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed' });

    const hasHistory = await prisma.invoice.count({ where: { created_by: target.id } });
    if (hasHistory > 0) {
      // keep the row (invoices reference it) but lock the account
      await prisma.$transaction([
        prisma.refreshSession.deleteMany({ where: { user_id: target.id } }),
        prisma.user.update({
          where: { id: target.id },
          data: { password_hash: 'DISABLED', email: `removed+${target.id}@billflow.invalid` },
        }),
      ]);
    } else {
      await prisma.user.delete({ where: { id: target.id } });
    }
    return res.json({ message: 'User removed' });
  } catch (err) {
    console.error('Remove user error:', err);
    return res.status(500).json({ error: 'Failed to remove user' });
  }
});

// PUT /api/settings/password — change own password
router.put('/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const password_hash = await bcrypt.hash(new_password, 12);
    await prisma.user.update({ where: { id: req.user.userId }, data: { password_hash } });
    // sign out every OTHER device; keep the one that just changed the password
    const currentToken = req.cookies?.refreshToken || req.body?.refreshToken;
    await prisma.refreshSession.deleteMany({
      where: {
        user_id: req.user.userId,
        ...(currentToken ? { token_hash: { not: sha256(currentToken) } } : {}),
      },
    });
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
