-- The Company model existed in the Prisma schema before it was referenced by
-- the credit billing migrations, but no migration created its table. Keep this
-- migration idempotent because some existing databases were bootstrapped with
-- `prisma db push` and already contain the table.
CREATE TABLE IF NOT EXISTS "company" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "messagesSentPeriod" VARCHAR(7) NOT NULL DEFAULT '',
    "messagesSentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);
