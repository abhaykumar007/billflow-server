-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_invoice_id_fkey";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "advance_balance_remaining" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "advance_payment" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "invoice_id" DROP NOT NULL,
ALTER COLUMN "payment_mode" DROP NOT NULL,
ALTER COLUMN "payment_mode" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "credit_days" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payment_splits" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "payment_mode" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "payment_splits_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_splits" ADD CONSTRAINT "payment_splits_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
