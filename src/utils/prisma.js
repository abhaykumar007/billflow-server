const { PrismaClient } = require('@prisma/client');

// Interactive transactions here do several round-trips (row locks, ledger reads, writes)
// against a remote pooled database, so the 5s default is too tight.
const prisma = new PrismaClient({
  transactionOptions: { maxWait: 10000, timeout: 20000 },
});

module.exports = prisma;
