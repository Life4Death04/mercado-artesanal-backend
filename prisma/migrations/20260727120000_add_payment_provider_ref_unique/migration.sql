-- Cycle 4 orders WU1 — additive migration (design Decision 4, webhook idempotency backstop).
--
-- Adds a UNIQUE constraint to payments.provider_ref. Order.status also gets a
-- schema-only doc comment in this same cycle (design Decision 2) — that change
-- is Prisma-client-comment-only and produces NO SQL, so it is not reflected below.
--
-- Safety: provider_ref is a NULLABLE column (Postgres treats multiple NULLs as
-- distinct under a UNIQUE index, so pre-existing NULL rows are unaffected).
-- Existing non-null duplicate provider_ref values (if any) would make this
-- migration fail to apply — none are expected pre-Cycle-4 since providerRef
-- was a STUB, unpopulated by any Cycle <= 3 write path.
--
-- Rollback: DROP INDEX "payments_provider_ref_key";
-- (no data changes to reverse — this migration only adds a constraint)

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_ref_key" ON "payments"("provider_ref");
