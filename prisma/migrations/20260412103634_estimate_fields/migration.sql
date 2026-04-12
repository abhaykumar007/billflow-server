-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "estimate_prefix" TEXT NOT NULL DEFAULT 'EST';

-- AlterTable
ALTER TABLE "FinancialYear" ADD COLUMN     "estimate_next_number" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "valid_until" TIMESTAMP(3);
