const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('./prisma');

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// A rotated refresh token stays valid for a few seconds so that two tabs / two
// parallel requests refreshing at once do not log each other out.
const ROTATION_GRACE_MS = 30 * 1000;
const MAX_SESSIONS_PER_USER = 10;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function isMobileClient(req) {
  return req.get('x-client') === 'mobile' || req.body?.client === 'mobile';
}

function cookieOptions() {
  const prod = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: prod,
    // Client (Vercel) and API (Render) are different sites in production,
    // so the cookie must be SameSite=None; Secure there.
    sameSite: prod ? 'none' : 'lax',
    path: '/api/auth',
  };
}

function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, { ...cookieOptions(), maxAge: REFRESH_TTL_MS });
}

function clearRefreshCookie(res) {
  res.clearCookie('refreshToken', cookieOptions());
}

function signAccessToken(user) {
  return jwt.sign(
    { userId: user.id, businessId: user.business_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Creates a new device session. Returns { accessToken, refreshToken }.
async function createSession(user, req) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const device = (req.get('x-device-name') || req.get('user-agent') || 'unknown').slice(0, 120);

  await prisma.refreshSession.deleteMany({
    where: { user_id: user.id, expires_at: { lt: new Date() } },
  });
  // cap sessions: drop the least recently used beyond the limit
  const existing = await prisma.refreshSession.findMany({
    where: { user_id: user.id },
    orderBy: { last_used_at: 'desc' },
    select: { id: true },
  });
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    await prisma.refreshSession.deleteMany({
      where: { id: { in: existing.slice(MAX_SESSIONS_PER_USER - 1).map((s) => s.id) } },
    });
  }

  await prisma.refreshSession.create({
    data: {
      user_id: user.id,
      token_hash: sha256(refreshToken),
      device,
      expires_at: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { accessToken: signAccessToken(user), refreshToken };
}

// Validates + rotates a refresh token. Returns { user, accessToken, refreshToken } or null.
async function rotateSession(rawToken, req) {
  if (!rawToken) return null;
  const hash = sha256(rawToken);
  const session = await prisma.refreshSession.findUnique({ where: { token_hash: hash } });
  if (!session || session.expires_at < new Date()) return null;

  const user = await prisma.user.findUnique({ where: { id: session.user_id } });
  if (!user) return null;

  const newToken = crypto.randomBytes(48).toString('base64url');
  await prisma.$transaction([
    prisma.refreshSession.create({
      data: {
        user_id: user.id,
        token_hash: sha256(newToken),
        device: session.device,
        expires_at: new Date(Date.now() + REFRESH_TTL_MS),
      },
    }),
    // old token: short grace window, then it dies
    prisma.refreshSession.update({
      where: { id: session.id },
      data: { expires_at: new Date(Date.now() + ROTATION_GRACE_MS), last_used_at: new Date() },
    }),
  ]);
  return { user, accessToken: signAccessToken(user), refreshToken: newToken };
}

async function revokeSession(rawToken) {
  if (!rawToken) return;
  await prisma.refreshSession.deleteMany({ where: { token_hash: sha256(rawToken) } });
}

async function revokeAllSessions(userId) {
  await prisma.refreshSession.deleteMany({ where: { user_id: userId } });
}

module.exports = {
  sha256, isMobileClient, setRefreshCookie, clearRefreshCookie,
  createSession, rotateSession, revokeSession, revokeAllSessions,
};
