-- AlterTable
ALTER TABLE "FinancialYear" ADD COLUMN     "invoice_next_number" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "purchase_next_number" INTEGER NOT NULL DEFAULT 1;
