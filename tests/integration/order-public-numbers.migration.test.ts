/**
 * Integration test — order-public-numbers WU1 migration (schema + backfill
 * only; allocator wiring lands in WU2). Real Postgres on localhost:5433, on
 * DISPOSABLE databases created/dropped per test (design "File Changes").
 * `mercado_test` is only an admin connection for CREATE/DROP DATABASE — no
 * rows in it are ever read or written by this file.
 *
 * The "upgraded" scenario needs pre-existing rows BEFORE
 * `20260817000000_order_public_numbers` runs; `prisma migrate deploy` has no
 * "deploy up to migration N" flag, so this file temporarily moves that
 * migration's folder out of prisma/migrations, seeds legacy-shaped rows,
 * restores it (always, via `finally`), then deploys again.
 *
 * Scenarios (tasks.md Phase 1, task 1.4):
 *   [Clean]    counts/nulls/uniqueness/positive from the first insert.
 *   [Upgraded] backfill rank/counter=MAX — rows across two actors per scope,
 *              seeded out of chronological order, get contiguous 1..N by
 *              (created_at, id).
 *
 * SKIP POLICY: ctx.skip() when the DB is unreachable (same as
 * tests/integration/inventory.concurrency.test.ts).
 */
import { existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const TEST_RUN_ID = Date.now();
const CLEAN_DB_NAME = `mercado_test_clean_pub_num_${TEST_RUN_ID}`;
const UPGRADED_DB_NAME = `mercado_test_upgraded_pub_num_${TEST_RUN_ID}`;

const TARGET_MIGRATION = "20260817000000_order_public_numbers";
const migrationSrcPath = path.join(process.cwd(), "prisma", "migrations", TARGET_MIGRATION);
const migrationHiddenPath = path.join(process.cwd(), `.hidden-${TARGET_MIGRATION}`);

const admin = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres:postgres@localhost:5433/mercado_test" } },
});

let dbReachable = false;

function dbUrlFor(name: string): string {
  return `postgresql://postgres:postgres@localhost:5433/${name}`;
}

function deployMigrations(databaseUrl: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
}

/** Runs `fn` while the new migration's folder is out of prisma/migrations,
 * so a `deployMigrations` call inside `fn` only applies migrations 1..13.
 * Always restores the folder, even on failure. */
async function withMigrationHidden<T>(fn: () => Promise<T>): Promise<T> {
  if (!existsSync(migrationSrcPath)) {
    throw new Error(`Expected migration folder not found: ${migrationSrcPath}`);
  }
  renameSync(migrationSrcPath, migrationHiddenPath);
  try {
    return await fn();
  } finally {
    renameSync(migrationHiddenPath, migrationSrcPath);
  }
}

beforeAll(async () => {
  try {
    await admin.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
  }
});

afterAll(async () => {
  for (const name of [CLEAN_DB_NAME, UPGRADED_DB_NAME]) {
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
    } catch {
      // best-effort cleanup — disposable DB, never asserted on again
    }
  }
  await admin.$disconnect();
});

describe("order-public-numbers migration — clean database", () => {
  it("applies with a no-op backfill and enforces nulls/positive/uniqueness on new rows", async (ctx) => {
    if (!dbReachable) return ctx.skip();

    await admin.$executeRawUnsafe(`CREATE DATABASE "${CLEAN_DB_NAME}"`);
    const cleanUrl = dbUrlFor(CLEAN_DB_NAME);
    deployMigrations(cleanUrl); // all 14 migrations, in order, on an empty DB

    const db = new PrismaClient({ datasources: { db: { url: cleanUrl } } });
    async function mkOrder(id: string, userId: string, orderNumber: number) {
      const payment = await db.payment.create({ data: { amount: 5, status: "SUCCEEDED" } });
      return db.order.create({
        data: { id, userId, paymentId: payment.id, totalAmount: 5, orderNumber },
      });
    }
    try {
      // Counts: no-op backfill leaves the counter table empty.
      const counters = await db.$queryRaw<
        { n: bigint }[]
      >`SELECT COUNT(*)::bigint AS n FROM order_number_counters`;
      expect(Number(counters[0]!.n)).toBe(0);

      // Nulls: order_number is NOT NULL even with zero pre-existing rows.
      const p0 = await db.payment.create({ data: { amount: 5, status: "SUCCEEDED" } });
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO orders (id, user_id, payment_id, total_amount, updated_at) VALUES ($1, $2, $3, $4, now())`,
          "order-clean-missing-number",
          "user-clean-1",
          p0.id,
          5,
        ),
      ).rejects.toThrow();

      // Ordering: two sequential numbers for the same new actor read back ascending.
      await mkOrder("order-clean-1", "user-clean-2", 1);
      await mkOrder("order-clean-2", "user-clean-2", 2);
      const ordered = await db.order.findMany({
        where: { userId: "user-clean-2" },
        orderBy: { orderNumber: "asc" },
        select: { orderNumber: true },
      });
      expect(ordered.map((o) => o.orderNumber)).toEqual([1, 2]);

      // Uniqueness: a second order-number 1 for the SAME actor is rejected.
      await expect(mkOrder("order-clean-dup", "user-clean-2", 1)).rejects.toThrow();

      // Positive: order_number <= 0 is rejected by the CHECK constraint.
      await expect(mkOrder("order-clean-neg", "user-clean-3", 0)).rejects.toThrow();
    } finally {
      await db.$disconnect();
    }
  }, 60000);
});

describe("order-public-numbers migration — upgraded database with pre-existing rows", () => {
  it("backfills contiguous 1..N per actor ordered by (created_at, id) and seeds each counter at MAX", async (ctx) => {
    if (!dbReachable) return ctx.skip();

    await admin.$executeRawUnsafe(`CREATE DATABASE "${UPGRADED_DB_NAME}"`);
    const upgradedUrl = dbUrlFor(UPGRADED_DB_NAME);

    // Deploy only migrations 1..13 (schema BEFORE order_number/sub_order_number exist).
    await withMigrationHidden(async () => deployMigrations(upgradedUrl));

    const db = new PrismaClient({ datasources: { db: { url: upgradedUrl } } });
    try {
      const [user1, user2] = await Promise.all([
        db.user.create({
          data: { auth0Sub: "producer1-sub", email: "p1@test.local", role: "PRODUCER" },
        }),
        db.user.create({
          data: { auth0Sub: "producer2-sub", email: "p2@test.local", role: "PRODUCER" },
        }),
      ]);
      const addr = {
        description: "d",
        addressLine1: "a",
        addressCity: "c",
        addressPostalCode: "28001",
        addressProvince: "p",
      };
      const producer1 = await db.producer.create({
        data: { ...addr, businessName: "P1", nif: "B11111112", userId: user1.id },
      });
      const producer2 = await db.producer.create({
        data: { ...addr, businessName: "P2", nif: "B22222223", userId: user2.id },
      });
      const deliveryMode = await db.deliveryMode.create({
        data: { producerId: producer1.id, type: "PICKUP", cost: 0, isActive: true },
      });

      // Legacy-shaped orders/sub_orders — raw SQL because the generated
      // Prisma client already expects order_number/sub_order_number, which
      // do not exist in the DB yet.
      const base = new Date("2024-01-01T00:00:00.000Z").getTime();
      const HOUR = 60 * 60 * 1000;

      async function seedOrder(id: string, userId: string, hoursOffset: number) {
        const payment = await db.payment.create({ data: { amount: 1, status: "SUCCEEDED" } });
        await db.$executeRawUnsafe(
          `INSERT INTO orders (id, user_id, payment_id, total_amount, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now())`,
          id,
          userId,
          payment.id,
          1,
          new Date(base + hoursOffset * HOUR),
        );
      }
      async function seedSubOrder(
        id: string,
        orderId: string,
        producerId: string,
        hoursOffset: number,
      ) {
        await db.$executeRawUnsafe(
          `INSERT INTO sub_orders (id, order_id, producer_id, delivery_mode_id, shipping_cost_snapshot, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
          id,
          orderId,
          producerId,
          deliveryMode.id,
          0,
          new Date(base + hoursOffset * HOUR),
        );
      }

      // userA inserted out of order (z, x, y) to prove backfill sorts by
      // created_at, not insertion order: oA-x(+1h)=1, oA-y(+2h)=2, oA-z(+3h)=3.
      await seedOrder("oA-z", "userA", 3);
      await seedOrder("oA-x", "userA", 1);
      await seedOrder("oA-y", "userA", 2);
      // userB: independent scope, starts at 1 regardless of userA's numbers.
      await seedOrder("oB-b", "userB", 5);
      await seedOrder("oB-a", "userB", 4);
      // userC has no pre-existing orders — proves "actors without history
      // begin at 1" by getting NO counter row seeded.

      await seedSubOrder("sP1-b", "oA-x", producer1.id, 2);
      await seedSubOrder("sP1-a", "oA-y", producer1.id, 1);
      await seedSubOrder("sP2-a", "oB-a", producer2.id, 1);

      // Restore the migration folder and deploy — only the new migration is pending.
      deployMigrations(upgradedUrl);

      const orders = await db.order.findMany({
        where: { id: { in: ["oA-x", "oA-y", "oA-z", "oB-a", "oB-b"] } },
        select: { id: true, orderNumber: true },
      });
      expect(Object.fromEntries(orders.map((o) => [o.id, o.orderNumber]))).toEqual({
        "oA-x": 1,
        "oA-y": 2,
        "oA-z": 3,
        "oB-a": 1,
        "oB-b": 2,
      });

      const subOrders = await db.subOrder.findMany({
        where: { id: { in: ["sP1-a", "sP1-b", "sP2-a"] } },
        select: { id: true, subOrderNumber: true },
      });
      expect(Object.fromEntries(subOrders.map((s) => [s.id, s.subOrderNumber]))).toEqual({
        "sP1-a": 1,
        "sP1-b": 2,
        "sP2-a": 1,
      });

      const orderCounters = await db.$queryRaw<{ user_id: string; last_number: number }[]>`
        SELECT user_id, last_number FROM order_number_counters WHERE user_id IN ('userA', 'userB', 'userC')`;
      expect(orderCounters.sort((a, b) => a.user_id.localeCompare(b.user_id))).toEqual([
        { user_id: "userA", last_number: 3 },
        { user_id: "userB", last_number: 2 },
      ]);

      const subOrderCounters = await db.$queryRaw<{ producer_id: string; last_number: number }[]>`
        SELECT producer_id, last_number FROM sub_order_number_counters WHERE producer_id IN (${producer1.id}, ${producer2.id})`;
      expect(subOrderCounters.sort((a, b) => a.producer_id.localeCompare(b.producer_id))).toEqual(
        [
          { producer_id: producer1.id, last_number: 2 },
          { producer_id: producer2.id, last_number: 1 },
        ].sort((a, b) => a.producer_id.localeCompare(b.producer_id)),
      );

      // NOT NULL is enforced going forward, even on already-backfilled rows.
      await expect(
        db.$executeRawUnsafe(`UPDATE orders SET order_number = NULL WHERE id = 'oA-x'`),
      ).rejects.toThrow();
    } finally {
      await db.$disconnect();
    }
  }, 60000);
});
