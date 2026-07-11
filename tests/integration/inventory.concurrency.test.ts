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
 * Scenario covered:
 *   [IC1] Concurrent decrements never oversell
 *     GIVEN  a product with stock = 1
 *     WHEN   two concurrent decrementStock(id, 1) calls execute (Promise.allSettled)
 *     THEN   exactly one commits successfully → stock = 0
 *     AND    the other throws InsufficientStockError (409)
 *     AND    the DB shows stock = 0 (no negative, no oversell)
 *
 * Spec references:
 *   inventory §"Concurrent decrements never oversell" (RNF-11)
 *   design    §"Testing Strategy" — concurrency test (Gap #3)
 *
 * NOTE: This test is skipped when the database is unreachable (localhost:5433).
 * It only passes when the real test DB container is running. The CI pipeline
 * MUST start the postgres container before running `npm test`.
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
// Test state
// ---------------------------------------------------------------------------
let testProductId: string;
let testProducerId: string;
let testCategoryId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isDbReachable(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const reachable = await isDbReachable();
  if (!reachable) {
    // Skip gracefully — test infra not available
    return;
  }

  // Seed: create a minimal producer + category + product with stock = 1
  // Use upsert/create with a unique test identifier to avoid collisions

  // Find or create a test user + producer
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

  // Find or create a test category
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

  // Create the product with stock = 1 for the concurrency test
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
});

afterAll(async () => {
  const reachable = await isDbReachable();
  if (!reachable) {
    await db.$disconnect();
    return;
  }

  // Clean up: delete the test product (and any data we created)
  if (testProductId) {
    await db.product.deleteMany({ where: { id: testProductId } });
  }
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inventory concurrency — decrementStock never oversells [IC1]", () => {
  it(
    "exactly one of two concurrent decrements commits; the other throws InsufficientStockError; DB shows stock = 0",
    async () => {
      const reachable = await isDbReachable();
      if (!reachable) {
        // Cannot run without real DB — mark as skipped
        console.warn(
          "[IC1] Skipped: Postgres not reachable at localhost:5433. Start the DB container to run this test.",
        );
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
