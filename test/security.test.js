const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { loadApp, start } = require('./helpers');

const token = (role) => jwt.sign({ userId: 'u1', businessId: 'b1', role }, process.env.JWT_SECRET, { expiresIn: '5m' });
const auth = (role) => ({ authorization: `Bearer ${token(role)}`, 'content-type': 'application/json' });

async function withApp(overrides, fn) {
  const app = loadApp(overrides);
  const srv = await start(app);
  try { await fn(srv.base); } finally { await srv.close(); }
}

test('unauthenticated requests are rejected', async () => {
  await withApp({}, async (base) => {
    for (const p of ['/api/invoices', '/api/payments', '/api/reports/outstanding', '/api/settings/business']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 401, p);
    }
  });
});

test('webhook: missing signature header is rejected (used to bypass verification)', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  let upserted = false;
  await withApp({ subscription: { upsert: async () => { upserted = true; } } }, async (base) => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', notes: { business_id: 'b1', plan: 'pro' } } } } });
    const r = await fetch(`${base}/api/subscriptions/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 400);
    assert.equal(upserted, false);
  });
});

test('webhook: wrong signature is rejected, correct signature on raw bytes is accepted', async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  await withApp({}, async (base) => {
    const body = JSON.stringify({ event: 'something.else' });
    const bad = await fetch(`${base}/api/subscriptions/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body,
    });
    assert.equal(bad.status, 400);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
    const ok = await fetch(`${base}/api/subscriptions/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body,
    });
    assert.equal(ok.status, 200);
  });
});

test('webhook: refuses everything when no webhook secret is configured', async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  await withApp({}, async (base) => {
    const r = await fetch(`${base}/api/subscriptions/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
  });
});

test('roles: staff cannot invite users, buy plans, close years or change business settings', async () => {
  await withApp({}, async (base) => {
    const cases = [
      ['POST', '/api/settings/users/invite', {}],
      ['POST', '/api/subscriptions/create-order', { plan: 'pro' }],
      ['POST', '/api/subscriptions/verify', {}],
      ['PUT', '/api/settings/business', { name: 'x' }],
      ['PUT', '/api/settings/invoice', {}],
      ['POST', '/api/financial-years', { start_year: 2026 }],
      ['PUT', '/api/financial-years/x/activate', {}],
      ['POST', '/api/financial-years/x/close', {}],
      ['PUT', '/api/financial-years/x/lock', {}],
      ['DELETE', '/api/payments/x', {}],
      ['POST', '/api/fund-transfers', {}],
    ];
    for (const [method, path, body] of cases) {
      const r = await fetch(base + path, { method, headers: auth('staff'), body: JSON.stringify(body) });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  });
});

test('roles: accountant cannot change business profile or buy plans, owner passes the role gate', async () => {
  await withApp({}, async (base) => {
    let r = await fetch(`${base}/api/settings/business`, { method: 'PUT', headers: auth('accountant'), body: JSON.stringify({ name: 'x' }) });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/subscriptions/create-order`, { method: 'POST', headers: auth('accountant'), body: JSON.stringify({ plan: 'pro' }) });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/subscriptions/create-order`, { method: 'POST', headers: auth('owner'), body: JSON.stringify({ plan: 'nope' }) });
    assert.equal(r.status, 400); // got past the role gate, failed validation
  });
});

test('login: unknown user gets a generic 401 and bad JSON gets a 400, not a 500', async () => {
  await withApp({}, async (base) => {
    let r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) });
    assert.equal(r.status, 401);
    r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(r.status, 400);
  });
});

test('register: weak password / bad email / bad GSTIN are rejected before touching the database', async () => {
  await withApp({}, async (base) => {
    const post = (b) => fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post({ name: 'A', email: 'a@b.co', password: 'short', business: { name: 'B' } })).status, 400);
    assert.equal((await post({ name: 'A', email: 'nope', password: 'longenough1', business: { name: 'B' } })).status, 400);
    assert.equal((await post({ name: 'A', email: 'a@b.co', password: 'longenough1', business: { name: 'B', gstin: '123' } })).status, 400);
  });
});

test('mobile login returns the refresh token in the body and sets no cookie; web gets a cookie', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('correct-horse', 4);
  const user = { id: 'u1', name: 'A', email: 'a@b.co', role: 'owner', business_id: 'b1', password_hash: hash,
    business: { id: 'b1', name: 'B', subscription: null, financialYears: [] } };
  const stub = {
    user: { findFirst: async () => user },
    refreshSession: { create: async () => ({}), findMany: async () => [], deleteMany: async () => ({}) },
  };
  await withApp(stub, async (base) => {
    const body = JSON.stringify({ email: 'A@B.co', password: 'correct-horse' });
    const mobile = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client': 'mobile' }, body });
    const mj = await mobile.json();
    assert.equal(mobile.status, 200);
    assert.ok(mj.refreshToken && mj.accessToken);
    assert.equal(mobile.headers.get('set-cookie'), null);

    const web = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const wj = await web.json();
    assert.equal(web.status, 200);
    assert.equal(wj.refreshToken, undefined);
    assert.match(web.headers.get('set-cookie'), /refreshToken=.*HttpOnly/i);
  });
});

test('security headers are present', async () => {
  await withApp({}, async (base) => {
    const r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});
