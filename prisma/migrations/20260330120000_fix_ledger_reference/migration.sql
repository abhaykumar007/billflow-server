-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "ledger_invoice_fk";

-- AlterTable: make reference_id nullable
ALTER TABLE "LedgerEntry" ALTER COLUMN "reference_id" DROP NOT NULL;
