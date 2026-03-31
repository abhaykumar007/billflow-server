const express = require('express');
const router = express.Router();
const { register, login, refresh, logout, me } = require('../controllers/auth');
const { authenticateToken } = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authenticateToken, me);

module.exports = router;
