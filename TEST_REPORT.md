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

## Bill design (customizable bills)

What was added: a saved design per business (layout, colour, font, paper A4/A5/receipt 58 and 80 mm, header/customer/column toggles, wording, bank block, UPI QR, signature, footer), one server-side bill renderer used by web and phone, and endpoints `GET/PUT /api/bill-design`, `PUT /api/bill-design/assets` (logo, signature, UPI id), `POST /api/bill-design/preview`, `GET /api/invoices/:id/print`. One additive migration (`bill_design`, `logo_data`, `signature_data`, `upi_id` on Business; nothing existing changes).

Safety rules enforced on the server: the design is options only (unknown keys dropped, bad values fall back to defaults, colours/fonts/sizes from allow-lists, text length-limited and always HTML-escaped); images must be PNG/JPEG/WebP data URLs under about 300 KB (SVG is refused); a GST-registered business cannot switch off business name, address, GSTIN, customer GSTIN, GST % column or the tax split; only the owner or an accountant can change anything; every read and print is scoped to the signed-in business.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 40 pass (21 new: amount in words, design cleaning and GST locks, escaping of user text, image/UPI validation, columns/labels/layout, CGST+SGST vs IGST, PAID stamp, QR only on unpaid sales, bank block, all four paper sizes, 150-line bill, routes and role limits) |
| `scripts/bill-design-suite.mjs` against a live server | 60 pass: sign-in required, two accounts cannot see or print each other's design/invoices, script text in labels printed as plain text, wrong-typed and array/`__proto__`/3000-deep JSON bodies, 2 MB bodies (413), bad logos (SVG, HTML, remote URL, script tricks, oversize), 13 bad UPI ids, junk `paper` values, 30 parallel previews, 120-line bill |
| Existing API suite (`UPGRADE=1`, local Pro plan) | 133 of 133 still pass |

Found and fixed while testing: a design sent as an array silently reset the design (now 400); standard wording was being stored in the database and my local test database (a Windows text encoding) could not store the ₹ sign, so only wording the user changed is stored now (standard words also update for everyone who never customized them). Note: the local test database cannot store non-Latin text (for example Hindi labels); production's database is UTF-8 and is not affected, but that is only confirmed once deployed.
