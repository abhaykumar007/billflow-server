const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { authenticateToken } = require('../middleware/auth');
const { getActivePlan } = require('../middleware/planLimit');

// Razorpay is optional — if keys aren't set, payment routes return 503
function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || keyId.includes('XXXX') || !keySecret || keySecret.includes('XXXX')) return null;
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const PLAN_PRICES = { starter: 29900, pro: 59900 }; // paise

// ── All routes below require auth ──────────────────────────────────────────────
router.use(authenticateToken);

// GET /api/subscriptions/current
router.get('/current', async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { business_id: req.user.businessId },
    });

    // Invoice usage this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const invoicesThisMonth = await prisma.invoice.count({
      where: {
        business_id: req.user.businessId,
        is_deleted: false,
        status: { not: 'cancelled' },
        created_at: { gte: monthStart, lt: monthEnd },
      },
    });

    const plan = sub?.plan || 'free';
    const isExpired = plan !== 'free' && sub?.expires_at && sub.expires_at < now;

    return res.json({
      plan: isExpired ? 'free' : plan,
      status: isExpired ? 'expired' : (sub?.status || 'active'),
      expires_at: sub?.expires_at || null,
      razorpay_subscription_id: sub?.razorpay_subscription_id || null,
      usage: {
        invoices_this_month: invoicesThisMonth,
        invoice_limit: plan === 'free' && !isExpired ? 50 : null,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// POST /api/subscriptions/create-order  { plan: 'starter' | 'pro' }
// Creates a Razorpay order for one-time plan activation (30 days)
router.post('/create-order', async (req, res) => {
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
      notes: {
        business_id: req.user.businessId,
        plan,
      },
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

// POST /api/subscriptions/verify  { order_id, payment_id, signature, plan }
// Verifies Razorpay payment and upgrades plan for 30 days
router.post('/verify', async (req, res) => {
  const rzp = getRazorpay();
  if (!rzp) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  const { order_id, payment_id, signature, plan } = req.body;
  if (!order_id || !payment_id || !signature || !plan) {
    return res.status(400).json({ error: 'order_id, payment_id, signature, and plan are required' });
  }

  // Verify HMAC-SHA256 signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest('hex');

  if (expectedSignature !== signature) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await prisma.subscription.upsert({
      where: { business_id: req.user.businessId },
      update: {
        plan,
        status: 'active',
        razorpay_subscription_id: payment_id,
        starts_at: new Date(),
        expires_at: expiresAt,
      },
      create: {
        business_id: req.user.businessId,
        plan,
        status: 'active',
        razorpay_subscription_id: payment_id,
        starts_at: new Date(),
        expires_at: expiresAt,
      },
    });

    return res.json({ success: true, plan, expires_at: expiresAt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// POST /api/subscriptions/cancel
router.post('/cancel', async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { business_id: req.user.businessId },
    });
    if (!sub || sub.plan === 'free') {
      return res.status(400).json({ error: 'No active paid subscription to cancel' });
    }

    await prisma.subscription.update({
      where: { business_id: req.user.businessId },
      data: { status: 'cancelled' },
    });

    return res.json({ success: true, message: 'Subscription cancelled. Access continues until expiry.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// POST /api/subscriptions/webhook  (no auth — Razorpay calls this directly)
// Must be registered BEFORE router.use(authenticateToken)
module.exports = router;

// Separate webhook handler — exported for use in index.js
async function handleWebhook(req, res) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const body = JSON.stringify(req.body);

  if (secret && !secret.includes('XXXX') && signature) {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }
  }

  const event = req.body.event;
  const payload = req.body.payload?.payment?.entity;

  try {
    if (event === 'payment.captured' && payload?.notes?.business_id && payload?.notes?.plan) {
      const { business_id, plan } = payload.notes;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await prisma.subscription.upsert({
        where: { business_id },
        update: { plan, status: 'active', starts_at: new Date(), expires_at: expiresAt },
        create: { business_id, plan, status: 'active', starts_at: new Date(), expires_at: expiresAt },
      });
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

module.exports.handleWebhook = handleWebhook;
