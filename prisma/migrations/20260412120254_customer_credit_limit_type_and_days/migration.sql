-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "credit_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credit_limit_type" TEXT NOT NULL DEFAULT 'soft';
