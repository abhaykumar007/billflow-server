-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "financial_year_id" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "financial_year_id" TEXT;

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "financial_year_id" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "financial_year_id" TEXT;

-- CreateTable
CREATE TABLE "FinancialYear" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialYear_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialYear_business_id_label_key" ON "FinancialYear"("business_id", "label");

-- AddForeignKey
ALTER TABLE "FinancialYear" ADD CONSTRAINT "FinancialYear_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_financial_year_id_fkey" FOREIGN KEY ("financial_year_id") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;
