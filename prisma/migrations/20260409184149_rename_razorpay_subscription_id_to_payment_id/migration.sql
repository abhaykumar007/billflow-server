/*
  Warnings:

  - You are about to drop the column `razorpay_subscription_id` on the `Subscription` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "razorpay_subscription_id",
ADD COLUMN     "razorpay_payment_id" TEXT;
