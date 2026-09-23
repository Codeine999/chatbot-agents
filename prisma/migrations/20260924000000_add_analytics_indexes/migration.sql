-- Indexes backing the admin analytics endpoints (/api/admin/analytics/*),
-- which range-scan by createdAt.

-- CreateIndex
CREATE INDEX "lineChatHistory_createdAt_idx" ON "lineChatHistory"("createdAt");

-- CreateIndex
CREATE INDEX "lineChatHistory_sender_createdAt_idx" ON "lineChatHistory"("sender", "createdAt");

-- CreateIndex
CREATE INDEX "payment_status_createdAt_idx" ON "payment"("status", "createdAt");
