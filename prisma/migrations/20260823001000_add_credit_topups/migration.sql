CREATE TYPE "CreditTopupStatus" AS ENUM ('pending', 'approved');

CREATE TABLE "credit_topups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 1,
    "creditAmount" DECIMAL(20, 6) NOT NULL,
    "slipImage" VARCHAR(500) NOT NULL,
    "status" "CreditTopupStatus" NOT NULL DEFAULT 'pending',
    "requestedById" UUID NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_topups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_topups_type_check" CHECK ("type" = 1),
    CONSTRAINT "credit_topups_credit_amount_check" CHECK ("creditAmount" > 0)
);

CREATE INDEX "credit_topups_companyId_createdAt_idx"
ON "credit_topups"("companyId", "createdAt");

CREATE INDEX "credit_topups_status_createdAt_idx"
ON "credit_topups"("status", "createdAt");

CREATE INDEX "credit_topups_requestedById_createdAt_idx"
ON "credit_topups"("requestedById", "createdAt");

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "company"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "AdminMember"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_topups"
ADD CONSTRAINT "credit_topups_approvedById_fkey"
FOREIGN KEY ("approvedById") REFERENCES "AdminMember"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
