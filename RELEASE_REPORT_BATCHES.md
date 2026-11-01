# Batch / MRP / Expiry release report (medical and FMCG)

Branches: server `batches-phase1`, web `batches-phase2`. Both are ahead of `main` and contain it (main has not moved), so each merges as a
fast-forward. The mobile app is not part of this release (see "Not in this release").

## What is in it

| Area | What it does |
|---|---|
| Batches | A batch is one purchase lot (batch no., expiry, MRP, cost, selling price, quantity). Opt-in per item (`track_batches`); the item total always equals the sum of its batches. Same batch + MRP + cost tops up one batch; same batch with another expiry is refused. |
| Selling | The person picks the batch by hand; nothing is chosen automatically. Returns and cancels go back to the same batch. Expired stock cannot be sold by staff; the owner needs a reason, which is kept on the line. Price + GST above MRP is a warning. |
| Expiry | Medical businesses must enter an expiry on purchases. Near-expiry window is a setting (default 90 days). |
| GST-inclusive rates | Optional business setting ("rates include GST"), off by default. Stored amounts stay GST-exclusive, so reports do not change. |
| Industry settings | Business type (general / medical / FMCG), drug licences 20/21, FSSAI, near-expiry days. |
| Bills | Batch, Exp, MRP and Free columns (only when a line has them), licence/FSSAI lines, GST-inclusive line amounts, medical and FMCG sample bills, receipt layouts, bill-design toggles. |
| Reference number | The bill number a bill came with (supplier's own bill no.). Box on New Purchase, shown on the bill page and on the printed bill; a bill-design toggle switches it off. Same number for the same party is refused (cancelled bills do not count). |
| Reports | Near Expiry, Expired Stock, Batch Stock, Batch Wise Sale, MRP Wise Sale, Item Wise Sale (replaces the Product Sales screen; the old endpoint still exists). Print + CSV. |
| Excel import | Purchase and sale bills from `.xlsx`: template, preview (exact dry run through the real bill logic), confirm, duplicate skip, create missing parties/items, draft option. |

## Database changes (additive only)

* `20261103000000_batches_mrp_expiry`: new `Batch` table; new columns on `Business`, `Product`, `Invoice`, `InvoiceItem`. All new columns are nullable or have defaults.
* `20261104000000_invoice_external_ref`: `Invoice.external_ref` + an index.
* No `DROP`, `DELETE`, `UPDATE` or type change anywhere. Existing rows are untouched and existing items stay non-batch.
* Rollback safety: old server code ignores the new columns, so redeploying the previous server version after the migration is safe.
* `render.yaml` start command already runs `prisma migrate deploy`, so the migrations run on deploy.
* Checked: a brand-new database builds from all 22 migrations, and `prisma migrate diff` between that database and `schema.prisma` shows **no difference**.

## Tests run on the final commits (local Postgres, fresh server per suite)

| Suite | Result |
|---|---|
| Server unit tests | 71 / 71 |
| (found while doing the phone app) estimate → sale lost "rates include GST" and batch details; now kept, and a draft that still needs a batch cannot be sent. Covered by 6 new edge checks. | fixed |
| `scripts/batch-suite.mjs` (batches, expiry, MRP, GST-inclusive, concurrency) | 92 / 92 |
| `scripts/batch-edge-suite.mjs` (bad input, other business, returns, cancels, drafts, estimate convert) | 46 / 46 |
| `scripts/batch-report-suite.mjs` (reports against hand-worked figures) | 63 / 63 |
| `scripts/import-suite.mjs` (import, duplicates, reference number, permissions) | 58 / 58 |
| `scripts/bill-design-suite.mjs` (existing + new bill layout) | 60 / 60 |
| `scripts/barcode-suite.mjs` (existing) | 53 / 53 |
| `scripts/api-suite.mjs` with `UPGRADE=1` (existing break-it suite) | 133 / 133 |
| Web lint | 0 errors (13 warnings, all pre-existing patterns) |
| Web production build | passes |

Checked by hand in the browser: purchase with batch, free pieces and GST-inclusive total; sale with batch picker; expired batch with and without an owner reason; MRP warning;
draft edit and send; estimate edit; sale return batch list; cancel puts stock back; all report screens against known data and CSV export; bill preview on A4, A5, 80 mm and 58 mm;
PDF generation; Excel import with real `.xlsx` files (purchase and sale); duplicate re-import; wrong file types; reference box, bill page line and duplicate message.

## Known limits and things to know before deploying

1. **Phone app** (branch `batches-phone` in `billflow-mobile`, includes the offline-system branch): tested in a **debug build on a real phone** against the local server. Online: sale with the batch picker, MRP warning, expired batch with the owner's reason, purchase with batch / expiry / MRP / free qty / supplier bill no., GST-inclusive totals and labels, bill screen with batch details, item form (MRP, locked batch switch), reports (Near expiry). Offline (server stopped): customer and item search and the batch list come from the phone's copy, a sale naming a batch and a purchase with batch fields were saved on the phone, showed the right amounts (GST-inclusive), took stock off locally, and after "Sync now" arrived on the server with the right batch, quantities, supplier bill no. and the real numbers. The existing offline suites pass (19/19, 8/8 and 32/33; the 33rd, a 1,200-item download, passes alone and fails only in the full run because that run uses up the server's 1,500-requests-per-15-minutes limit). Not yet tried on the phone: sale return, an expired batch offline, the remaining reports, and printing/sharing the PDF.
2. **Offline limits that remain:** reports need the server. A batch bought offline exists only after syncing (so it cannot be sold offline before that). If a batch expires while a bill waits, that bill is refused at sync with the usual message and stays in the list for the person to fix. The server branch now includes `offline-system` (migration `20261102000000_invoice_made_offline`), so offline bills and the batch work go to main together.
3. **Not tried on a real printer.** The bill layouts were checked on screen and as PDF.
4. **Not rehearsed on a copy of production data.** The migrations are additive and were applied to a database that had real-shaped data (built on `main`'s schema) and to an empty database; the Neon copy of production was not touched.
5. **Excel import limits:** `.xlsx` only, first sheet, 8 MB / 20,000 lines per file, purchase and sale bills only (no returns).
6. The reference number can be typed on purchases only; for sales it comes from imports. It is not on the phone app.
7. `npm audit` lists advisories in packages that were already in the project (axios, react-router, dompurify, body-parser, path-to-regexp, qs, proxy-addr, form-data, follow-redirects). This release adds two small web libraries (`read-excel-file`, `write-excel-file`) and no new advisories; server `package.json` is unchanged.
8. Local test accounts were put on the Pro plan by a helper script; real sign-ups are Free (50 sale invoices a month). The import counts against that limit for sales; none of the batch features is plan-gated.

## Merge and deploy steps

1. Merge server `batches-phase1` into `main` (fast-forward). Render builds, runs `prisma migrate deploy`, starts.
2. Merge web `batches-phase2` into `main` (fast-forward). Vercel builds.
3. Smoke test on production with a test business: Settings → Medical & FMCG, add an item with batch tracking, buy with batch + expiry, sell picking the batch, open the Near Expiry report, print the bill, import the template file.
4. If something is wrong: redeploy the previous server and web commits (the migration needs no rollback).
