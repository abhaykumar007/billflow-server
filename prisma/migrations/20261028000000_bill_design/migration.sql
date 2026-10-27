-- Bill design: chosen options and the small images (logo, signature) a bill can show, plus the UPI id for the pay QR.
-- Only adds nullable columns, so existing rows and bills are untouched.
ALTER TABLE "Business" ADD COLUMN "bill_design" JSONB;
ALTER TABLE "Business" ADD COLUMN "logo_data" TEXT;
ALTER TABLE "Business" ADD COLUMN "signature_data" TEXT;
ALTER TABLE "Business" ADD COLUMN "upi_id" TEXT;
