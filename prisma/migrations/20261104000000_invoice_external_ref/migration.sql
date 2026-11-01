-- The bill number a bill came with (the supplier's own bill number, or the number in the sheet it was imported from).
ALTER TABLE "Invoice" ADD COLUMN "external_ref" TEXT;
CREATE INDEX "Invoice_business_id_voucher_type_external_ref_idx" ON "Invoice"("business_id", "voucher_type", "external_ref");
