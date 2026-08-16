-- Admin user management (account-lifecycle WU1): reversible deactivation +
-- irreversible tombstone deletion (existing deleted_at column already
-- covers deletion; this migration adds ONLY the additive deactivation
-- timestamp, the ACCOUNT_ACTIVATED notification type, and the listing/read
-- indexes admin discovery + activity counts rely on). Additive-only — null
-- deactivated_at means active, no backfill required.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_ACTIVATED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deactivated_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "users_role_created_at_id_idx" ON "users"("role", "created_at" DESC, "id" DESC);
