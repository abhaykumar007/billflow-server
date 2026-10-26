// API break-it suite. Registers its own accounts and data, so it can run against any server.
// Usage: API=https://your-server node scripts/api-suite.mjs   (local: UPGRADE=1 also puts the account on the Pro plan)
// Staff-role checks need a paid plan and are expected to fail against a free-plan production account.
// API break-it battery for billflow-server. Usage: node fuzz.mjs  (server on :5000, QA + web accounts exist)
const B = (process.env.API || 'http://localhost:5000') + '/api';
const RUN = Date.now().toString(36);
const QAE = `suite.a.${RUN}@test.local`, QAP = 'SuiteA#2026x';
const WEBE = `suite.b.${RUN}@test.local`, WEBP = 'SuiteB#2026x';
const STAFFE = `staff.${RUN}@test.local`, STAFFE2 = `staff2.${RUN}@test.local`;
const log = [];
async function call(method, path, { token, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let r;
  try {
    r = await fetch(B + path, { method, headers: h, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  } catch (e) { return { status: 'NETERR', data: e.message }; }
  let data; const t = await r.text();
  try { data = JSON.parse(t); } catch { data = t.slice(0, 200); }
  return { status: r.status, data };
}
const login = async (e, p) => (await call('POST', '/auth/login', { body: { email: e, password: p }, headers: { 'x-client': 'mobile' } })).data;
async function reg(email, password, name) {
  const r = await call('POST', '/auth/register', { body: { name, email, password, business: { name: name + ' Traders', state: 'Maharashtra' }, client: 'mobile' }, headers: { 'x-client': 'mobile' } });
  if (!r.data?.accessToken) throw new Error('register failed ' + r.status + ' ' + JSON.stringify(r.data));
  return r.data.accessToken;
}
const qa = await reg(QAE, QAP, 'Suite A');
const web = await reg(WEBE, WEBP, 'Suite B');
const seedC = (await call('POST', '/customers', { token: qa, body: { name: 'Seed Customer', phone: '9876500099', state: 'Maharashtra' } })).data;
const seedP = (await call('POST', '/products', { token: qa, body: { name: 'Seed Product', sale_price: 100, tax_rate: 18 } })).data;
await call('POST', '/bank-accounts', { token: qa, body: { account_name: 'Seed Bank', opening_balance: 500 } });
await call('POST', '/invoices', { token: qa, body: { voucher_type: 'SALE', customer_id: seedC.id, status: 'sent', items: [{ product_id: seedP.id, description: 'Seed', quantity: 1, rate: 10000, tax_rate: 18 }] } });
function rec(name, expect, res) {
  log.push({ name, expect: expect.join('/'), got: res.status, ok: expect.includes(res.status), msg: (res.data?.error || '').toString().slice(0, 90) });
}
// ---- AUTH
rec('login wrong password', [401], await call('POST', '/auth/login', { body: { email: QAE, password: 'nope' } }));
rec('login unknown email', [401], await call('POST', '/auth/login', { body: { email: 'ghost@x.com', password: 'x' } }));
rec('login empty body', [400], await call('POST', '/auth/login', { body: {} }));
rec('login SQLi email', [400, 401], await call('POST', '/auth/login', { body: { email: "' OR 1=1 --", password: 'x' } }));
rec('login email as object', [400, 401], await call('POST', '/auth/login', { body: { email: { contains: '' }, password: 'x' } }));
rec('login password as array', [400, 401], await call('POST', '/auth/login', { body: { email: QAE, password: ['a'] } }));
rec('login 100k char password', [400, 401, 413], await call('POST', '/auth/login', { body: { email: QAE, password: 'a'.repeat(100000) } }));
rec('login malformed JSON', [400], await call('POST', '/auth/login', { body: '{bad json' }));
rec('register duplicate email', [409], await call('POST', '/auth/register', { body: { name: 'x', email: QAE, password: 'Password1!', business: { name: 'B' } } }));
rec('register short password', [400], await call('POST', '/auth/register', { body: { name: 'x', email: 'short@test.local', password: '123', business: { name: 'B' } } }));
rec('register bad email', [400], await call('POST', '/auth/register', { body: { name: 'x', email: 'notanemail', password: 'Password1!', business: { name: 'B' } } }));
rec('register no business', [400], await call('POST', '/auth/register', { body: { name: 'x', email: 'nb@test.local', password: 'Password1!' } }));
rec('register email case dup', [409], await call('POST', '/auth/register', { body: { name: 'x', email: QAE.toUpperCase(), password: 'Password1!', business: { name: 'B' } } }));
rec('login uppercase email', [200], await call('POST', '/auth/login', { body: { email: QAE.toUpperCase(), password: QAP } }));
rec('no token', [401], await call('GET', '/customers'));
rec('garbage token', [401], await call('GET', '/customers', { token: 'abc.def.ghi' }));
const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ userId: 'x', businessId: 'x', role: 'owner' })).toString('base64url') + '.';
rec('alg=none JWT', [401], await call('GET', '/customers', { token: none }));
rec('refresh with junk', [401], await call('POST', '/auth/refresh', { body: { refreshToken: 'junk' }, headers: { 'x-client': 'mobile' } }));
rec('forgot-password unknown email (no enumeration)', [200], await call('POST', '/auth/forgot-password', { body: { email: 'ghost@x.com' } }));
rec('reset-password bad token', [400, 401, 404], await call('POST', '/auth/reset-password', { body: { token: 'bad', password: 'NewPass#123' } }));
// ---- TENANT ISOLATION
const qaInv = (await call('GET', '/invoices', { token: qa })).data.invoices;
const qaCust = (await call('GET', '/customers', { token: qa })).data.customers[0];
const qaProd = (await call('GET', '/products', { token: qa })).data.products[0];
const qaBank = (await call('GET', '/bank-accounts', { token: qa })).data[0];
rec('IDOR read other tenant invoice', [404, 403], await call('GET', '/invoices/' + qaInv[0].id, { token: web }));
rec('IDOR read other tenant customer', [404, 403], await call('GET', '/customers/' + qaCust.id, { token: web }));
rec('IDOR edit other tenant customer', [404, 403], await call('PUT', '/customers/' + qaCust.id, { token: web, body: { name: 'hacked' } }));
rec('IDOR delete other tenant product', [404, 403], await call('DELETE', '/products/' + qaProd.id, { token: web }));
rec('IDOR cancel other tenant invoice', [404, 403], await call('DELETE', '/invoices/' + qaInv[0].id, { token: web }));
rec('IDOR bank txns other tenant', [404, 403], await call('GET', '/bank-accounts/' + qaBank.id + '/transactions', { token: web }));
rec('IDOR ledger other tenant customer', [404, 403], await call('GET', '/ledger/customers/' + qaCust.id, { token: web }));
const fyHdr = await call('GET', '/invoices', { token: web, headers: { 'x-financial-year-id': 'cmvp9yqjp000pquklpqmrl8vm' } });
rec('foreign FY header returns no foreign data', [200, 400, 403, 404], fyHdr);
const wc = (await call('POST', '/customers', { token: web, body: { name: 'Fuzz Cust', phone: '9876500001', state: 'Maharashtra' } })).data;
const wp = (await call('POST', '/products', { token: web, body: { name: 'Fuzz Item', unit: 'pcs', sale_price: 10000, purchase_price: 5000, tax_rate: 18, track_inventory: true, stock_quantity: 5 } })).data;
rec('invoice with other tenant customer', [400, 404], await call('POST', '/invoices', { token: web, body: { voucher_type: 'SALE', customer_id: qaCust.id, items: [{ description: 'x', quantity: 1, rate: 100, tax_rate: 18 }] } }));
rec('invoice with other tenant product', [400, 404], await call('POST', '/invoices', { token: web, body: { voucher_type: 'SALE', customer_id: wc.id, items: [{ product_id: qaProd.id, description: 'x', quantity: 1, rate: 100, tax_rate: 18 }] } }));
// ---- INVOICE validation
const inv = (over = {}, item = {}) => ({ voucher_type: 'SALE', customer_id: wc.id, status: 'sent', items: [{ product_id: wp.id, description: 'Fuzz Item', quantity: 1, unit: 'pcs', rate: 10000, tax_rate: 18, ...item }], ...over });
rec('invoice happy', [201], await call('POST', '/invoices', { token: web, body: inv() }));
rec('invoice qty 0', [400], await call('POST', '/invoices', { token: web, body: inv({}, { quantity: 0 }) }));
rec('invoice qty negative', [400], await call('POST', '/invoices', { token: web, body: inv({}, { quantity: -5 }) }));
rec('invoice rate negative', [400], await call('POST', '/invoices', { token: web, body: inv({}, { rate: -100 }) }));
rec('invoice qty string', [400], await call('POST', '/invoices', { token: web, body: inv({}, { quantity: 'abc' }) }));
rec('invoice rate with paise 100.55 (rupees API) accepted', [201], await call('POST', '/invoices', { token: web, body: inv({}, { rate: 100.55 }) }));
rec('invoice rate with 3 decimals 100.555', [201, 400], await call('POST', '/invoices', { token: web, body: inv({}, { rate: 100.555 }) }));
rec('invoice discount 150%', [400], await call('POST', '/invoices', { token: web, body: inv({}, { discount_percent: 150 }) }));
rec('invoice discount negative', [400], await call('POST', '/invoices', { token: web, body: inv({}, { discount_percent: -10 }) }));
rec('invoice tax_rate 99 (any 0-100 accepted by design)', [201, 400], await call('POST', '/invoices', { token: web, body: inv({}, { tax_rate: 99 }) }));
rec('invoice no items', [400], await call('POST', '/invoices', { token: web, body: inv({ items: [] }) }));
rec('invoice items not array', [400], await call('POST', '/invoices', { token: web, body: inv({ items: 'x' }) }));
rec('invoice no customer (sale)', [400], await call('POST', '/invoices', { token: web, body: inv({ customer_id: undefined }) }));
rec('invoice bad voucher_type', [400], await call('POST', '/invoices', { token: web, body: inv({ voucher_type: 'HACK' }) }));
rec('invoice huge qty 1e15', [400], await call('POST', '/invoices', { token: web, body: inv({}, { quantity: 1e15 }) }));
rec('invoice rate 1e12 paise', [400], await call('POST', '/invoices', { token: web, body: inv({}, { rate: 1e12 }) }));
rec('invoice due before date', [400], await call('POST', '/invoices', { token: web, body: inv({ invoice_date: '2026-10-20', due_date: '2026-10-01' }) }));
rec('invoice bad date', [400], await call('POST', '/invoices', { token: web, body: inv({ invoice_date: '32-13-2026' }) }));
rec('invoice date outside FY (2020)', [400], await call('POST', '/invoices', { token: web, body: inv({ invoice_date: '2020-01-01' }) }));
const tamper = await call('POST', '/invoices', { token: web, body: inv({ total_amount: 1, balance_due: 0, status: 'sent', amount_paid: 999999 }) });
rec('invoice tamper (client-sent totals ignored)', [201], tamper);
log.push({ name: 'tampered invoice total recalculated server-side', expect: 11800, got: tamper.data?.total_amount, ok: tamper.data?.total_amount === 11800, msg: '' });
rec('invoice oversell stock qty 9999', [201, 400], await call('POST', '/invoices', { token: web, body: inv({}, { quantity: 9999 }) }));
rec('invoice description 100k chars (bounded by 100kB body)', [201, 400, 413], await call('POST', '/invoices', { token: web, body: inv({}, { description: 'x'.repeat(100000) }) }));
rec('invoice 500 line items', [201, 400, 413], await call('POST', '/invoices', { token: web, body: inv({ items: Array.from({ length: 500 }, () => ({ description: 'l', quantity: 1, rate: 100, tax_rate: 5 })) }) }));
const k = 'fuzz-idem-key-' + Date.now();
const i1 = await call('POST', '/invoices', { token: web, body: inv(), headers: { 'Idempotency-Key': k } });
const i2 = await call('POST', '/invoices', { token: web, body: inv(), headers: { 'Idempotency-Key': k } });
rec('idempotency first', [201], i1);
log.push({ name: 'idempotency replay returns same invoice', expect: 'same id', got: i1.data?.id === i2.data?.id ? 'same' : 'DIFFERENT', ok: i1.data?.id === i2.data?.id, msg: 'replay status ' + i2.status });
rec('idempotency key too short', [400], await call('POST', '/invoices', { token: web, body: inv(), headers: { 'Idempotency-Key': 'ab' } }));
// ---- PAYMENTS
const sent = (await call('POST', '/invoices', { token: web, body: inv() })).data;
sent.balance_due = sent.balance_due ?? sent.total_amount;
rec('payment overpay', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: sent.balance_due + 1, payment_mode: 'cash' } }));
rec('payment zero', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 0, payment_mode: 'cash' } }));
rec('payment negative', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: -100, payment_mode: 'cash' } }));
rec('payment bad mode', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 100, payment_mode: 'bitcoin' } }));
rec('payment 3 decimals 10.555', [201, 400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 10.555, payment_mode: 'cash' } }));
rec('payment on other tenant invoice', [400, 404], await call('POST', '/payments', { token: web, body: { invoice_id: qaInv[0].id, amount: 100, payment_mode: 'cash' } }));
rec('payment future date', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 100, payment_mode: 'cash', payment_date: '2030-01-01' } }));
const cur = (await call('GET', '/invoices/' + sent.id, { token: web })).data;
const pay = await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: cur.balance_due, payment_mode: 'cash' } });
rec('payment full happy', [201], pay);
rec('payment on already-paid invoice', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 100, payment_mode: 'cash' } }));
const pid = pay.data?.id || pay.data?.payment?.id;
rec('reverse payment', [200], await call('DELETE', '/payments/' + pid, { token: web }));
rec('reverse payment twice', [400, 404, 409], await call('DELETE', '/payments/' + pid, { token: web }));
rec('cancel invoice', [200], await call('DELETE', '/invoices/' + sent.id, { token: web }));
rec('cancel invoice twice', [400, 404, 409], await call('DELETE', '/invoices/' + sent.id, { token: web }));
rec('edit cancelled invoice', [400, 403, 404, 409], await call('PUT', '/invoices/' + sent.id, { token: web, body: inv() }));
rec('pay cancelled invoice', [400], await call('POST', '/payments', { token: web, body: { invoice_id: sent.id, amount: 100, payment_mode: 'cash' } }));
// ---- products / customers
rec('product negative price', [400], await call('POST', '/products', { token: web, body: { name: 'Neg', sale_price: -1 } }));
rec('product empty name', [400], await call('POST', '/products', { token: web, body: { name: '  ', sale_price: 100 } }));
rec('product gst 17 (any 0-100 accepted by design)', [201, 400, 409], await call('POST', '/products', { token: web, body: { name: 'G17', sale_price: 100, tax_rate: 17 } }));
rec('product name 10k chars (truncated to 150)', [201, 400, 413], await call('POST', '/products', { token: web, body: { name: 'n'.repeat(10000), sale_price: 100 } }));
rec('product duplicate name', [201, 409], await call('POST', '/products', { token: web, body: { name: 'Fuzz Item', sale_price: 100 } }));
rec('customer bad pincode', [400], await call('POST', '/customers', { token: web, body: { name: 'P', pincode: '12' } }));
rec('customer bad email', [400], await call('POST', '/customers', { token: web, body: { name: 'P', email: 'x@' } }));
rec('customer bad state', [400, 201], await call('POST', '/customers', { token: web, body: { name: 'P', state: 'Narnia' } }));
rec('customer negative credit limit', [400], await call('POST', '/customers', { token: web, body: { name: 'P', credit_limit: -5 } }));
rec('customer name only spaces', [400], await call('POST', '/customers', { token: web, body: { name: '    ' } }));
rec('delete customer with invoices', [400], await call('DELETE', '/customers/' + wc.id, { token: web }));
rec('customer page=-1 limit=999999', [200, 400], await call('GET', '/customers?page=-1&limit=999999', { token: web }));
rec('customer search SQLi', [200], await call('GET', '/customers?search=' + encodeURIComponent("'; DROP TABLE \"Customer\";--"), { token: web }));
rec('customer id not found', [404], await call('GET', '/customers/doesnotexist', { token: web }));
// ---- expenses / banks
rec('expense negative', [400], await call('POST', '/expenses', { token: web, body: { category: 'Rent', amount: -5, payment_mode: 'cash' } }));
rec('expense zero', [400], await call('POST', '/expenses', { token: web, body: { category: 'Rent', amount: 0, payment_mode: 'cash' } }));
rec('expense no category', [400], await call('POST', '/expenses', { token: web, body: { amount: 100, payment_mode: 'cash' } }));
rec('expense other tenant bank', [400, 404], await call('POST', '/expenses', { token: web, body: { category: 'Rent', amount: 100, payment_mode: 'bank', bank_account_id: qaBank.id } }));
const b1 = (await call('POST', '/bank-accounts', { token: web, body: { account_name: 'FA', opening_balance: 100000 } })).data;
const b2 = (await call('POST', '/bank-accounts', { token: web, body: { account_name: 'FB', opening_balance: 0 } })).data;
rec('bank bad IFSC', [400], await call('POST', '/bank-accounts', { token: web, body: { account_name: 'X', ifsc_code: '123' } }));
rec('bank negative opening', [400], await call('POST', '/bank-accounts', { token: web, body: { account_name: 'X', opening_balance: -5 } }));
rec('transfer same account', [400], await call('POST', '/fund-transfers', { token: web, body: { from_account_id: b1.id, to_account_id: b1.id, amount: 100 } }));
rec('transfer more than balance', [400], await call('POST', '/fund-transfers', { token: web, body: { from_account_id: b1.id, to_account_id: b2.id, amount: 999999999 } }));
rec('transfer negative', [400], await call('POST', '/fund-transfers', { token: web, body: { from_account_id: b1.id, to_account_id: b2.id, amount: -5 } }));
rec('transfer to other tenant account', [400, 404], await call('POST', '/fund-transfers', { token: web, body: { from_account_id: b1.id, to_account_id: qaBank.id, amount: 100 } }));
rec('delete bank with balance', [400, 409], await call('DELETE', '/bank-accounts/' + b1.id, { token: web }));
// ---- settings / users / FY
rec('settings invoice prefix 100 chars', [400], await call('PUT', '/settings/invoice', { token: web, body: { invoice_prefix: 'X'.repeat(100) } }));
rec('settings tax rate 17 (any 0-100 accepted by design)', [200, 400], await call('PUT', '/settings/tax', { token: web, body: { default_tax_rate: 17 } }));
rec('change password wrong current', [400, 401, 403], await call('PUT', '/settings/password', { token: web, body: { current_password: 'wrong', new_password: 'NewPass#123' } }));
rec('change password too short', [400], await call('PUT', '/settings/password', { token: web, body: { current_password: WEBP, new_password: '1' } }));
rec('invite user weak password', [400], await call('POST', '/settings/users/invite', { token: web, body: { name: 'S', email: 'staff1@test.local', password: '1', role: 'staff' } }));
rec('invite user bad role', [400], await call('POST', '/settings/users/invite', { token: web, body: { name: 'S', email: 'staff2@test.local', password: 'StaffPass#1', role: 'superadmin' } }));
if (process.env.UPGRADE) (await import('node:child_process')).execSync('node scripts/upgrade-test-plan.cjs ' + WEBE, { stdio: 'inherit' });
const st = await call('POST', '/settings/users/invite', { token: web, body: { name: 'Staffer', email: STAFFE, password: 'StaffPass#1', role: 'staff' } });
rec('invite staff', [201], st);
const stTok = (await login(STAFFE, 'StaffPass#1')).accessToken;
rec('staff cannot invite users', [403], await call('POST', '/settings/users/invite', { token: stTok, body: { name: 'S', email: STAFFE2, password: 'StaffPass#1', role: 'owner' } }));
rec('staff cannot edit business', [403], await call('PUT', '/settings/business', { token: stTok, body: { name: 'Pwned' } }));
rec('staff cannot close FY', [403], await call('POST', '/financial-years/x/close', { token: stTok, body: {} }));
rec('staff cannot change roles', [403], await call('PUT', '/settings/users/' + (st.data?.id || st.data?.user?.id) + '/role', { token: stTok, body: { role: 'owner' } }));
rec('invite duplicate email', [409, 400], await call('POST', '/settings/users/invite', { token: web, body: { name: 'S', email: STAFFE, password: 'StaffPass#1', role: 'staff' } }));
rec('FY create bad year', [400], await call('POST', '/financial-years', { token: web, body: { start_year: 1800 } }));
rec('FY create string year', [400], await call('POST', '/financial-years', { token: web, body: { start_year: 'abc' } }));
rec('FY duplicate', [400, 409], await call('POST', '/financial-years', { token: web, body: { start_year: 2026 } }));
// ---- reports
for (const q of ['sales-summary?from=2026-12-31&to=2026-01-01', 'sales-summary?from=garbage&to=garbage', 'day-book?date=2026-02-30', 'low-stock?threshold=-1', 'low-stock?threshold=abc', 'stock-detail', 'party-statement?partyId=x&partyType=hacker', 'gstr9?financialYearId=nope', 'balance-sheet?asOf=bad'])
  rec('report ' + q, [400, 404], await call('GET', '/reports/' + q, { token: web }));
for (const q of ['sales-summary?from=2026-04-01&to=2026-10-26', 'day-book?date=2026-10-26', 'balance-sheet?asOf=2026-10-26', 'low-stock?threshold=5', 'cash-flow', 'trial-balance?from=2026-04-01&to=2026-10-26'])
  rec('report VALID ' + q, [200], await call('GET', '/reports/' + q, { token: web }));
// ---- misc
rec('unknown route', [404], await call('GET', '/nope', { token: web }));
rec('wrong method', [404, 405], await call('PATCH', '/customers', { token: web, body: {} }));
rec('body 5MB', [400, 413], await call('POST', '/customers', { token: web, body: { name: 'x'.repeat(5 * 1024 * 1024) } }));
// ---- financial year close (last: it ends the account's ability to post today)
const fys = (await call('GET', '/financial-years', { token: web })).data;
const activeFy = fys.find((f) => f.is_active);
rec('close FY before it ends is refused (FY_NOT_ENDED)', [409], await call('POST', '/financial-years/' + activeFy.id + '/close', { token: web, body: { force: true } }));
rec('close FY early with explicit confirmation', [200], await call('POST', '/financial-years/' + activeFy.id + '/close', { token: web, body: { force: true, confirm_early: true } }));
rec('closed year refuses new expense dated in it', [400, 403], await call('POST', '/expenses', { token: web, body: { category: 'Rent', amount: 10, payment_mode: 'cash' } }));
console.log(JSON.stringify(log));
