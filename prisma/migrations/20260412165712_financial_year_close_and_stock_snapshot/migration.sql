-- AlterTable
ALTER TABLE "FinancialYear" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_by_id" TEXT,
ADD COLUMN     "is_closed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "opening_stock_snapshot" JSONB;

-- AddForeignKey
ALTER TABLE "FinancialYear" ADD CONSTRAINT "FinancialYear_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
