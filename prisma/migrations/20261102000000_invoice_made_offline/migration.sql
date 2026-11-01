-- Marks bills that were made on a phone without internet and sent later: when it was sent and the temporary number it had.
-- Only adds columns; existing bills stay as they are (made_offline = false).
ALTER TABLE "Invoice" ADD COLUMN "made_offline" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "offline_ref" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "synced_at" TIMESTAMP(3);
