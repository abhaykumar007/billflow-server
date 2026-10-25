// Loads .env.development locally; on Render, NODE_ENV=production and env vars are injected directly — no file needed
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'development'}` });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { apiLimiter } = require('./middleware/rateLimit');
const { HttpError } = require('./utils/httpError');

const authRoutes = require('./routes/auth');
const financialYearsRoutes = require('./routes/financialYears');
const settingsRoutes = require('./routes/settings');
const dashboardRoutes = require('./routes/dashboard');
const customersRoutes = require('./routes/customers');
const suppliersRoutes = require('./routes/suppliers');
const productsRoutes = require('./routes/products');
const productCategoriesRoutes = require('./routes/product-categories');
const invoicesRoutes = require('./routes/invoices');
const paymentsRoutes = require('./routes/payments');
const ledgerRoutes = require('./routes/ledger');
const reportsRoutes = require('./routes/reports');
const expensesRoutes = require('./routes/expenses');
const bankAccountsRoutes = require('./routes/bank-accounts');
const fundTransfersRoutes = require('./routes/fund-transfers');
const subscriptionsRoutes = require('./routes/subscriptions');
const { handleWebhook } = require('./routes/subscriptions');

const app = express();
// Render / Vercel sit behind a proxy: needed for correct client IPs (rate limiting)
app.set('trust proxy', 1);
app.use(helmet());

// CLIENT_URL may hold several comma-separated origins (web app, preview deploys, ...)
const allowedOrigins = [
  ...(process.env.CLIENT_URL || '').split(',').map((o) => o.trim()),
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
// Razorpay webhook needs the RAW body to verify its signature, so it is mounted
// before express.json() parses (and destroys) the original bytes.
app.post('/api/subscriptions/webhook', express.raw({ type: '*/*', limit: '1mb' }), handleWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', apiLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/financial-years', financialYearsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/product-categories', productCategoriesRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/bank-accounts', bankAccountsRoutes);
app.use('/api/fund-transfers', fundTransfersRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler: no stack traces / internals leak to clients
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err?.code === 'P2002') return res.status(409).json({ error: 'A record with these details already exists', code: 'DUPLICATE' });
  if (err?.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
  if (err?.message?.startsWith('CORS:')) return res.status(403).json({ error: err.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('RAZORPAY_WEBHOOK_SECRET is not set: subscription webhooks will be rejected.');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BillFlow server running on port ${PORT}`);
  });
}
