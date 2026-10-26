const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { sendMail } = require('../utils/mailer');
const {
  sha256, isMobileClient, setRefreshCookie, clearRefreshCookie,
  createSession, rotateSession, revokeSession, revokeAllSessions,
} = require('../utils/session');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();

// Mobile clients get the refresh token in the JSON body (stored in secure storage);
// browsers get it as an httpOnly cookie.
function deliverSession(req, res, { accessToken, refreshToken }) {
  if (isMobileClient(req)) return { accessToken, refreshToken };
  setRefreshCookie(res, refreshToken);
  return { accessToken };
}

// Determine the current financial year start year based on today's date
// Indian FY: April 1 -> March 31 (computed in IST, explicit UTC dates)
function currentFYStartYear() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const month = ist.getUTCMonth() + 1; // 1-12
  return month >= 4 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
}

function buildFYData(startYear) {
  const start = new Date(Date.UTC(startYear, 3, 1));
  const end   = new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999));
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
    const { name, password, phone, business, financial_year_start } = req.body;
    const email = normEmail(req.body.email);

    if (!name || !email || !password || !business?.name) {
      return res.status(400).json({ error: 'name, email, password, and business.name are required' });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (business.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(business.gstin).trim().toUpperCase())) {
      return res.status(400).json({ error: 'Enter a valid 15-character GSTIN' });
    }

    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(String(password), 12);

    // Determine which FY to create (from onboarding choice or auto-detect current)
    const fyStartYear = financial_year_start
      ? parseInt(financial_year_start, 10)
      : currentFYStartYear();
    if (!Number.isInteger(fyStartYear) || fyStartYear < 2000 || fyStartYear > 2100) {
      return res.status(400).json({ error: 'financial_year_start must be a year between 2000 and 2100' });
    }
    const { label, start_date, end_date } = buildFYData(fyStartYear);

    const result = await prisma.$transaction(async (tx) => {
      const newBusiness = await tx.business.create({
        data: {
          name: String(business.name).trim(),
          address: business.address,
          city: business.city,
          state: business.state,
          pincode: business.pincode,
          gstin: business.gstin ? String(business.gstin).trim().toUpperCase() : null,
          phone: business.phone || phone,
          email: business.email || email,
        },
      });

      const newUser = await tx.user.create({
        data: {
          name: String(name).trim(),
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

    const tokens = deliverSession(req, res, await createSession(result.user, req));

    return res.status(201).json({
      ...tokens,
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
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already registered' });
    const message = process.env.NODE_ENV === 'development'
      ? `Registration failed: ${err.message}`
      : 'Registration failed. Please try again.';
    return res.status(500).json({ error: message });
  }
}

const userInclude = {
  business: {
    include: {
      subscription: true,
      financialYears: { where: { is_active: true }, take: 1 },
    },
  },
};

// POST /api/auth/login
async function login(req, res) {
  try {
    const { password } = req.body;
    const email = normEmail(req.body.email);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: userInclude,
    });

    // Always run a bcrypt compare so response time does not reveal whether the email exists
    const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5Qq0o8zA8eV2bV1Yb1k3x0pQ3m8w9sK';
    const valid = await bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const tokens = deliverSession(req, res, await createSession(user, req));
    const activeFY = user.business.financialYears[0] || null;

    return res.json({
      ...tokens,
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

// POST /api/auth/refresh  (cookie for web, { refreshToken } body for mobile)
async function refresh(req, res) {
  try {
    const raw = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!raw) return res.status(401).json({ error: 'Refresh token missing' });

    const rotated = await rotateSession(raw, req);
    if (!rotated) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const tokens = deliverSession(req, res, rotated);
    return res.json(tokens);
  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  try {
    await revokeSession(req.cookies?.refreshToken || req.body?.refreshToken);
    clearRefreshCookie(res);
    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
}

// POST /api/auth/logout-all  (authenticated) - sign out every device
async function logoutAll(req, res) {
  try {
    await revokeAllSessions(req.user.userId);
    clearRefreshCookie(res);
    return res.json({ message: 'Signed out of all devices' });
  } catch (err) {
    console.error('Logout-all error:', err);
    return res.status(500).json({ error: 'Failed to sign out' });
  }
}

// GET /api/auth/me
async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: userInclude,
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

// POST /api/auth/forgot-password  { email }
// Always answers 200 so it cannot be used to discover which emails are registered.
async function forgotPassword(req, res) {
  const generic = { message: 'If that email is registered, a reset link has been sent.' };
  try {
    const email = normEmail(req.body.email);
    if (!EMAIL_RE.test(email)) return res.json(generic);

    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) return res.json(generic);

    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({
      data: {
        user_id: user.id,
        token_hash: sha256(token),
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const base = process.env.RESET_URL_BASE || `${(process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim()}/reset-password`;
    await sendMail({
      to: user.email,
      subject: 'Reset your BillFlow password',
      text: `Use this link to set a new password (valid for 30 minutes):\n\n${base}?token=${token}\n\nIf you did not ask for this, ignore this email.`,
    });
    return res.json(generic);
  } catch (err) {
    console.error('Forgot-password error:', err);
    return res.json(generic);
  }
}

// POST /api/auth/reset-password  { token, new_password }
async function resetPassword(req, res) {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'token and new_password are required' });
    if (String(new_password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const record = await prisma.passwordResetToken.findUnique({ where: { token_hash: sha256(String(token)) } });
    if (!record || record.used_at || record.expires_at < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const password_hash = await bcrypt.hash(String(new_password), 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.user_id }, data: { password_hash } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { used_at: new Date() } }),
      prisma.refreshSession.deleteMany({ where: { user_id: record.user_id } }),
    ]);
    return res.json({ message: 'Password updated. Please log in.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
}

module.exports = { register, login, refresh, logout, logoutAll, me, forgotPassword, resetPassword };
