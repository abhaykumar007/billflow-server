-- Batches, MRP and expiry (medical / FMCG). Only adds columns and a table; existing rows keep working unchanged.

-- Business: what kind of business, licence lines for the bill, GST-inclusive prices, how early "near expiry" starts.
ALTER TABLE "Business" ADD COLUMN "business_type" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "Business" ADD COLUMN "drug_license_20" TEXT;
ALTER TABLE "Business" ADD COLUMN "drug_license_21" TEXT;
ALTER TABLE "Business" ADD COLUMN "fssai_no" TEXT;
ALTER TABLE "Business" ADD COLUMN "rates_include_gst" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "near_expiry_days" INTEGER NOT NULL DEFAULT 90;

-- Product: printed MRP, pack, schedule, and whether stock is kept per batch.
ALTER TABLE "Product" ADD COLUMN "mrp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "track_batches" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "pack_size" TEXT;
ALTER TABLE "Product" ADD COLUMN "schedule" TEXT;
ALTER TABLE "Product" ADD COLUMN "manufacturer" TEXT;
ALTER TABLE "Product" ADD COLUMN "composition" TEXT;

-- A batch is one purchase lot of an item: its own number, expiry, MRP, cost, price and quantity left.
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "batch_no" TEXT NOT NULL,
    "expiry_date" TIMESTAMP(3),
    "mfg_date" TIMESTAMP(3),
    "mrp" INTEGER NOT NULL DEFAULT 0,
    "purchase_price" INTEGER NOT NULL DEFAULT 0,
    "sale_price" INTEGER,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_opening" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Batch_product_id_batch_no_mrp_purchase_price_key" ON "Batch"("product_id", "batch_no", "mrp", "purchase_price");
CREATE INDEX "Batch_business_id_expiry_date_idx" ON "Batch"("business_id", "expiry_date");
CREATE INDEX "Batch_product_id_idx" ON "Batch"("product_id");
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bill: whether the rates on it include GST; each line remembers its batch, MRP, free quantity and the cost at the time of sale.
ALTER TABLE "Invoice" ADD COLUMN "rates_include_gst" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "discount_incl" INTEGER;
ALTER TABLE "InvoiceItem" ADD COLUMN "batch_id" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN "batch_no" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN "expiry_date" TIMESTAMP(3);
ALTER TABLE "InvoiceItem" ADD COLUMN "mfg_date" TIMESTAMP(3);
ALTER TABLE "InvoiceItem" ADD COLUMN "mrp" INTEGER;
ALTER TABLE "InvoiceItem" ADD COLUMN "free_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceItem" ADD COLUMN "cost_price" INTEGER;
ALTER TABLE "InvoiceItem" ADD COLUMN "batch_sale_price" INTEGER;
ALTER TABLE "InvoiceItem" ADD COLUMN "expired_override_reason" TEXT;
CREATE INDEX "InvoiceItem_batch_id_idx" ON "InvoiceItem"("batch_id");
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
