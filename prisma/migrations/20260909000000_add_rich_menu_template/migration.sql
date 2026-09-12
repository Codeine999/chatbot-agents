-- CreateEnum
CREATE TYPE "RichMenuStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "richMenuTemplate" (
    "id" UUID NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "chatBarText" VARCHAR(14) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "areas" JSONB NOT NULL,
    "imagePath" VARCHAR(500),
    "imageMimeType" VARCHAR(100),
    "imageBytes" INTEGER,
    "status" "RichMenuStatus" NOT NULL DEFAULT 'DRAFT',
    "lineRichMenuId" VARCHAR(100),
    "lineAliasId" VARCHAR(100),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "needsRepublish" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "lastPublishError" TEXT,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "richMenuTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "richMenuTemplate_lineRichMenuId_key" ON "richMenuTemplate"("lineRichMenuId");

-- CreateIndex
CREATE INDEX "richMenuTemplate_status_updatedAt_idx" ON "richMenuTemplate"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "richMenuTemplate_createdByAdminId_idx" ON "richMenuTemplate"("createdByAdminId");

-- AddForeignKey
ALTER TABLE "richMenuTemplate" ADD CONSTRAINT "richMenuTemplate_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "adminMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
