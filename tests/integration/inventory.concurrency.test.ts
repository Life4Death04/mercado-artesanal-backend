/**
 * Integration test — inventory concurrency (Slice 5 TDD, RED phase).
 *
 * Strategy: real Postgres on localhost:5433 (same test container used by
 * other integration suites). Does NOT mock prisma — exercises the real
 * $transaction + Prisma serialization semantics.
 *
 * Why real DB? The concurrency guarantee (RNF-11) cannot be proven with mocks.
 * The `decrementStock` implementation relies on Postgres row-level locking
 * semantics inside a `$transaction`. Only a real DB can verify that exactly
 * one of two concurrent callers wins and the other gets InsufficientStockError.
 *
 * Scenarios covered:
 *
 *   [IC1] Concurrent decrements never oversell
 *     GIVEN  a product with stock = 1
 *     WHEN   two concurrent decrementStock(id, 1) calls execute (Promise.allSettled)
 *     THEN   exactly one commits successfully → stock = 0
 *     AND    the other throws InsufficientStockError (409)
 *     AND    the DB shows stock = 0 (no negative, no oversell)
 *
 *   [IC2] findLowStock cross-column filter — only products where stock <= lowStockThreshold returned
 *     GIVEN  Prod1(stock=5, lowStockThreshold=5) — at threshold → MUST appear
 *     AND    Prod2(stock=3, lowStockThreshold=2) — above threshold → MUST NOT appear
 *     AND    Prod3(stock=0, lowStockThreshold=5) — below threshold → MUST appear
 *     WHEN   findLowStock is called for the owning producer
 *     THEN   only Prod1 and Prod3 appear in the result
 *     AND    Prod2 is excluded because stock(3) > lowStockThreshold(2)
 *
 * Spec references:
 *   inventory §"Concurrent decrements never oversell" (RNF-11)
 *   inventory §"Product at threshold appears in low-stock list"
 *   inventory §"Low-stock query" (stock <= lowStockThreshold requirement)
 *   design    §"Testing Strategy" — concurrency test (Gap #3)
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent false-greens.
 * The CI pipeline MUST start the postgres container before running `pnpm test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { InsufficientStockError } from "@/shared/errors/errors";
import * as inventoryService from "@/modules/inventory/services/inventory.service";

// ---------------------------------------------------------------------------
// Real Prisma client for setup/teardown — not the singleton
// This avoids interference with other test files that mock the singleton.
// ---------------------------------------------------------------------------
const db = new PrismaClient();

// ---------------------------------------------------------------------------
// DB reachability — set in beforeAll; tests call ctx.skip() when false.
// Using ctx.skip() rather than describe.skipIf because skipIf is evaluated
// at collection time (before beforeAll runs), so the flag would always be false.
// ---------------------------------------------------------------------------
let dbReachable = false;

async function isDbReachable(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared test state (IC1)
// ---------------------------------------------------------------------------
let testProductId: string;
let testProducerId: string;
let testCategoryId: string;

// ---------------------------------------------------------------------------
// Shared test state (IC2 — cross-column filter)
// ---------------------------------------------------------------------------
let ic2ProducerId: string;
let ic2ProductAtThresholdId: string;   // stock=5, lowStockThreshold=5 → included
let ic2ProductAboveThresholdId: string; // stock=3, lowStockThreshold=2 → excluded
let ic2ProductBelowThresholdId: string; // stock=0, lowStockThreshold=5 → included

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbReachable = await isDbReachable();
  if (!dbReachable) {
    return;
  }

  // ── IC1 seed ──────────────────────────────────────────────────────────────
  const user = await db.user.upsert({
    where: { auth0Sub: "test-inventory-concurrency-user" },
    create: {
      auth0Sub: "test-inventory-concurrency-user",
      email: "inventory-concurrency@test.local",
      role: "PRODUCER",
    },
    update: {},
  });

  const producer = await db.producer.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      businessName: "Test Inventory Producer",
      nif: "B99999987",
      description: "Producer for inventory concurrency tests",
      addressLine1: "Calle Test 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  testProducerId = producer.id;

  const category = await db.category.upsert({
    where: { slug: "test-inventory-cat" },
    create: {
      slug: "test-inventory-cat",
      name: "Test Inventory Category",
      isActive: true,
    },
    update: {},
  });
  testCategoryId = category.id;

  const product = await db.product.create({
    data: {
      producerId: testProducerId,
      categoryId: testCategoryId,
      name: "Producto Concurrencia Test",
      description: "Used only for concurrency test",
      price: 1.0,
      stock: 1,
      lowStockThreshold: 5,
      isActive: true,
    },
  });
  testProductId = product.id;

  // ── IC2 seed ──────────────────────────────────────────────────────────────
  const ic2User = await db.user.upsert({
    where: { auth0Sub: "test-inventory-crosscol-user" },
    create: {
      auth0Sub: "test-inventory-crosscol-user",
      email: "inventory-crosscol@test.local",
      role: "PRODUCER",
    },
    update: {},
  });

  const ic2Producer = await db.producer.upsert({
    where: { userId: ic2User.id },
    create: {
      userId: ic2User.id,
      businessName: "Test Cross-Column Producer",
      nif: "B88888876",
      description: "Producer for cross-column filter tests",
      addressLine1: "Calle Cross 2",
      addressCity: "Barcelona",
      addressPostalCode: "08001",
      addressProvince: "Barcelona",
    },
    update: {},
  });
  ic2ProducerId = ic2Producer.id;

  // Prod1: stock=5, lowStockThreshold=5 → stock <= threshold → MUST appear
  const prod1 = await db.product.create({
    data: {
      producerId: ic2ProducerId,
      categoryId: testCategoryId,
      name: "Aceite IC2 AtThreshold",
      description: "stock=5, lowStockThreshold=5",
      price: 10.0,
      stock: 5,
      lowStockThreshold: 5,
      isActive: true,
    },
  });
  ic2ProductAtThresholdId = prod1.id;

  // Prod2: stock=3, lowStockThreshold=2 → stock(3) > threshold(2) → MUST NOT appear
  const prod2 = await db.product.create({
    data: {
      producerId: ic2ProducerId,
      categoryId: testCategoryId,
      name: "Miel IC2 AboveThreshold",
      description: "stock=3, lowStockThreshold=2",
      price: 8.0,
      stock: 3,
      lowStockThreshold: 2,
      isActive: true,
    },
  });
  ic2ProductAboveThresholdId = prod2.id;

  // Prod3: stock=0, lowStockThreshold=5 → stock(0) <= threshold(5) → MUST appear
  const prod3 = await db.product.create({
    data: {
      producerId: ic2ProducerId,
      categoryId: testCategoryId,
      name: "Queso IC2 BelowThreshold",
      description: "stock=0, lowStockThreshold=5",
      price: 15.0,
      stock: 0,
      lowStockThreshold: 5,
      isActive: true,
    },
  });
  ic2ProductBelowThresholdId = prod3.id;
});

afterAll(async () => {
  if (dbReachable) {
    if (testProductId) {
      await db.product.deleteMany({ where: { id: testProductId } });
    }
    // Clean up IC2 products
    const ic2Ids = [
      ic2ProductAtThresholdId,
      ic2ProductAboveThresholdId,
      ic2ProductBelowThresholdId,
    ].filter(Boolean);
    if (ic2Ids.length) {
      await db.product.deleteMany({ where: { id: { in: ic2Ids } } });
    }
  }
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// [IC1] Concurrency — decrementStock never oversells
// ---------------------------------------------------------------------------

describe("inventory concurrency — decrementStock never oversells [IC1]", () => {
  it(
    "exactly one of two concurrent decrements commits; the other throws InsufficientStockError; DB shows stock = 0",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      // GIVEN: product with stock = 1 (set in beforeAll)
      const before = await db.product.findUniqueOrThrow({
        where: { id: testProductId },
        select: { stock: true },
      });
      expect(before.stock).toBe(1);

      // WHEN: two concurrent decrementStock(id, 1) calls
      const [result1, result2] = await Promise.allSettled([
        inventoryService.decrementStock(testProductId, 1),
        inventoryService.decrementStock(testProductId, 1),
      ]);

      // THEN: exactly one succeeds (fulfilled) and one fails (rejected)
      const fulfilled = [result1, result2].filter((r) => r.status === "fulfilled");
      const rejected = [result1, result2].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // AND: the rejection is InsufficientStockError (409)
      const rejectedResult = rejected[0] as PromiseRejectedResult;
      expect(rejectedResult.reason).toBeInstanceOf(InsufficientStockError);
      expect((rejectedResult.reason as InsufficientStockError).status).toBe(409);
      expect((rejectedResult.reason as InsufficientStockError).code).toBe("INSUFFICIENT_STOCK");

      // AND: the DB shows stock = 0 (no oversell, no negative)
      const after = await db.product.findUniqueOrThrow({
        where: { id: testProductId },
        select: { stock: true },
      });
      expect(after.stock).toBe(0);
    },
    15000, // 15 s timeout for DB round-trips
  );
});

// ---------------------------------------------------------------------------
// [IC2] Cross-column filter — findLowStock enforces stock <= lowStockThreshold
// ---------------------------------------------------------------------------

describe("inventory findLowStock — cross-column filter [IC2]", () => {
  it(
    "returns only products where stock <= lowStockThreshold; excludes products where stock > lowStockThreshold",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      // GIVEN: three products with distinct stock/threshold combinations (seeded in beforeAll)
      // Prod1: stock=5, lowStockThreshold=5 → included (at threshold)
      // Prod2: stock=3, lowStockThreshold=2 → excluded (above threshold)
      // Prod3: stock=0, lowStockThreshold=5 → included (below threshold)

      // WHEN: findLowStock is called for ic2ProducerId
      const result = await inventoryService.findLowStock({
        producerId: ic2ProducerId,
      });

      // THEN: only Prod1 and Prod3 are returned
      const ids = result.map((p) => p.id);
      expect(ids).toContain(ic2ProductAtThresholdId);    // stock=5 <= threshold=5 ✓
      expect(ids).toContain(ic2ProductBelowThresholdId); // stock=0 <= threshold=5 ✓
      expect(ids).not.toContain(ic2ProductAboveThresholdId); // stock=3 > threshold=2 ✗

      // AND: exactly 2 results for this producer
      expect(result).toHaveLength(2);

      // AND: ordered by stock ASC (Prod3 stock=0 first, Prod1 stock=5 second)
      expect(result[0]!.id).toBe(ic2ProductBelowThresholdId); // stock=0
      expect(result[1]!.id).toBe(ic2ProductAtThresholdId);    // stock=5
    },
    15000,
  );
});
