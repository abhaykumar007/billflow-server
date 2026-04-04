require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const dashboardRoutes = require('./routes/dashboard');
const customersRoutes = require('./routes/customers');
const productsRoutes = require('./routes/products');
const invoicesRoutes = require('./routes/invoices');
const paymentsRoutes = require('./routes/payments');
const ledgerRoutes = require('./routes/ledger');
const reportsRoutes = require('./routes/reports');
const subscriptionsRoutes = require('./routes/subscriptions');
const { handleWebhook } = require('./routes/subscriptions');

const app = express();

const allowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/reports', reportsRoutes);
// Webhook must be before the auth-protected subscriptions router
app.post('/api/subscriptions/webhook', handleWebhook);
app.use('/api/subscriptions', subscriptionsRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`BillFlow server running on port ${PORT}`);
});
