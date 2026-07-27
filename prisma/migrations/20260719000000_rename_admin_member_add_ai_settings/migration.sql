ALTER TABLE "Admin" RENAME TO "AdminMember";
ALTER TABLE "AdminMember" RENAME CONSTRAINT "Admin_pkey" TO "AdminMember_pkey";
ALTER INDEX "Admin_username_key" RENAME TO "AdminMember_username_key";
ALTER INDEX "Admin_email_key" RENAME TO "AdminMember_email_key";
ALTER INDEX "Admin_phone_key" RENAME TO "AdminMember_phone_key";

ALTER TABLE "AdminMember" RENAME COLUMN "firstName" TO "firstname";
ALTER TABLE "AdminMember" RENAME COLUMN "lastName" TO "lastname";
ALTER TABLE "AdminMember" RENAME COLUMN "picture" TO "image";

CREATE TABLE "admin_ai_provider_settings" (
    "id" UUID NOT NULL,
    "adminMemberId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedProviders" "AiProviderName"[] NOT NULL DEFAULT ARRAY['GEMINI', 'OPENAI', 'ANTHROPIC']::"AiProviderName"[],
    "provider" "AiProviderName" NOT NULL DEFAULT 'GEMINI',
    "model" VARCHAR(150) NOT NULL DEFAULT 'gemini-3.1-flash-lite',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_ai_provider_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_ai_provider_settings_adminMemberId_key"
ON "admin_ai_provider_settings"("adminMemberId");

ALTER TABLE "admin_ai_provider_settings"
ADD CONSTRAINT "admin_ai_provider_settings_adminMemberId_fkey"
FOREIGN KEY ("adminMemberId") REFERENCES "AdminMember"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
