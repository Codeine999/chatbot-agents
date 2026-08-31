-- Every normal admin must have a finite ADMIN_AI_QUERY budget before calling
-- a paid provider. Existing accounts start locked at zero until owner/dev sets
-- their allowance through the admin AI budget endpoint.
INSERT INTO "credit_budgets" (
  "id",
  "walletId",
  "kind",
  "scopeKey",
  "limitCredit",
  "usedCredit",
  "reservedCredit",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  wallet."id",
  'ADMIN_AI_QUERY'::"UsageKind",
  admin."id"::text,
  0,
  0,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "AdminMember" AS admin
CROSS JOIN "credit_wallets" AS wallet
WHERE admin."role" = 'admin'::"AdminRole"
  AND NOT EXISTS (
    SELECT 1
    FROM "credit_budgets" AS budget
    WHERE budget."walletId" = wallet."id"
      AND budget."kind" = 'ADMIN_AI_QUERY'::"UsageKind"
      AND budget."scopeKey" = admin."id"::text
  );
