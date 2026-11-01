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

### Bill text size (fixed 2026-11-01)

Found: Small, Medium and Large changed A4/A5 text by only 1 px (11, 12, 13), invisible in the 65%-scaled editor preview, and receipts (80 and 58 mm) ignored the setting completely. Fixed: every size on the page scales by one factor (A4/A5: 0.88, 1, 1.2; receipts: 0.9, 1, 1.15). Tests: 42 pass; the new test checks body text, small text and headings all grow from Small to Large on A4, A5, 80 mm and 58 mm, Large is at least 25% bigger than Small, and an unknown value falls back to Medium. Looked at the largest A4 bill and the largest 58 mm receipt: nothing overflows.

Also added a content rule to the bill page (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) and stopped loading remote logo links; checked in a browser that styles, logo, QR and bank details still draw and that a remote image and an injected script are blocked.

## Barcodes (added 2026-11-01)

New tables/columns (additive migration `20261101000000_product_barcodes`): `ProductBarcode` (code unique per business, kind `own`/`manufacturer`, deleted with its item), `Business.barcode_next_number`. Endpoints under `/api/products`: `GET /by-barcode/:code`, `GET /label-layouts`, `POST /labels`, `GET|POST /:id/barcodes`, `POST /:id/barcodes/generate`, `DELETE /:id/barcodes/:barcodeId`; `POST /products` accepts an optional `barcode`; list search also matches barcodes.

- Own codes are EAN-13 starting with `2` (GS1 reserves 20–29 for in-store use) with a valid check digit, from a per-business counter moved forward inside the same transaction.
- Scanner input is cleaned (spaces, line breaks, case). Junk (`<script>`, quotes, too short/long) is refused. A code of a standard length with a wrong check digit is accepted with a warning.
- A code belongs to one live item per business; another business may use the same number; a deleted item gives its codes back. At most 10 codes per item; labels: 1–100 items, 1–100 copies, 500 labels per request.
- The label page is escaped, carries a content rule (no scripts, no network) and draws bars with `bwip-js`.
- Tests: 12 new unit/route tests (`test/barcodes.test.js`), suite now 54/54. Break-it script `scripts/barcode-suite.mjs`: 53/53 locally (access control, tenant isolation, duplicates, junk input, limits, label caps, deleted items). Old suites unchanged: `api-suite` all checks pass (`UPGRADE=1`), `bill-design-suite` 60/60.

## Offline support (branch `offline-system`, 2026-11-01)
- `POST /invoices` accepts an optional `client_created_at` (when a phone that was offline really made the bill). It is stored as the bill's `created_at` only if it is a valid time, not in the future (a few minutes of clock drift is clamped to now) and not older than 90 days; otherwise the server time is used. Old clients are unaffected.
- `GET /invoices` now orders by bill date, then creation time, then id (it ordered by date only, so same-day bills had no guaranteed order).
- Tests: `test/madeAt.test.js` (3), server suite 57/57; barcode 53/53, bill-design 60/60, API 133/133 unchanged. Mixed phone + web scenarios: see the mobile repo's TEST_REPORT.md (16/16).
- Invoices now carry `made_offline`, `offline_ref` (temporary number such as OFFLINE-001) and `synced_at` (additive migration `20261102000000_invoice_made_offline`). `POST /invoices` accepts `made_offline: true` (only the boolean `true` counts) and `offline_ref` (cleaned to letters, digits and `._/-`, 40 characters). Checked live (mobile suite M17-M19): offline bills are marked, web bills are not, dirty or non-boolean values are ignored, a resent bill stays one marked bill.
