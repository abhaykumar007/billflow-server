const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

function generateTokens(payload) {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
  return { accessToken, refreshToken };
}

// POST /api/auth/register
async function register(req, res) {
  try {
    const { name, email, password, phone, business } = req.body;

    if (!name || !email || !password || !business?.name) {
      return res.status(400).json({ error: 'name, email, password, and business.name are required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    // Create business + user + free subscription in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const newBusiness = await tx.business.create({
        data: {
          name: business.name,
          address: business.address,
          city: business.city,
          state: business.state,
          pincode: business.pincode,
          gstin: business.gstin,
          phone: business.phone || phone,
          email: business.email || email,
        },
      });

      const newUser = await tx.user.create({
        data: {
          name,
          email,
          password_hash,
          phone,
          role: 'owner',
          business_id: newBusiness.id,
        },
      });

      await tx.subscription.create({
        data: {
          business_id: newBusiness.id,
          plan: 'free',
          status: 'active',
        },
      });

      // Update business owner reference isn't needed since User has business_id
      return { user: newUser, business: newBusiness };
    });

    const { accessToken, refreshToken } = generateTokens({
      userId: result.user.id,
      businessId: result.business.id,
      role: result.user.role,
    });

    // Store refresh token in DB
    await prisma.user.update({
      where: { id: result.user.id },
      data: { refresh_token: refreshToken },
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(201).json({
      accessToken,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
        business: {
          id: result.business.id,
          name: result.business.name,
          address: result.business.address,
          city: result.business.city,
          state: result.business.state,
          pincode: result.business.pincode,
          gstin: result.business.gstin,
          phone: result.business.phone,
          email: result.business.email,
          invoice_prefix: result.business.invoice_prefix,
          financial_year_start: result.business.financial_year_start,
          default_due_days: result.business.default_due_days,
          default_notes: result.business.default_notes,
          default_terms: result.business.default_terms,
        },
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    const message = process.env.NODE_ENV === 'development'
      ? `Registration failed: ${err.message}`
      : 'Registration failed. Please try again.';
    return res.status(500).json({ error: message });
  }
}

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { business: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { accessToken, refreshToken } = generateTokens({
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { refresh_token: refreshToken },
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        business: {
          id: user.business.id,
          name: user.business.name,
          address: user.business.address,
          city: user.business.city,
          state: user.business.state,
          pincode: user.business.pincode,
          gstin: user.business.gstin,
          phone: user.business.phone,
          email: user.business.email,
          invoice_prefix: user.business.invoice_prefix,
          financial_year_start: user.business.financial_year_start,
          default_due_days: user.business.default_due_days,
          default_notes: user.business.default_notes,
          default_terms: user.business.default_terms,
        },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

// POST /api/auth/refresh
async function refresh(req, res) {
  try {
    const token = req.cookies.refreshToken;

    if (!token) {
      return res.status(401).json({ error: 'Refresh token missing' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || user.refresh_token !== token) {
      return res.status(401).json({ error: 'Refresh token revoked' });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens({
      userId: user.id,
      businessId: user.business_id,
      role: user.role,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { refresh_token: newRefreshToken },
    });

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ accessToken });
  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  try {
    const token = req.cookies.refreshToken;
    if (token) {
      // Clear refresh token from DB
      await prisma.user.updateMany({
        where: { refresh_token: token },
        data: { refresh_token: null },
      });
    }
    res.clearCookie('refreshToken');
    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
}

// GET /api/auth/me
async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        business: {
          include: { subscription: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      business: {
        id: user.business.id,
        name: user.business.name,
        address: user.business.address,
        city: user.business.city,
        state: user.business.state,
        pincode: user.business.pincode,
        gstin: user.business.gstin,
        pan: user.business.pan,
        phone: user.business.phone,
        email: user.business.email,
        logo_url: user.business.logo_url,
        currency: user.business.currency,
        invoice_prefix: user.business.invoice_prefix,
        financial_year_start: user.business.financial_year_start,
        default_due_days: user.business.default_due_days,
        default_notes: user.business.default_notes,
        default_terms: user.business.default_terms,
        subscription: user.business.subscription
          ? { plan: user.business.subscription.plan, status: user.business.subscription.status }
          : { plan: 'free', status: 'active' },
      },
    });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
}

module.exports = { register, login, refresh, logout, me };
