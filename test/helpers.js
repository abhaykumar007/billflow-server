// Boots the real Express app with a stubbed Prisma client (no database needed).
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.CLIENT_URL = 'http://localhost:5173';

// Every prisma.<model>.<method>() resolves to `null` unless a test overrides it.
function makePrismaStub(overrides = {}) {
  const modelCache = {};
  const proxy = new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === '$transaction') return async (fn) => (typeof fn === 'function' ? fn(proxy) : Promise.all(fn));
      if (prop === '$queryRawUnsafe' || prop === '$queryRaw') return async () => [];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (modelCache[prop] ||= new Proxy({}, {
        get: (_, method) => async () => (method === 'count' ? 0 : method === 'findMany' ? [] : null),
      }));
    },
  });
  return proxy;
}

function loadApp(overrides = {}) {
  const prismaPath = require.resolve(path.join('..', 'src', 'utils', 'prisma'));
  const stub = makePrismaStub(overrides);
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: stub };
  // fresh app each time
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`) && !key.endsWith(`utils${path.sep}prisma.js`)) delete require.cache[key];
  }
  return require('../src/index.js');
}

async function start(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { loadApp, start };
