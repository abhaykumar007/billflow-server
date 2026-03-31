const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');

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
router.put('/business', async (req, res) => {
  try {
    const { name, address, city, state, pincode, gstin, pan, phone, email } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Business name is required' });
    const business = await prisma.business.update({
      where: { id: req.user.businessId },
      data: { name: name.trim(), address, city, state, pincode, gstin, pan, phone, email },
    });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update business' });
  }
});

// GET /api/settings/invoice
router.get('/invoice', async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: {
        invoice_prefix: true,
        invoice_next_number: true,
        default_due_days: true,
        default_notes: true,
        default_terms: true,
        financial_year_start: true,
      },
    });
    if (!business) return res.status(404).json({ error: 'Business not found' });
    return res.json(business);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch invoice settings' });
  }
});

// PUT /api/settings/invoice
router.put('/invoice', async (req, res) => {
  try {
    const { invoice_prefix, invoice_next_number, default_due_days, default_notes, default_terms, financial_year_start } = req.body;

    const data = {};
    if (invoice_prefix !== undefined) {
      const prefix = String(invoice_prefix).trim().toUpperCase();
      if (!prefix) return res.status(400).json({ error: 'Invoice prefix cannot be empty' });
      data.invoice_prefix = prefix;
    }
    if (invoice_next_number !== undefined) {
      const num = parseInt(invoice_next_number);
      if (isNaN(num) || num < 1) return res.status(400).json({ error: 'Next invoice number must be a positive integer' });
      data.invoice_next_number = num;
    }
    if (default_due_days !== undefined) {
      const days = parseInt(default_due_days);
      if (isNaN(days) || days < 0) return res.status(400).json({ error: 'Due days must be 0 or more' });
      data.default_due_days = days;
    }
    if (financial_year_start !== undefined) {
      const month = parseInt(financial_year_start);
      if (isNaN(month) || month < 1 || month > 12) return res.status(400).json({ error: 'Financial year start must be 1–12' });
      data.financial_year_start = month;
    }
    if (default_notes !== undefined) data.default_notes = default_notes || null;
    if (default_terms !== undefined) data.default_terms = default_terms || null;

    const business = await prisma.business.update({
      where: { id: req.user.businessId },
      data,
      select: {
        invoice_prefix: true,
        invoice_next_number: true,
        default_due_days: true,
        default_notes: true,
        default_terms: true,
        financial_year_start: true,
      },
    });
    return res.json(business);
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
router.put('/tax', async (req, res) => {
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

// POST /api/settings/users/invite — add a staff member (Starter/Pro only)
router.post('/users/invite', async (req, res) => {
  try {
    const { name, email, password, role = 'staff' } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (!['staff', 'accountant'].includes(role)) {
      return res.status(400).json({ error: 'role must be staff or accountant' });
    }

    // Plan check — only Starter/Pro can invite team members
    const { getActivePlan } = require('../middleware/planLimit');
    const plan = await getActivePlan(req.user.businessId);
    if (plan === 'free') {
      return res.status(403).json({
        error: 'Multi-user access requires a Starter or Pro plan.',
        code: 'PLAN_LIMIT_REACHED',
      });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name, email, password_hash, role,
        business_id: req.user.businessId,
      },
      select: { id: true, name: true, email: true, role: true, created_at: true },
    });
    return res.status(201).json(user);
  } catch (err) {
    console.error('Invite user error:', err);
    return res.status(500).json({ error: 'Failed to invite user' });
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
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { password_hash, refresh_token: null }, // invalidate existing sessions
    });
    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
