-- Hold in-flight AI charges in aggregate wallet/budget counters.
ALTER TABLE "credit_wallets"
ADD COLUMN "reservedCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0;

ALTER TABLE "credit_budgets"
ADD COLUMN "reservedCredit" DECIMAL(20, 6) NOT NULL DEFAULT 0;
