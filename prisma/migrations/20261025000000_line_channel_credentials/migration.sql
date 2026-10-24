BEGIN;
-- Additive only. A company without a row keeps using the LINE_CHANNEL_*
-- environment variables, so no backfill is needed. Rollback: DROP TABLE.
CREATE TABLE "lineChannels" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "channelKey" VARCHAR(32) NOT NULL,
    "channelId" VARCHAR(20),
    "botUserId" VARCHAR(40) NOT NULL,
    "basicId" VARCHAR(40),
    "displayName" VARCHAR(255),
    "secretCiphertext" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "encKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "secretLast4" VARCHAR(4) NOT NULL,
    "accessTokenLast4" VARCHAR(4) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "webhookSetAt" TIMESTAMP(3),
    "updatedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lineChannels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lineChannels_companyId_key" ON "lineChannels"("companyId");
CREATE UNIQUE INDEX "lineChannels_channelKey_key" ON "lineChannels"("channelKey");
CREATE UNIQUE INDEX "lineChannels_botUserId_key" ON "lineChannels"("botUserId");

ALTER TABLE "lineChannels" ADD CONSTRAINT "lineChannels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
