-- A LINE message ID is stable across webhook redelivery. Keep NULL values
-- allowed for postbacks/system messages, but reject duplicate real message IDs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "LineChatHistory"
    WHERE "lineMessageId" IS NOT NULL
    GROUP BY "lineMessageId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add unique LineChatHistory.lineMessageId index: duplicate message IDs exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "LineChatHistory_lineMessageId_idx";

CREATE UNIQUE INDEX "LineChatHistory_lineMessageId_key"
ON "LineChatHistory"("lineMessageId");
