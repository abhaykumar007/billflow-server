const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY = '90d';

function generateTokens(payload) {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
  return { accessToken, refreshToken };
}

// Determine the current financial year start year based on today's date
// Indian FY: April 1 → March 31
function currentFYStartYear() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  return month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

function buildFYData(startYear) {
  const start = new Date(startYear, 3, 1);
  const end   = new Date(startYear + 1, 2, 31, 23, 59, 59, 999);
  const shortEnd = String(startYear + 1).slice(2);
  const label = `FY ${startYear}-${shortEnd}`;
  return { label, start_date: start, end_date: end };
}

function formatBusinessResponse(business, activeFY) {
  return {
    id: business.id,
    name: business.name,
    address: business.address,
    city: business.city,
    state: business.state,
    pincode: business.pincode,
    gstin: business.gstin,
    pan: business.pan,
    phone: business.phone,
    email: business.email,
    logo_url: business.logo_url,
    currency: business.currency,
    invoice_prefix: business.invoice_prefix,
    financial_year_start: business.financial_year_start,
    default_due_days: business.default_due_days,
    default_notes: business.default_notes,
    default_terms: business.default_terms,
    subscription: business.subscription
      ? { plan: business.subscription.plan, status: business.subscription.status }
      : { plan: 'free', status: 'active' },
    active_financial_year: activeFY || null,
  };
}

// POST /api/auth/register
async function register(req, res) {
  try {
    const { name, email, password, phone, business, financial_year_start } = req.body;

    if (!name || !email || !password || !business?.name) {
      return res.status(400).json({ error: 'name, email, password, and business.name are required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    // Determine which FY to create (from onboarding choice or auto-detect current)
    const fyStartYear = financial_year_start
      ? parseInt(financial_year_start, 10)
      : currentFYStartYear();
    const { label, start_date, end_date } = buildFYData(fyStartYear);

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
        data: { business_id: newBusiness.id, plan: 'free', status: 'active' },
      });

      const fy = await tx.financialYear.create({
        data: {
          business_id: newBusiness.id,
          label,
          start_date,
          end_date,
          is_active: true,
        },
      });

      return { user: newUser, business: newBusiness, fy };
    });

    const { accessToken, refreshToken } = generateTokens({
      userId: result.user.id,
      businessId: result.business.id,
      role: result.user.role,
    });

    await prisma.user.update({
      where: { id: result.user.id },
      data: { refresh_token: refreshToken },
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      accessToken,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
        business: formatBusinessResponse(
          { ...result.business, subscription: { plan: 'free', status: 'active' } },
          result.fy
        ),
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
      include: {
        business: {
          include: {
            subscription: true,
            financialYears: {
              where: { is_active: true },
              take: 1,
            },
          },
        },
      },
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
      maxAge: 90 * 24 * 60 * 60 * 1000,
    });

    const activeFY = user.business.financialYears[0] || null;

    return res.json({
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        business: formatBusinessResponse(user.business, activeFY),
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
      maxAge: 90 * 24 * 60 * 60 * 1000,
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
          include: {
            subscription: true,
            financialYears: {
              where: { is_active: true },
              take: 1,
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const activeFY = user.business.financialYears[0] || null;

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      business: formatBusinessResponse(user.business, activeFY),
    });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
}

module.exports = { register, login, refresh, logout, me };
