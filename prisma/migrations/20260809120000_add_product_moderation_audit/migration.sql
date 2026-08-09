-- Add nullable admin-moderation audit columns to products (admin-catalog WU1).
-- Additive-only migration: no backfill required, existing rows are unaffected.
-- moderated_by/moderated_at/moderation_reason record the LATEST admin action,
-- kept distinct from report_reason (the reporter's original complaint).

-- AlterTable
ALTER TABLE "products"
ADD COLUMN "moderated_by" TEXT,
ADD COLUMN "moderated_at" TIMESTAMP(3),
ADD COLUMN "moderation_reason" TEXT;

-- CreateIndex
-- Supports the admin moderation queue read: GET /admin/products?moderationStatus=REPORTED
CREATE INDEX "products_moderation_status_idx" ON "products"("moderation_status");
