const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_EXPIRED' });
  }
}

// Role gate. Roles: owner > accountant > staff.
//   requireRole('owner')                  owner only
//   requireRole('owner', 'accountant')    anything that changes books structure / destroys data
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'You do not have permission to do this.',
        code: 'FORBIDDEN_ROLE',
      });
    }
    next();
  };
}

const MANAGERS = ['owner', 'accountant'];

module.exports = { authenticateToken, requireRole, MANAGERS };
