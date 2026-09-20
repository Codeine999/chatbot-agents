-- Rich menus become tenant-owned, and the wording the bot answers with moves
-- out of application code into a table the tenant can edit.

-- 1. Admins administer exactly one company. Existing rows keep NULL, which is
--    the legacy single-tenant scope, so nothing changes for them until they
--    are backfilled deliberately.
ALTER TABLE "adminMember"
  ADD COLUMN "companyId" UUID;

ALTER TABLE "adminMember"
  ADD CONSTRAINT "adminMember_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "company"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "adminMember_companyId_idx" ON "adminMember"("companyId");

-- 2. Menus gain the same owner, plus the per-cell uploads a composited menu
--    image is built from.
ALTER TABLE "richMenuTemplate"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "cellImages" JSONB;

ALTER TABLE "richMenuTemplate"
  ADD CONSTRAINT "richMenuTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "richMenuTemplate_tenantId_status_updatedAt_idx"
  ON "richMenuTemplate"("tenantId", "status", "updatedAt");

-- richMenuTemplate.lineRichMenuId keeps its global unique index on purpose.
-- LINE issues rich menu IDs globally, and a per-tenant unique index would stop
-- enforcing anything at all inside the NULL-tenant scope this deployment runs in.

-- 3. What the bot replies with when a customer taps a button.
CREATE TABLE "richMenuReply" (
  "id"               UUID NOT NULL,
  "tenantId"         UUID,
  "key"              VARCHAR(64) NOT NULL,
  "label"            VARCHAR(100) NOT NULL,
  "replyText"        TEXT NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"        INTEGER NOT NULL DEFAULT 0,
  "createdByAdminId" UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "richMenuReply_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "richMenuReply"
  ADD CONSTRAINT "richMenuReply_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "richMenuReply_tenantId_key_key"
  ON "richMenuReply"("tenantId", "key");

-- Postgres treats every NULL as distinct, so the composite index above does
-- not constrain the NULL-tenant scope at all. This partial index is what
-- actually keeps two menu buttons from claiming the same key today.
-- It is intentionally not modelled in schema.prisma; `migrate diff` will
-- report it as an extra index.
CREATE UNIQUE INDEX "richMenuReply_key_unscoped_key"
  ON "richMenuReply"("key")
  WHERE "tenantId" IS NULL;

CREATE INDEX "richMenuReply_tenantId_active_idx"
  ON "richMenuReply"("tenantId", "active");
