-- demo-guest-environment (WU1): demo/guest identity flag on "users". The flag
-- is orthogonal to "role" — a demo account keeps its real role and therefore
-- its existing access — so no role data is rewritten here. Additive-only: the
-- single new column carries a NOT NULL DEFAULT false, which makes the change
-- backfill-free (Postgres fills existing rows from the default). A false value
-- means an ordinary account; only the seeded demo users are set to true.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false;
