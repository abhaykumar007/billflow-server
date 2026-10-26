const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getActivePlan, countInvoicesThisMonth, PLAN_LIMITS } = require('../middleware/planLimit');

// Razorpay is optional - if keys aren't set, payment routes return 503
function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || keyId.includes('XXXX') || !keySecret || keySecret.includes('XXXX')) return null;
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const PLAN_PRICES = { starter: 29900, pro: 59900 }; // paise
const PLAN_DAYS = 30;

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Grants (or extends) a plan for one captured payment. Idempotent: the same
// razorpay_payment_id can only ever be applied once, however many times /verify
// or the webhook fires.
async function activatePlan({ businessId, plan, paymentId, orderId, amount, source }) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.subscriptionPayment.create({
        data: {
          business_id: businessId, plan, amount,
          razorpay_order_id: orderId || null,
          razorpay_payment_id: paymentId,
          source,
        },
      });

      const current = await tx.subscription.findUnique({ where: { business_id: businessId } });
      const now = new Date();
      // renewing the same plan before it ends stacks on top of the remaining time
      const base = current && current.plan === plan && current.expires_at && current.expires_at > now
        ? current.expires_at
        : now;
      const expiresAt = new Date(base.getTime() + PLAN_DAYS * 24 * 60 * 60 * 1000);

      await tx.subscription.upsert({
        where: { business_id: businessId },
        update: { plan, status: 'active', razorpay_payment_id: paymentId, starts_at: now, expires_at: expiresAt },
        create: { business_id: businessId, plan, status: 'active', razorpay_payment_id: paymentId, starts_at: now, expires_at: expiresAt },
      });
      return { applied: true, plan, expires_at: expiresAt };
    });
  } catch (err) {
    if (err.code === 'P2002') {
      const sub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
      return { applied: false, plan: sub?.plan || plan, expires_at: sub?.expires_at || null };
    }
    throw err;
  }
}

// Reads the order from Razorpay (never trusts client/body values) and returns
// the facts we need: which business, which plan, how much.
async function loadVerifiedOrder(rzp, orderId, paymentId) {
  const order = await rzp.orders.fetch(orderId);
  const plan = order?.notes?.plan;
  const businessId = order?.notes?.business_id;
  if (!PLAN_PRICES[plan] || !businessId) throw Object.assign(new Error('Order has no plan'), { status: 400 });
  if (order.amount !== PLAN_PRICES[plan] || order.currency !== 'INR') {
    throw Object.assign(new Error('Order amount does not match plan price'), { status: 400 });
  }

  let payment = await rzp.payments.fetch(paymentId);
  if (payment.order_id !== orderId) throw Object.assign(new Error('Payment does not belong to this order'), { status: 400 });
  if (payment.status === 'authorized') {
    payment = await rzp.payments.capture(paymentId, order.amount, 'INR');
  }
  if (payment.status !== 'captured') throw Object.assign(new Error('Payment is not captured'), { status: 402 });
  return { plan, businessId, amount: order.amount };
}

// ── Webhook (no auth: Razorpay calls it). Exported and mounted in index.js with a RAW body parser.
async function handleWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const raw = req.body; // Buffer (express.raw)

  if (!secret || secret.includes('XXXX')) {
    console.error('Webhook rejected: RAZORPAY_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!signature || !Buffer.isBuffer(raw)) {
    return res.status(400).json({ error: 'Missing signature' });
  }
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqualHex(expected, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  try {
    const payment = body.payload?.payment?.entity;
    if (body.event === 'payment.captured' && payment?.order_id && payment?.id) {
      const rzp = getRazorpay();
      if (!rzp) return res.status(503).json({ error: 'Payment gateway not configured' });
      // notes live on the order; fetch it from Razorpay instead of trusting the payload's claims
      const verified = await loadVerifiedOrder(rzp, payment.order_id, payment.id);
      await activatePlan({
        businessId: verified.businessId, plan: verified.plan, paymentId: payment.id,
        orderId: payment.order_id, amount: verified.amount, source: 'webhook',
      });
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    // 5xx makes Razorpay retry; 4xx (bad data) should not be retried forever
    return res.status(err.status && err.status < 500 ? 200 : 500).json({ error: 'Webhook processing failed' });
  }
}

// ── All routes below require auth ──────────────────────────────────────────────
router.use(authenticateToken);

// GET /api/subscriptions/current
router.get('/current', async (req, res) => {
  try {
    const businessId = req.user.businessId;
    const sub = await prisma.subscription.findUnique({ where: { business_id: businessId } });
    const [plan, invoicesThisMonth] = await Promise.all([
      getActivePlan(businessId),
      countInvoicesThisMonth(businessId),
    ]);
    const expired = sub && sub.plan !== 'free' && plan === 'free';

    return res.json({
      plan,
      status: expired ? 'expired' : (sub?.status || 'active'),
      expires_at: sub?.expires_at || null,
      razorpay_payment_id: sub?.razorpay_payment_id || null,
      limits: { users: PLAN_LIMITS[plan].users },
      usage: {
        invoices_this_month: invoicesThisMonth,
        invoice_limit: Number.isFinite(PLAN_LIMITS[plan].invoicesPerMonth) ? PLAN_LIMITS[plan].invoicesPerMonth : null,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// POST /api/subscriptions/create-order  { plan: 'starter' | 'pro' }
router.post('/create-order', requireRole('owner'), async (req, res) => {
  const { plan } = req.body;
  if (!PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Choose starter or pro.' });
  }

  const rzp = getRazorpay();
  if (!rzp) {
    return res.status(503).json({ error: 'Payment gateway not configured. Add Razorpay keys to enable.' });
  }

  try {
    const order = await rzp.orders.create({
      amount: PLAN_PRICES[plan],
      currency: 'INR',
      notes: { business_id: req.user.businessId, plan },
    });

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      plan,
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    return res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// POST /api/subscriptions/verify  { order_id, payment_id, signature }
// The plan is read from the Razorpay order, NOT from the request body.
router.post('/verify', requireRole('owner'), async (req, res) => {
  const rzp = getRazorpay();
  if (!rzp) return res.status(503).json({ error: 'Payment gateway not configured' });

  const { order_id, payment_id, signature } = req.body;
  if (!order_id || !payment_id || !signature) {
    return res.status(400).json({ error: 'order_id, payment_id and signature are required' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest('hex');
  if (!safeEqualHex(expectedSignature, signature)) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  try {
    const verified = await loadVerifiedOrder(rzp, order_id, payment_id);
    if (verified.businessId !== req.user.businessId) {
      return res.status(403).json({ error: 'This payment belongs to a different business' });
    }
    const result = await activatePlan({
      businessId: verified.businessId, plan: verified.plan, paymentId: payment_id,
      orderId: order_id, amount: verified.amount, source: 'verify',
    });
    return res.json({ success: true, plan: result.plan, expires_at: result.expires_at, already_applied: !result.applied });
  } catch (err) {
    console.error('Verify error:', err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to activate subscription' });
  }
});

// POST /api/subscriptions/cancel - plan stays active until expires_at
router.post('/cancel', requireRole('owner'), async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({ where: { business_id: req.user.businessId } });
    if (!sub || sub.plan === 'free' || sub.status !== 'active') {
      return res.status(400).json({ error: 'No active paid subscription to cancel' });
    }
    await prisma.subscription.update({
      where: { business_id: req.user.businessId },
      data: { status: 'cancelled' },
    });
    return res.json({ success: true, message: 'Subscription cancelled. Access continues until expiry.', expires_at: sub.expires_at });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
module.exports.handleWebhook = handleWebhook;
