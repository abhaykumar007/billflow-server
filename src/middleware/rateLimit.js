const rateLimit = require('express-rate-limit');

const make = (windowMs, limit, message, extra = {}) =>
  rateLimit({
    windowMs,
    limit,
    ...extra,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message, code: 'RATE_LIMITED' },
  });

module.exports = {
  // credential stuffing / brute force
  // only failed attempts count, so shared networks (offices, mobile carriers) are not locked out by successful logins
  loginLimiter: make(15 * 60 * 1000, 10, 'Too many login attempts. Try again in 15 minutes.', { skipSuccessfulRequests: true }),
  registerLimiter: make(60 * 60 * 1000, 10, 'Too many sign-ups from this network. Try again later.'),
  passwordResetLimiter: make(60 * 60 * 1000, 5, 'Too many reset requests. Try again later.'),
  refreshLimiter: make(15 * 60 * 1000, 120, 'Too many refresh attempts.'),
  // coarse safety net for the whole API
  apiLimiter: make(15 * 60 * 1000, 1500, 'Too many requests. Slow down.'),
};
