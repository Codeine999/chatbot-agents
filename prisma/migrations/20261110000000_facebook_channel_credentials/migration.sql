-- CreateTable
CREATE TABLE "facebookChannels" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "channelKey" VARCHAR(32) NOT NULL,
    "pageId" VARCHAR(32) NOT NULL,
    "pageName" VARCHAR(255),
    "appSecretCiphertext" TEXT NOT NULL,
    "pageAccessTokenCiphertext" TEXT NOT NULL,
    "verifyTokenCiphertext" TEXT NOT NULL,
    "encKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "appSecretLast4" VARCHAR(4) NOT NULL,
    "pageAccessTokenLast4" VARCHAR(4) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "webhookSetAt" TIMESTAMP(3),
    "updatedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facebookChannels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facebookChannels_companyId_key" ON "facebookChannels"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "facebookChannels_channelKey_key" ON "facebookChannels"("channelKey");

-- CreateIndex
CREATE UNIQUE INDEX "facebookChannels_pageId_key" ON "facebookChannels"("pageId");

-- AddForeignKey
ALTER TABLE "facebookChannels" ADD CONSTRAINT "facebookChannels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
