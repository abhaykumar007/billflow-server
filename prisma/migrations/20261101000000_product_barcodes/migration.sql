-- Product barcodes: several scannable codes per item, unique within a business, plus a per-business counter for own codes.
-- Only adds a column and a table; existing rows are untouched.
ALTER TABLE "Business" ADD COLUMN "barcode_next_number" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "ProductBarcode" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manufacturer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductBarcode_business_id_code_key" ON "ProductBarcode"("business_id", "code");
CREATE INDEX "ProductBarcode_product_id_idx" ON "ProductBarcode"("product_id");

ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
