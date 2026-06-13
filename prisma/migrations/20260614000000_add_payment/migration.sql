-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('QRcode', 'Slip');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'success', 'fail', 'reject');

-- CreateTable
CREATE TABLE "Payment" (
    "uuid" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approveBy" UUID,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("uuid")
);

-- CreateIndex
CREATE INDEX "Payment_username_idx" ON "Payment"("username");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_approveBy_idx" ON "Payment"("approveBy");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_username_fkey" FOREIGN KEY ("username") REFERENCES "Member"("username") ON DELETE RESTRICT ON UPDATE CASCADE;
