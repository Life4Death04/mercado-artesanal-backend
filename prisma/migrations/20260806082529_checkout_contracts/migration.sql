-- Cycle 5 checkout-contracts WU1 — single additive migration (design "Prisma
-- schema changes + migration").
--
-- Adds: `payments.user_id` (nullable, BE-2 ownership — design Fork 2),
-- six nullable `sub_orders.ship_to_*` columns (write-once address snapshot,
-- design Fork 4), and the new `pending_checkouts` table (immutable pre-
-- webhook snapshot + BE-2 ownership correlation, design Fork 1 / Fork 3).
--
-- Safety: every new/altered column is NULLABLE except
-- `pending_checkouts.user_id` (NOT NULL — only ever inserted, never added to
-- an existing row) and `pending_checkouts.address_*` (NOT NULL on a
-- brand-new table with zero pre-existing rows). No backfill. No destructive
-- SQL. Existing `payments`/`sub_orders` rows are unaffected.
--
-- Rollback:
--   DROP TABLE "pending_checkouts";
--   ALTER TABLE "sub_orders" DROP COLUMN "ship_to_line1", DROP COLUMN "ship_to_line2",
--     DROP COLUMN "ship_to_city", DROP COLUMN "ship_to_postal_code",
--     DROP COLUMN "ship_to_province", DROP COLUMN "ship_to_country";
--   ALTER TABLE "payments" DROP COLUMN "user_id";
-- (no data changes to reverse — this migration only adds columns/a table)

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "user_id" TEXT;

-- AlterTable
ALTER TABLE "sub_orders" ADD COLUMN     "ship_to_city" TEXT,
ADD COLUMN     "ship_to_country" TEXT,
ADD COLUMN     "ship_to_line1" TEXT,
ADD COLUMN     "ship_to_line2" TEXT,
ADD COLUMN     "ship_to_postal_code" TEXT,
ADD COLUMN     "ship_to_province" TEXT;

-- CreateTable
CREATE TABLE "pending_checkouts" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "provider_ref" TEXT,
    "user_id" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "address_city" TEXT NOT NULL,
    "address_postal_code" TEXT NOT NULL,
    "address_province" TEXT NOT NULL,
    "address_country" TEXT NOT NULL DEFAULT 'ES',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_checkouts_fingerprint_key" ON "pending_checkouts"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "pending_checkouts_provider_ref_key" ON "pending_checkouts"("provider_ref");

-- CreateIndex
CREATE INDEX "pending_checkouts_user_id_idx" ON "pending_checkouts"("user_id");

-- CreateIndex
CREATE INDEX "payments_user_id_idx" ON "payments"("user_id");
