const express = require('express');
const router = express.Router();
const {
  register, login, refresh, logout, logoutAll, me, forgotPassword, resetPassword,
} = require('../controllers/auth');
const { authenticateToken } = require('../middleware/auth');
const { loginLimiter, registerLimiter, passwordResetLimiter, refreshLimiter } = require('../middleware/rateLimit');

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);
router.post('/logout-all', authenticateToken, logoutAll);
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);
router.get('/me', authenticateToken, me);

module.exports = router;
