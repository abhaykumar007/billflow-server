// Local test helper: put an account's business on the Pro plan (needs DB access; not usable against production)
const path = require('path');
const server = path.resolve(__dirname, '..');
require(path.join(server, 'node_modules', 'dotenv')).config({ path: path.join(server, '.env.development') });
const { PrismaClient } = require(path.join(server, 'node_modules', '@prisma', 'client'));
(async () => {
  const p = new PrismaClient();
  const u = await p.user.findUnique({ where: { email: process.argv[2] } });
  await p.subscription.update({ where: { business_id: u.business_id }, data: { plan: 'pro', status: 'active' } });
  await p.$disconnect();
  console.log('upgraded', process.argv[2]);
})();
