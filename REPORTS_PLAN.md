# BillFlow Reports — Server Implementation Plan

All routes go in `src/routes/reports.js`.
Middleware `authenticateToken` + `attachFinancialYear` already applied at router level.
All amounts stored in **paise** — never divide in the route, let the client handle display.

---

## Already Implemented ✅

| Route | Description |
|-------|-------------|
| `GET /reports/sales-summary` | Daily sales breakdown, totals, tax, discount |
| `GET /reports/purchase-summary` | Daily purchase breakdown, totals |
| `GET /reports/outstanding` | Receivables aged by customer |
| `GET /reports/outstanding-payable` | Payables aged by supplier |
| `GET /reports/collections` | All payments received/made, grouped by mode |
| `GET /reports/gst-summary` | Tax by rate slab, CGST/SGST/IGST split |
| `GET /reports/profit-loss` | Gross sales → COGS → Gross Profit → Expenses → Net Profit |
| `GET /reports/product-sales` | Top products by revenue in period |
| `GET /reports/stock-summary` | Opening/closing stock per product for active FY |
| `GET /reports/day-book` | All transactions for a single date |
| `GET /reports/payments-made` | Supplier payments from ledger |

---

## Phase 1 — Quick Wins (data already in DB)

### 1. All Transactions
```
GET /reports/all-transactions?from=&to=
```
- Merge SALE, PURCHASE, SALE_RETURN, PURCHASE_RETURN invoices + payments + expenses
- Each entry: `{ date, type, reference, party, amount, dr, cr }`
- Sort chronologically
- Return: `{ entries[], totals: { total_dr, total_cr } }`

### 2. Expense Report
```
GET /reports/expenses?from=&to=
```
- Query `expense` table filtered by `expense_date`
- Return raw list: `{ expenses[], total_amount, count }`
- Fields per row: `id, expense_date, category, description, payment_mode, amount`

### 3. Expense Category Report
```
GET /reports/expense-by-category?from=&to=
```
- `prisma.expense.groupBy({ by: ['category'], _sum: { amount: true }, _count: { id: true } })`
- Add `pct` share of total per category
- Return: `{ categories[], total_amount }`

### 4. Low Stock Summary
```
GET /reports/low-stock?threshold=5
```
- Reuse stock-summary calculation logic (opening + purchased - sold etc.)
- Filter where `closing_qty <= threshold` (default 5, query param)
- Return: `{ products[], threshold }`
- Fields: `id, name, category, unit, closing_qty, purchase_price, stock_value`

### 5. Item Wise Discount
```
GET /reports/item-discounts?from=&to=
```
- `invoiceItem.findMany` on SALE invoices in date range
- Group by `product_id`, sum `discount_amount` and `quantity`
- Return: `{ products[], total_discount }` sorted by total_discount desc
- Fields: `product_id, name, unit, qty_sold, total_discount, avg_discount_pct`

### 6. Discount Report (invoice-level)
```
GET /reports/discount-report?from=&to=
```
- Query SALE invoices with `discount_amount > 0`
- Return per-invoice: `{ invoice_number, date, customer_name, gross_amount, discount_amount, net_amount }`
- Totals: `{ total_gross, total_discount, total_net }`

### 7. Party Statement
```
GET /reports/party-statement?partyId=&partyType=customer|supplier&from=&to=
```
- `partyType=customer` → query `customerLedgerEntry` table
- `partyType=supplier` → query `supplierLedgerEntry` table
- Compute running balance: carry opening_balance forward, apply debit/credit per row
- Return: `{ party, opening_balance, entries[], closing_balance }`

### 8. Sale Purchase By Party
```
GET /reports/sale-purchase-by-party?from=&to=&type=customer|supplier
```
- Group invoices by `customer_id` or `supplier_id` in date range
- Per party: `{ name, phone, total_sale, total_purchase, sale_returns, purchase_returns, net }`
- Return sorted by net desc

---

## Phase 2 — Moderate Complexity

### 9. Bill Wise Profit
```
GET /reports/bill-wise-profit?from=&to=
```
- For each SALE invoice: load its `invoiceItems` with `product.purchase_price`
- `cogs = SUM(item.quantity × product.purchase_price)` (skip items with no purchase_price)
- `profit = invoice.subtotal - cogs`, `margin_pct = profit / invoice.subtotal × 100`
- Return sorted by profit desc
- Fields: `invoice_number, date, customer, sale_amount, cogs, profit, margin_pct`

### 10. Item Wise Profit & Loss
```
GET /reports/item-wise-profit?from=&to=
```
- Group SALE invoiceItems by product
- Per product: `qty_sold, sale_revenue, cogs (qty × purchase_price), gross_profit, margin_pct`
- Return sorted by gross_profit desc

### 11. Item Category Wise P&L
```
GET /reports/item-category-pl?from=&to=
```
- Same as item-wise-profit but group by `product.category_id`
- Join category name
- Return: `{ categories[], totals }`

### 12. Stock Detail (movement log)
```
GET /reports/stock-detail?productId=&from=&to=
```
- Fetch all invoiceItems for given productId across PURCHASE/SALE/RETURNS in date range
- Each row: `{ date, voucher_type, reference, party, qty_in, qty_out, running_balance }`
- Compute running balance as you iterate chronologically
- Return: `{ product, entries[], opening_qty, closing_qty }`

### 13. Item Report By Party
```
GET /reports/item-by-party?from=&to=&partyType=customer|supplier
```
- Join invoiceItem → invoice → customer/supplier
- Group by `(product_id, party_id)`
- Return: `{ rows: [{ product, party, qty, amount }] }`

### 14. Stock Summary By Item Category
```
GET /reports/stock-by-category
```
- Run stock-summary logic, then aggregate by `product.category`
- Return: `{ categories[], totals }`
- Fields: `category_name, product_count, total_closing_qty, total_stock_value`

### 15. Sale/Purchase Report By Item Category
```
GET /reports/sale-purchase-by-category?from=&to=
```
- Group invoiceItems by `product.category_id`, split SALE vs PURCHASE voucher types
- Return: `{ categories[], totals }`

### 16. Party Wise Profit & Loss
```
GET /reports/party-wise-pl?from=&to=
```
- Per customer: `sale_revenue, cogs (from item purchase_prices), gross_profit, margin_pct`
- Only SALE invoices, group by customer
- Return sorted by gross_profit desc

### 17. All Parties
```
GET /reports/all-parties
```
- Fetch all customers + all suppliers
- For each: compute `total_invoiced - total_paid = balance`
- Return: `{ customers[], suppliers[], total_receivable, total_payable }`

### 18. GSTR-1 (Detailed Outward Supply)
```
GET /reports/gstr1?from=&to=
```
- Split SALE invoices into:
  - **B2B**: customer has GSTIN → group by customer GSTIN
  - **B2CS**: consumer (no GSTIN) → group by state + rate
- **HSN Summary**: group invoiceItems by `product.hsn_code`
- Return: `{ b2b[], b2cs[], hsn_summary[], period }`

### 19. GSTR-3B
```
GET /reports/gstr3b?from=&to=
```
- Outward taxable supplies: sales by rate slab
- Inward ITC: purchases by rate slab
- Net tax payable per slab: IGST, CGST, SGST
- Return structured to match official GSTR-3B table format

### 20. HSN Summary
```
GET /reports/hsn-summary?from=&to=
```
- Group SALE invoiceItems by `product.hsn_code`
- Per HSN: `{ hsn_code, description, uqc, qty, taxable_value, igst, cgst, sgst, total_tax }`

### 21. GST Rate Report
```
GET /reports/gst-rate-report?from=&to=
```
- All transactions (SALE + PURCHASE) grouped by GST rate slab
- Per slab: `{ rate, taxable_sale, tax_collected, taxable_purchase, input_credit, net_payable }`

---

## Phase 3 — Complex / Accounting Constructs

### 22. Cash Flow Statement
```
GET /reports/cash-flow?from=&to=
```
- **Operating:** receipts from customers - payments to suppliers - expenses
- **Investing:** (not applicable for retail, return empty section)
- **Financing:** (loan repayments if loan module added)
- Derive from payments + expenses tables

### 23. Trial Balance
```
GET /reports/trial-balance?from=&to=
```
- Account heads: Sales, Purchases, Expenses (by category), Cash/Bank, Receivables, Payables
- For each: `{ account, debit_total, credit_total }`
- Grand totals must balance (Dr = Cr)

### 24. Balance Sheet
```
GET /reports/balance-sheet?asOf=
```
- **Assets:** Stock value + Total Receivable + Cash/Bank balances
- **Liabilities:** Total Payable
- **Equity (approx):** Assets - Liabilities (Net Worth)
- No double-entry ledger needed — computed from existing tables

### 25. GSTR-2 (Inward Supply)
```
GET /reports/gstr2?from=&to=
```
- Mirror of GSTR-1 but for PURCHASE invoices and supplier GSTINs

### 26. GSTR-9 (Annual Return)
```
GET /reports/gstr9?financialYearId=
```
- Full-year aggregate of GSTR-1 + 3B data
- Only valid for complete FY, not partial periods

### 27. SAC Report
```
GET /reports/sac-report?from=&to=
```
- Same as HSN summary but filter `product.sac_code IS NOT NULL`

### 28. TDS Payable
```
GET /reports/tds-payable?from=&to=
```
- Requires `tds_rate` + `tds_amount` on invoices — **schema migration needed**
- Group by vendor, summarize TDS deducted

### 29. TDS Receivable / TCS Receivable / Form 27EQ
- Schema migration required for TDS/TCS fields
- Low priority for retail shops

### 30. Sale Orders Report
```
GET /reports/sale-orders?from=&to=
GET /reports/sale-order-items?from=&to=
```
- Filter `estimate` table (or `invoice` with `voucher_type='ESTIMATE'`)
- Aggregate by status (open, converted, expired)

### 31. Loan Statement
- Requires new `loan_account` model — **schema migration needed**

---

## Helper Notes

- `parseDateRange(from, to, financialYear)` — already defined at top of `reports.js`, reuse it
- Always filter `business_id: req.user.businessId` on every query
- Always filter `is_deleted: false` on invoice/product/expense queries
- FY filter: use `financial_year_id: req.financialYear.id` when FY-scoped
- Running balances: sort by date asc, iterate, carry forward — do this in JS not SQL
