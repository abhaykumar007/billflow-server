-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_linked_invoice_id_fkey" FOREIGN KEY ("linked_invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
