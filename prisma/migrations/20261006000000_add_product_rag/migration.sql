-- Additive Phase 2/3 only. Preserve catalog, money precision and existing ledger.
BEGIN;
CREATE TABLE "productVectors" (
  "productId" uuid PRIMARY KEY, "companyId" uuid NOT NULL,
  embedding vector(1536) NOT NULL, "embeddingModel" varchar(100) NOT NULL,
  "searchRevision" integer NOT NULL, "contentHash" varchar(64) NOT NULL,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("productId", "companyId") REFERENCES products(id, "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "productVectors_companyId_embeddingModel_idx" ON "productVectors"("companyId", "embeddingModel");
CREATE UNIQUE INDEX "productVectors_productId_companyId_key" ON "productVectors"("productId", "companyId");
CREATE INDEX "productVectors_embedding_hnsw_idx" ON "productVectors" USING hnsw (embedding vector_cosine_ops);
CREATE TABLE "productIndexJobs" (
  id uuid PRIMARY KEY, "companyId" uuid NOT NULL, "productId" uuid NOT NULL,
  "searchRevision" integer NOT NULL, "embeddingModel" varchar(100) NOT NULL,
  "contentHash" varchar(64) NOT NULL, document text NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
  "leaseOwner" uuid, "leaseUntil" timestamp(3), "lastErrorCode" varchar(100), "retryAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "productIndexJobs_state_check" CHECK (state IN ('PENDING','RUNNING','DONE','SUPERSEDED','FAILED')),
  FOREIGN KEY ("productId", "companyId") REFERENCES products(id, "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "productIndexJobs_productId_searchRevision_embeddingModel_key" ON "productIndexJobs"("productId", "searchRevision", "embeddingModel");
CREATE INDEX "productIndexJobs_state_retryAt_leaseUntil_idx" ON "productIndexJobs"(state, "retryAt", "leaseUntil");
CREATE TABLE "commerceTurns" (
  id uuid PRIMARY KEY, "companyId" uuid NOT NULL, "tenantId" uuid,
  "connectionKey" varchar(100) NOT NULL, "externalEventId" varchar(255) NOT NULL,
  "lineMemberId" uuid NOT NULL, "conversationId" uuid NOT NULL,
  provider varchar(30) NOT NULL, model varchar(100) NOT NULL, input jsonb NOT NULL,
  plan jsonb, retrieval jsonb, response jsonb, "leaseOwner" uuid, "leaseUntil" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL,
  FOREIGN KEY ("companyId") REFERENCES company(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("lineMemberId") REFERENCES "lineMember"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("conversationId") REFERENCES "lineConversation"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "commerceTurns_companyId_connectionKey_externalEventId_key" ON "commerceTurns"("companyId", "connectionKey", "externalEventId");
CREATE INDEX "commerceTurns_conversationId_createdAt_idx" ON "commerceTurns"("conversationId", "createdAt");
CREATE TABLE "commerceLlmCalls" (
  id uuid PRIMARY KEY, "turnId" uuid NOT NULL, slot varchar(30) NOT NULL, ordinal integer NOT NULL,
  request jsonb NOT NULL, result jsonb, failed boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerceLlmCalls_ordinal_check" CHECK (ordinal BETWEEN 1 AND 3),
  CONSTRAINT "commerceLlmCalls_third_call_check" CHECK (ordinal < 3 OR slot = 'CRITICAL_REPAIR'),
  FOREIGN KEY ("turnId") REFERENCES "commerceTurns"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "commerceLlmCalls_turnId_slot_key" ON "commerceLlmCalls"("turnId", slot);
CREATE UNIQUE INDEX "commerceLlmCalls_turnId_ordinal_key" ON "commerceLlmCalls"("turnId", ordinal);
COMMIT;
