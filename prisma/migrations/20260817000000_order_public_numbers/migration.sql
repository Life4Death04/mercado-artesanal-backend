-- order-public-numbers WU1: actor-scoped public references for
-- Order/SubOrder. Staged as nullable columns -> deterministic backfill ->
-- seeded counters -> invariants -> NOT NULL, safe on both a clean database
-- (no-op backfill) and an upgraded one with existing rows.
--
-- CHECK constraints are raw SQL only — Prisma has no declarative CHECK
-- support (same precedent as the partial unique index on "addresses", see
-- that model's comment in schema.prisma) — invisible to `prisma migrate
-- diff`, no schema drift.

-- Step 1: add nullable columns (safe on tables with existing rows).
ALTER TABLE "orders" ADD COLUMN "order_number" INTEGER;
ALTER TABLE "sub_orders" ADD COLUMN "sub_order_number" INTEGER;

-- Step 2: create allocation counter tables. Empty on a clean database.
CREATE TABLE "order_number_counters" (
    "user_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "order_number_counters_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "sub_order_number_counters" (
    "producer_id" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "sub_order_number_counters_pkey" PRIMARY KEY ("producer_id")
);

-- Step 3: deterministic backfill — contiguous 1..N per actor, ordered by
-- (created_at, id). No-op when "orders"/"sub_orders" are empty.
WITH ranked_orders AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "created_at", "id") AS rn
    FROM "orders"
)
UPDATE "orders" AS o
SET "order_number" = ranked_orders.rn
FROM ranked_orders
WHERE o."id" = ranked_orders."id";

WITH ranked_sub_orders AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "producer_id" ORDER BY "created_at", "id") AS rn
    FROM "sub_orders"
)
UPDATE "sub_orders" AS s
SET "sub_order_number" = ranked_sub_orders.rn
FROM ranked_sub_orders
WHERE s."id" = ranked_sub_orders."id";

-- Step 4: seed each actor's counter at its backfilled maximum. Actors with
-- no existing rows get no counter row and allocate 1 on first runtime insert.
INSERT INTO "order_number_counters" ("user_id", "last_number")
SELECT "user_id", MAX("order_number")
FROM "orders"
WHERE "order_number" IS NOT NULL
GROUP BY "user_id";

INSERT INTO "sub_order_number_counters" ("producer_id", "last_number")
SELECT "producer_id", MAX("sub_order_number")
FROM "sub_orders"
WHERE "sub_order_number" IS NOT NULL
GROUP BY "producer_id";

-- Step 5: positive-value invariants — committed numbers MUST be positive.
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_number_positive_check" CHECK ("order_number" > 0);
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_sub_order_number_positive_check" CHECK ("sub_order_number" > 0);
ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_last_number_positive_check" CHECK ("last_number" > 0);
ALTER TABLE "sub_order_number_counters" ADD CONSTRAINT "sub_order_number_counters_last_number_positive_check" CHECK ("last_number" > 0);

-- Step 6: scoped uniqueness invariant backstops. Names match Prisma's
-- default `@@unique` naming convention so `prisma migrate diff` reports no
-- drift against schema.prisma.
CREATE UNIQUE INDEX "orders_user_id_order_number_key" ON "orders"("user_id", "order_number");
CREATE UNIQUE INDEX "sub_orders_producer_id_sub_order_number_key" ON "sub_orders"("producer_id", "sub_order_number");

-- Step 7: require the column now that every row is backfilled.
ALTER TABLE "orders" ALTER COLUMN "order_number" SET NOT NULL;
ALTER TABLE "sub_orders" ALTER COLUMN "sub_order_number" SET NOT NULL;
