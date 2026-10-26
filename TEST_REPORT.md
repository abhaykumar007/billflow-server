# BillFlow Server — Test and Deployment Report (final)

Date: 2026-10-26/27 · Branch: `main` · Production: `https://billflow-server.onrender.com` (Render) with a Neon Postgres database.

## Result

The server is deployed and serving the merged code. The 133-check API suite passes 126/133 against production; the 7 that cannot pass there need a paid plan or are blocked by Cloudflare (details below). All 19 unit tests pass.

## Deployment problems found and fixed

| # | Problem | Fix |
|---|---|---|
| D1 | The first deploy exited at startup with `Missing required env vars: JWT_SECRET` (Render's environment did not provide it to the new instance), so Render kept serving the old version. | The server starts with a secret derived from the private `DATABASE_URL` if `JWT_SECRET` is missing (and logs a warning). **Set `JWT_SECRET` in Render to a long random value to replace it.** |
| D2 | The second deploy started but every login and sign-up returned 500: the generated Prisma client did not match the new schema. | `prisma generate` runs on install and at the start of `npm start`; the server also exits at startup if the client lacks the new models, so a broken build can never replace a working one. |
| D3 | The database migration (refresh sessions, idempotency keys, reset tokens, indexes) ran against the real database successfully. It signed every existing user out once (old refresh tokens are cleared). | — |

## Bugs fixed (whole effort)

Day-book 500; supplier list had no live payable; customer summary and list counted estimates, drafts and returns as money owed; validation errors in products returned 500; any text accepted as a payment/expense mode; malformed report dates returned 500; login limiter counted successful logins; duplicate bank-account names; closing a financial year before it ends silently locked the business out of today's entries (now needs `confirm_early`).

## API suite (`scripts/api-suite.mjs`)

133 checks, self-contained (registers two accounts and seeds its own data): wrong and malformed logins, SQL/NoSQL-style input, 100 kB passwords, malformed JSON, `alg=none` token, reading/editing/deleting/paying another business's data (all refused), tampered totals (recomputed), overpay, double pay, 500 line items, idempotent replay, bank and transfer abuse, report parameter validation, financial-year closing, role limits for staff.

- Local (Pro plan): 133/133.
- Production (free plan): 126/133. The 7 others: 6 staff-role checks need a paid plan (inviting staff returns "Multi-user access requires a Starter or Pro plan."), and one SQL-injection search string is blocked by Cloudflare with a 403 before it reaches the app.

## Operational notes

- Render environment: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `CLIENT_URL`, Razorpay keys and `RAZORPAY_WEBHOOK_SECRET`; optional `SMTP_*`/`MAIL_FROM` for password-reset email (without them the reset link is not delivered). `JWT_REFRESH_SECRET` is no longer used.
- Amounts: invoices and payments use paise in request bodies; products, customers, suppliers, expenses, bank accounts and transfers use rupees.
- Login limit: 10 failed attempts per 15 minutes per address; sign-ups 10 per hour per address.
