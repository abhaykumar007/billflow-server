-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_customer_id_fkey";

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "purchase_next_number" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "purchase_prefix" TEXT NOT NULL DEFAULT 'PUR';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "linked_invoice_id" TEXT,
ADD COLUMN     "supplier_id" TEXT,
ADD COLUMN     "voucher_type" TEXT NOT NULL DEFAULT 'SALE',
ALTER COLUMN "customer_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
