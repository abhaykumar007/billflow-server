// Checks changing your own password from the web (PUT /auth/password, session found by cookie) and the phone
// (PUT /settings/password, session found by the token in the body): the device that changes it stays signed in, the others do not.
//   API=http://localhost:5000 node scripts/password-suite.mjs
const API = (process.env.API || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const stamp = Date.now();
let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); };
async function call(method, path, { token, body, cookie, mobile } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(mobile ? { 'x-client': 'mobile' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, json, cookie: (setCookie.match(/refreshToken=[^;]+/) || [''])[0] };
}
const email = `pw.suite.${stamp}@example.com`; const P0 = 'Passw0rd!23'; const P1 = 'Changed!Pass1'; const P2 = 'Changed!Pass2';

(async () => {
  const reg = await call('POST', '/auth/register', { body: { name: 'Pw', email, password: P0, business: { name: 'Pw Biz', state: 'Karnataka', city: 'Bengaluru' } } });
  check('account created', reg.status === 201 || reg.status === 200, JSON.stringify(reg.json));
  const web = await call('POST', '/auth/login', { body: { email, password: P0 } });          // the web: refresh token in a cookie
  const phone = await call('POST', '/auth/login', { body: { email, password: P0 }, mobile: true }); // the phone: refresh token in the body
  check('web and phone are both signed in', !!web.cookie && !!phone.json.refreshToken && !!web.json.accessToken, `${web.cookie} ${phone.json.refreshToken}`);

  // refusals
  check('no sign-in is refused (401)', (await call('PUT', '/auth/password', { body: { current_password: P0, new_password: P1 } })).status === 401);
  check('a wrong current password is refused (400)', (await call('PUT', '/auth/password', { token: web.json.accessToken, cookie: web.cookie, body: { current_password: 'nope', new_password: P1 } })).status === 400);
  check('a new password under 8 characters is refused (400)', (await call('PUT', '/auth/password', { token: web.json.accessToken, cookie: web.cookie, body: { current_password: P0, new_password: 'short' } })).status === 400);
  check('missing fields are refused (400)', (await call('PUT', '/auth/password', { token: web.json.accessToken, cookie: web.cookie, body: {} })).status === 400);

  // the web changes it: the web stays signed in, the phone is signed out
  const ch = await call('PUT', '/auth/password', { token: web.json.accessToken, cookie: web.cookie, body: { current_password: P0, new_password: P1 } });
  check('the web changes the password (200)', ch.status === 200, JSON.stringify(ch.json));
  check('the old password no longer signs in; the new one does', (await call('POST', '/auth/login', { body: { email, password: P0 } })).status === 401 && (await call('POST', '/auth/login', { body: { email, password: P1 } })).status === 200);
  const webRefresh = await call('POST', '/auth/refresh', { cookie: web.cookie });
  check('the web session that changed it can still refresh (stays signed in)', webRefresh.status === 200 && !!webRefresh.json.accessToken, `status ${webRefresh.status}`);
  const phoneRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: phone.json.refreshToken }, mobile: true });
  check('the phone session is signed out (refresh refused)', phoneRefresh.status === 401 || phoneRefresh.status === 403, `status ${phoneRefresh.status}`);

  // the phone changes it, naming its own session in the body: it stays, the web goes
  const web2 = await call('POST', '/auth/login', { body: { email, password: P1 } });
  const phone2 = await call('POST', '/auth/login', { body: { email, password: P1 }, mobile: true });
  const ch2 = await call('PUT', '/settings/password', { token: phone2.json.accessToken, mobile: true, body: { current_password: P1, new_password: P2, refreshToken: phone2.json.refreshToken } });
  check('the phone changes the password (200)', ch2.status === 200, JSON.stringify(ch2.json));
  check('the phone session that changed it can still refresh', (await call('POST', '/auth/refresh', { body: { refreshToken: phone2.json.refreshToken }, mobile: true })).status === 200);
  const web2Refresh = await call('POST', '/auth/refresh', { cookie: web2.cookie });
  check('the web session is signed out after the phone changed it', web2Refresh.status === 401 || web2Refresh.status === 403, `status ${web2Refresh.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
