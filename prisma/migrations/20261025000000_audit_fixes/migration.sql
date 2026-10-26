-- Stock can be fractional (kg, litres, metres)
ALTER TABLE "Product" ALTER COLUMN "stock_quantity" SET DATA TYPE DOUBLE PRECISION;

-- Idempotency keys (safe retries from mobile / flaky networks)
ALTER TABLE "Invoice" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "Payment" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "Invoice_business_id_idempotency_key_key" ON "Invoice"("business_id", "idempotency_key");
CREATE UNIQUE INDEX "Payment_business_id_idempotency_key_key" ON "Payment"("business_id", "idempotency_key");

-- Per-device hashed refresh sessions (replaces the single plaintext User.refresh_token)
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RefreshSession_token_hash_key" ON "RefreshSession"("token_hash");
CREATE INDEX "RefreshSession_user_id_idx" ON "RefreshSession"("user_id");
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Old plaintext tokens are no longer valid; users simply log in again
UPDATE "User" SET "refresh_token" = NULL;

-- One row per captured Razorpay payment: makes /verify and the webhook idempotent
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "razorpay_order_id" TEXT,
    "razorpay_payment_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionPayment_razorpay_payment_id_key" ON "SubscriptionPayment"("razorpay_payment_id");
CREATE INDEX "SubscriptionPayment_business_id_idx" ON "SubscriptionPayment"("business_id");

-- Indexes (there were none besides unique constraints)
CREATE INDEX "User_business_id_idx" ON "User"("business_id");
CREATE INDEX "Customer_business_id_is_deleted_idx" ON "Customer"("business_id", "is_deleted");
CREATE INDEX "Supplier_business_id_is_deleted_idx" ON "Supplier"("business_id", "is_deleted");
CREATE INDEX "Product_business_id_is_deleted_idx" ON "Product"("business_id", "is_deleted");
CREATE INDEX "Invoice_business_id_financial_year_id_voucher_type_status_idx" ON "Invoice"("business_id", "financial_year_id", "voucher_type", "status");
CREATE INDEX "Invoice_business_id_customer_id_idx" ON "Invoice"("business_id", "customer_id");
CREATE INDEX "Invoice_business_id_supplier_id_idx" ON "Invoice"("business_id", "supplier_id");
CREATE INDEX "Invoice_business_id_invoice_date_idx" ON "Invoice"("business_id", "invoice_date");
CREATE INDEX "Invoice_linked_invoice_id_idx" ON "Invoice"("linked_invoice_id");
CREATE INDEX "InvoiceItem_invoice_id_idx" ON "InvoiceItem"("invoice_id");
CREATE INDEX "InvoiceItem_product_id_idx" ON "InvoiceItem"("product_id");
CREATE INDEX "Payment_business_id_invoice_id_idx" ON "Payment"("business_id", "invoice_id");
CREATE INDEX "Payment_business_id_customer_id_idx" ON "Payment"("business_id", "customer_id");
CREATE INDEX "Payment_business_id_supplier_id_idx" ON "Payment"("business_id", "supplier_id");
CREATE INDEX "Payment_financial_year_id_idx" ON "Payment"("financial_year_id");
CREATE INDEX "Payment_bank_account_id_idx" ON "Payment"("bank_account_id");
CREATE INDEX "payment_splits_payment_id_idx" ON "payment_splits"("payment_id");
CREATE INDEX "LedgerEntry_party_fy_created_idx" ON "LedgerEntry"("business_id", "customer_id", "financial_year_id", "created_at");
CREATE INDEX "SupplierLedgerEntry_party_fy_created_idx" ON "SupplierLedgerEntry"("business_id", "supplier_id", "financial_year_id", "created_at");
CREATE INDEX "Expense_business_id_financial_year_id_expense_date_idx" ON "Expense"("business_id", "financial_year_id", "expense_date");
CREATE INDEX "Expense_bank_account_id_idx" ON "Expense"("bank_account_id");
CREATE INDEX "fund_transfers_business_id_idx" ON "fund_transfers"("business_id");
CREATE INDEX "fund_transfers_from_account_id_idx" ON "fund_transfers"("from_account_id");
CREATE INDEX "fund_transfers_to_account_id_idx" ON "fund_transfers"("to_account_id");
CREATE INDEX "bank_accounts_business_id_idx" ON "bank_accounts"("business_id");

-- Password reset tokens (hashed, single use, short lived)
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_token_hash_key" ON "PasswordResetToken"("token_hash");
CREATE INDEX "PasswordResetToken_user_id_idx" ON "PasswordResetToken"("user_id");
