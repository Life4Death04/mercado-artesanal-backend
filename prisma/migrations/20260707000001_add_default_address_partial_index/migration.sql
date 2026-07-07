-- R-2 (LOCKED): Partial unique index enforcing "at most one active default address per user".
-- Prisma cannot express a WHERE-clause partial unique index declaratively,
-- so this index is managed here as a raw SQL migration.
--
-- The partial unique index guarantees that even under concurrent write races
-- (two transactions racing to set isDefault=true for the same userId),
-- only one will succeed. The losing transaction gets Postgres error 23505
-- (unique_violation) scoped to this index, which the address repository
-- translates to a retryable conflict error.
--
-- See: design.md §10 (R-2 concurrency), address-book spec (P-4 invariant)
CREATE UNIQUE INDEX "one_default_address_per_user"
  ON "addresses" ("user_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;
