-- Credit limits are persistent per scope (for example one admin id), not monthly.
-- Merge any historical period rows before replacing the unique key.
CREATE TEMP TABLE "credit_budget_merge" AS
SELECT
  "id" AS "oldId",
  FIRST_VALUE("id") OVER (
    PARTITION BY "walletId", "kind", "scopeKey"
    ORDER BY "period" DESC, "createdAt" DESC
  ) AS "keeperId"
FROM "credit_budgets";

WITH totals AS (
  SELECT
    merge."keeperId",
    SUM(budget."usedCredit") AS "usedCredit",
    SUM(budget."reservedCredit") AS "reservedCredit"
  FROM "credit_budget_merge" AS merge
  INNER JOIN "credit_budgets" AS budget ON budget."id" = merge."oldId"
  GROUP BY merge."keeperId"
)
UPDATE "credit_budgets" AS keeper
SET
  "usedCredit" = totals."usedCredit",
  "reservedCredit" = totals."reservedCredit"
FROM totals
WHERE keeper."id" = totals."keeperId";

DELETE FROM "credit_budgets" AS budget
USING "credit_budget_merge" AS merge
WHERE budget."id" = merge."oldId"
  AND merge."oldId" <> merge."keeperId";

DROP INDEX "credit_budgets_walletId_kind_scopeKey_period_key";
ALTER TABLE "credit_budgets" DROP COLUMN "period";

CREATE UNIQUE INDEX "credit_budgets_walletId_kind_scopeKey_key"
ON "credit_budgets"("walletId", "kind", "scopeKey");
