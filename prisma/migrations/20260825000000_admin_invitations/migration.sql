-- Refuse the migration before creating the case-insensitive unique index when
-- any users, including soft-deleted users, collide after lowercasing.
DO $$
DECLARE
    duplicate_emails TEXT;
BEGIN
    SELECT string_agg(format('%s (%s rows)', normalized_email, row_count), ', ' ORDER BY normalized_email)
    INTO duplicate_emails
    FROM (
        SELECT LOWER("email") AS normalized_email, COUNT(*) AS row_count
        FROM "users"
        GROUP BY LOWER("email")
        HAVING COUNT(*) > 1
    ) AS duplicates;

    IF duplicate_emails IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create users_email_lower_key: case-insensitive duplicate user emails exist: %', duplicate_emails
            USING HINT = 'Resolve every duplicate, including soft-deleted users, before retrying this migration.';
    END IF;
END $$;

-- Prisma 5 cannot represent functional indexes. Keep users_email_key and add
-- this index as the database-level case-insensitive uniqueness backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" (LOWER("email"));

-- CreateEnum
CREATE TYPE "AdminInvitationStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'COMPENSATING',
    'COMPENSATED'
);

-- CreateEnum
CREATE TYPE "AdminInvitationStep" AS ENUM (
    'CREATE_IDENTITY',
    'CREATE_LOCAL_USER',
    'SEND_INVITATION',
    'COMPLETE'
);

-- CreateTable
CREATE TABLE "admin_invitations" (
    "id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "AdminInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "step" "AdminInvitationStep" NOT NULL DEFAULT 'CREATE_IDENTITY',
    "created_by_id" TEXT NOT NULL,
    "invited_user_id" TEXT,
    "auth0_sub" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_invitations_email_lowercase_check" CHECK ("email" = LOWER("email")),
    CONSTRAINT "admin_invitations_attempt_count_check" CHECK ("attempt_count" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_invitations_request_key_key" ON "admin_invitations"("request_key");
CREATE UNIQUE INDEX "admin_invitations_invited_user_id_key" ON "admin_invitations"("invited_user_id");
CREATE UNIQUE INDEX "admin_invitations_auth0_sub_key" ON "admin_invitations"("auth0_sub");
CREATE INDEX "admin_invitations_status_next_attempt_at_idx" ON "admin_invitations"("status", "next_attempt_at");
CREATE INDEX "admin_invitations_status_lease_expires_at_idx" ON "admin_invitations"("status", "lease_expires_at");
CREATE INDEX "admin_invitations_created_by_id_created_at_id_idx" ON "admin_invitations"("created_by_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_invited_user_id_fkey"
    FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
