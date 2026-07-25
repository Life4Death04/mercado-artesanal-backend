/**
 * Integration test — cart cross-user authorization (cycle-3/cart, PR #3 fix).
 *
 * Strategy: real Postgres on localhost:5433 (same test container used by
 * tests/integration/cart.concurrency.test.ts and cart.query-count.test.ts).
 * Does NOT mock prisma — exercises the real ownership guard
 * (`cartItem.findFirst({ where: { id, cart: { userId } } })`) that
 * `updateItemQuantity` and `removeItem` run before any write (NFR-6).
 *
 * Why real DB, not the mocked HTTP suite (tests/integration/cart.test.ts)?
 * [C-PATCH-3] and [C-DELITEM-2] in that file already prove the CODE PATH
 * returns 404 when `cartItem.findFirst` resolves to null — but the mock
 * always returns whatever the test stubs, so it can never prove the actual
 * SQL `cart: { userId }` filter rejects a real cross-user row. Judge B
 * (PR #24) flagged this exact gap: the ownership guard is implemented
 * correctly, but nothing exercises it against a second real user + real
 * Postgres row. This file closes that gap by seeding two real users with
 * real Cart/CartItem rows and calling the service directly against the
 * live database — mirroring the real-DB pattern already established for
 * cart concurrency/query-count proofs.
 *
 * Scenarios covered (spec §"PATCH on another user's item returns 404",
 * §"Scenario: Owner deletes their item", NFR-6):
 *
 *   [C-PATCH-AUTHZ] Cross-user PATCH is denied
 *     GIVEN user B has a cart item with quantity 2
 *     WHEN  user A (different user) calls updateItemQuantity on B's itemId
 *     THEN  NotFoundError (404) is thrown — no info leak, same status as
 *           an unknown itemId
 *     AND   B's item quantity in the DB is unchanged
 *
 *   [C-DELITEM-AUTHZ] Cross-user DELETE item is denied
 *     GIVEN user B has a cart item
 *     WHEN  user A (different user) calls removeItem on B's itemId
 *     THEN  NotFoundError (404) is thrown
 *     AND   B's item still exists in the DB (not deleted)
 *
 * Spec references:
 *   cart §"Scenario: PATCH on another user's item returns 404"
 *   cart §NFR-6 (no-leak 404 — same status for unknown vs. unowned)
 *   design — Data Flow, ownership guard pattern reused from addresses.service
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent false-greens.
 * The CI pipeline MUST start the postgres container before running `pnpm test`.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cartService from "@/modules/cart/services/cart.service";
import { NotFoundError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// Real Prisma client for setup/teardown — not the singleton under test.
// This avoids interference with other test files that mock the singleton.
// ---------------------------------------------------------------------------
const db = new PrismaClient();

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
// Shared test state — one producer/product serves both scenarios; user A
// (attacker) and user B (owner) are distinct real users with distinct carts.
// ---------------------------------------------------------------------------
let producerId: string;
let productId: string;
let userAId: string;
let userBId: string;
let bCartItemId: string;

beforeAll(async () => {
  dbReachable = await isDbReachable();
  if (!dbReachable) {
    return;
  }

  const category = await db.category.upsert({
    where: { slug: "test-cart-authz-cat" },
    create: { slug: "test-cart-authz-cat", name: "Test Cart Authz Category", isActive: true },
    update: {},
  });

  const producerUser = await db.user.upsert({
    where: { auth0Sub: "test-cart-authz-producer" },
    create: {
      auth0Sub: "test-cart-authz-producer",
      email: "cart-authz-producer@test.local",
      role: "PRODUCER",
    },
    update: {},
  });
  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: "Test Cart Authz Producer",
      nif: "B77777764",
      description: "Producer for cart cross-user authorization test",
      addressLine1: "Calle Authz 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  producerId = producer.id;

  const product = await db.product.create({
    data: {
      producerId,
      categoryId: category.id,
      name: "Cross-User Authz Product",
      description: "Product used to prove PATCH/DELETE ownership guards",
      price: 15.0,
      stock: 20,
      isActive: true,
    },
  });
  productId = product.id;

  const userA = await db.user.upsert({
    where: { auth0Sub: "test-cart-authz-user-a" },
    create: {
      auth0Sub: "test-cart-authz-user-a",
      email: "cart-authz-user-a@test.local",
      role: "CONSUMER",
    },
    update: {},
  });
  userAId = userA.id;

  const userB = await db.user.upsert({
    where: { auth0Sub: "test-cart-authz-user-b" },
    create: {
      auth0Sub: "test-cart-authz-user-b",
      email: "cart-authz-user-b@test.local",
      role: "CONSUMER",
    },
    update: {},
  });
  userBId = userB.id;

  // Seed B's cart with a real item — B is the ONLY owner. A never adds
  // anything of their own; A only ever attempts to reach B's item.
  const bItem = await cartService.addItem(userBId, productId, 2);
  bCartItemId = bItem.id;
});

afterAll(async () => {
  if (dbReachable) {
    await db.cartItem.deleteMany({ where: { productId } });
    await db.cart.deleteMany({ where: { userId: { in: [userAId, userBId].filter(Boolean) } } });
    await db.product.deleteMany({ where: { id: productId } });
  }
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// [C-PATCH-AUTHZ] Cross-user PATCH is denied
// ---------------------------------------------------------------------------

describe("cart cross-user authorization — PATCH /carrito/items/:itemId [C-PATCH-AUTHZ]", () => {
  it(
    "user A calling updateItemQuantity on user B's itemId gets NotFoundError (404) and B's quantity is unchanged",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      await expect(cartService.updateItemQuantity(userAId, bCartItemId, 9)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const rejection = await cartService
        .updateItemQuantity(userAId, bCartItemId, 9)
        .catch((err: unknown) => err);
      expect((rejection as NotFoundError).status).toBe(404);
      expect((rejection as NotFoundError).code).toBe("NOT_FOUND");

      const bItemInDb = await db.cartItem.findUnique({ where: { id: bCartItemId } });
      expect(bItemInDb).not.toBeNull();
      expect(bItemInDb!.quantity).toBe(2);
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// [C-DELITEM-AUTHZ] Cross-user DELETE item is denied
// ---------------------------------------------------------------------------

describe("cart cross-user authorization — DELETE /carrito/items/:itemId [C-DELITEM-AUTHZ]", () => {
  it(
    "user A calling removeItem on user B's itemId gets NotFoundError (404) and B's item still exists",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      await expect(cartService.removeItem(userAId, bCartItemId)).rejects.toBeInstanceOf(NotFoundError);

      const rejection = await cartService.removeItem(userAId, bCartItemId).catch((err: unknown) => err);
      expect((rejection as NotFoundError).status).toBe(404);
      expect((rejection as NotFoundError).code).toBe("NOT_FOUND");

      const bItemInDb = await db.cartItem.findUnique({ where: { id: bCartItemId } });
      expect(bItemInDb).not.toBeNull();
    },
    15000,
  );
});
