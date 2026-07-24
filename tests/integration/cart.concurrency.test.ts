/**
 * Integration test — cart concurrency (cycle-3/cart, PR #2 WU3-T2).
 *
 * Strategy: real Postgres on localhost:5433 (same test container used by
 * other integration suites, e.g. inventory.concurrency.test.ts). Does NOT
 * mock prisma — exercises the real prisma.$transaction + unique-constraint
 * semantics that make the double-upsert race-safe (NFR-3, D3).
 *
 * Why real DB? Race safety depends on Postgres enforcing `Cart.userId @unique`
 * and `CartItem @@unique([cartId, productId])` under concurrent writes. Only
 * a real DB can prove that concurrent upserts converge to the correct final
 * state instead of racing into duplicate rows or lost updates.
 *
 * Scenarios covered (design "Testing Strategy" — mirrors
 * tests/integration/inventory.concurrency.test.ts pattern; assertions target
 * final DB invariants, not settlement order):
 *
 *   [CC1] Concurrent first-add creates only one cart (spec R1-S2)
 *     GIVEN a user U with no Cart row
 *     WHEN two concurrent addItem calls arrive with distinct product ids P1, P2
 *     THEN exactly one Cart row exists for U at completion (Cart.userId @unique)
 *     AND both items end up attached to that single cart
 *
 *   [CC2] Concurrent same-product add upserts cleanly (spec R3-S5, NFR-3)
 *     GIVEN active product P with stock = 10 and user U with no cart item for P
 *     WHEN two concurrent addItem(P, qty=1) calls arrive
 *     THEN exactly ONE CartItem row exists for (cart, P) at completion
 *          (@@unique([cartId, productId]))
 *     AND its quantity equals the sum of successful adds (both increments
 *         applied), OR both requests resolve without duplicate-key errors
 *         surfacing to the caller (spec's stated acceptance criteria)
 *
 * Spec references:
 *   cart §"Scenario: Concurrent first-add creates only one cart"
 *   cart §"Scenario: Concurrent adds of the same product upsert cleanly"
 *   cart §NFR-3 (race-safe write — double-upsert, no find-then-create)
 *   design — D3 ($transaction callback form), Testing Strategy (concurrency)
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent false-greens.
 * The CI pipeline MUST start the postgres container before running `pnpm test`.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cartService from "@/modules/cart/services/cart.service";

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
// Shared test state — one producer/category serves both scenarios; each
// scenario uses its own consumer user (Cart.userId @unique is per-user).
// ---------------------------------------------------------------------------
let sharedProducerId: string;
let cc1UserId: string;
let cc1ProductP1Id: string;
let cc1ProductP2Id: string;
let cc2UserId: string;
let cc2ProductId: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dbReachable = await isDbReachable();
  if (!dbReachable) {
    return;
  }

  const category = await db.category.upsert({
    where: { slug: "test-cart-concurrency-cat" },
    create: { slug: "test-cart-concurrency-cat", name: "Test Cart Concurrency Category", isActive: true },
    update: {},
  });

  const producerUser = await db.user.upsert({
    where: { auth0Sub: "test-cart-concurrency-producer" },
    create: {
      auth0Sub: "test-cart-concurrency-producer",
      email: "cart-concurrency-producer@test.local",
      role: "PRODUCER",
    },
    update: {},
  });
  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: "Test Cart Concurrency Producer",
      nif: "B77777765",
      description: "Shared producer for cart concurrency tests",
      addressLine1: "Calle Concurrency 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  sharedProducerId = producer.id;

  // ── CC1 seed — distinct products for the concurrent first-add scenario ──
  const cc1User = await db.user.upsert({
    where: { auth0Sub: "test-cart-concurrency-cc1-user" },
    create: {
      auth0Sub: "test-cart-concurrency-cc1-user",
      email: "cart-concurrency-cc1@test.local",
      role: "CONSUMER",
    },
    update: {},
  });
  cc1UserId = cc1User.id;

  const [cc1P1, cc1P2] = await Promise.all([
    db.product.create({
      data: {
        producerId: sharedProducerId,
        categoryId: category.id,
        name: "CC1 Product P1",
        description: "Distinct product for concurrent first-add test",
        price: 10.0,
        stock: 20,
        isActive: true,
      },
    }),
    db.product.create({
      data: {
        producerId: sharedProducerId,
        categoryId: category.id,
        name: "CC1 Product P2",
        description: "Distinct product for concurrent first-add test",
        price: 8.0,
        stock: 20,
        isActive: true,
      },
    }),
  ]);
  cc1ProductP1Id = cc1P1.id;
  cc1ProductP2Id = cc1P2.id;

  // ── CC2 seed — single product targeted by two concurrent same-product adds ──
  const cc2User = await db.user.upsert({
    where: { auth0Sub: "test-cart-concurrency-cc2-user" },
    create: {
      auth0Sub: "test-cart-concurrency-cc2-user",
      email: "cart-concurrency-cc2@test.local",
      role: "CONSUMER",
    },
    update: {},
  });
  cc2UserId = cc2User.id;

  const cc2Product = await db.product.create({
    data: {
      producerId: sharedProducerId,
      categoryId: category.id,
      name: "CC2 Product",
      description: "Same product targeted by two concurrent adds",
      price: 5.0,
      stock: 10,
      isActive: true,
    },
  });
  cc2ProductId = cc2Product.id;
});

afterAll(async () => {
  if (dbReachable) {
    const productIds = [cc1ProductP1Id, cc1ProductP2Id, cc2ProductId].filter(Boolean);
    await db.cartItem.deleteMany({ where: { productId: { in: productIds } } });
    await db.cart.deleteMany({ where: { userId: { in: [cc1UserId, cc2UserId].filter(Boolean) } } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
  }
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// [CC1] Concurrent first-add creates only one cart
// ---------------------------------------------------------------------------

describe("cart concurrency — concurrent first-add creates only one cart [CC1]", () => {
  it(
    "exactly one Cart row exists for the user after two concurrent addItem calls with distinct products",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      // WHEN: two concurrent first-add requests with distinct products
      const [result1, result2] = await Promise.allSettled([
        cartService.addItem(cc1UserId, cc1ProductP1Id, 1),
        cartService.addItem(cc1UserId, cc1ProductP2Id, 1),
      ]);

      // THEN: both succeed (distinct products never collide on the item-level unique)
      expect(result1.status).toBe("fulfilled");
      expect(result2.status).toBe("fulfilled");

      // AND: exactly one Cart row exists for this user (Cart.userId @unique)
      const carts = await db.cart.findMany({ where: { userId: cc1UserId } });
      expect(carts).toHaveLength(1);

      // AND: both items are attached to that single cart
      const items = await db.cartItem.findMany({ where: { cartId: carts[0]!.id } });
      const productIds = items.map((i) => i.productId).sort();
      expect(productIds).toEqual([cc1ProductP1Id, cc1ProductP2Id].sort());
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// [CC2] Concurrent same-product add upserts cleanly
// ---------------------------------------------------------------------------

describe("cart concurrency — concurrent same-product add upserts cleanly [CC2]", () => {
  it(
    "exactly one CartItem row exists for (cart, product) with summed quantity; no duplicate-key error surfaces",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      // WHEN: two concurrent addItem calls for the SAME product
      const [result1, result2] = await Promise.allSettled([
        cartService.addItem(cc2UserId, cc2ProductId, 1),
        cartService.addItem(cc2UserId, cc2ProductId, 1),
      ]);

      // THEN: both requests resolve without a duplicate-key error surfacing
      expect(result1.status).toBe("fulfilled");
      expect(result2.status).toBe("fulfilled");

      // AND: exactly ONE CartItem row exists for (cart, product) — no duplicate rows
      const cart = await db.cart.findUniqueOrThrow({ where: { userId: cc2UserId } });
      const items = await db.cartItem.findMany({
        where: { cartId: cart.id, productId: cc2ProductId },
      });
      expect(items).toHaveLength(1);

      // AND: quantity equals the sum of both successful increments
      expect(items[0]!.quantity).toBe(2);
    },
    15000,
  );
});
