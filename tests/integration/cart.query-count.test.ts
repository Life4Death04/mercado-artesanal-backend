/**
 * Integration test — cart NFR-1 query-count proof (cycle-3/cart, PR #2 fix).
 *
 * Strategy: real Postgres on localhost:5433 (same test container used by
 * other integration suites, e.g. tests/integration/cart.concurrency.test.ts).
 * Does NOT mock prisma — exercises the real `prisma.cart.findUnique` nested
 * `include` against Postgres and counts the actual SQL statements emitted.
 *
 * Why real DB + $on('query')? Design D4 (openspec/changes/cart/design.md)
 * explicitly defers the AUTHORITATIVE proof of NFR-1 ("GET /carrito issues
 * exactly ONE Prisma query") to an integration-level query observation —
 * a unit-level mocked-delegate call count only proves one SERVICE-level call,
 * not one SQL statement on the wire. `prisma.$on('query', ...)` on the real
 * singleton is the mechanism the design names explicitly.
 *
 * `src/shared/utils/prisma.ts` configures `query` with `emit: "event"` in
 * every environment (never auto-printed outside development) specifically
 * so this test can subscribe without enabling any additional stdout logging.
 *
 * SKIP POLICY: When the database is unreachable, the test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent
 * false-greens. The CI pipeline MUST start the postgres container before
 * running `pnpm test`.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cartService from "@/modules/cart/services/cart.service";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Real Prisma client for setup/teardown — not the singleton under test.
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

let userId: string;
let producerId: string;
let productId: string;

beforeAll(async () => {
  dbReachable = await isDbReachable();
  if (!dbReachable) {
    return;
  }

  const category = await db.category.upsert({
    where: { slug: "test-cart-query-count-cat" },
    create: {
      slug: "test-cart-query-count-cat",
      name: "Test Cart Query Count Category",
      isActive: true,
    },
    update: {},
  });

  const producerUser = await db.user.upsert({
    where: { auth0Sub: "test-cart-query-count-producer" },
    create: {
      auth0Sub: "test-cart-query-count-producer",
      email: "cart-query-count-producer@test.local",
      role: "PRODUCER",
    },
    update: {},
  });
  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: "Test Cart Query Count Producer",
      nif: "B77777766",
      description: "Producer for cart NFR-1 query-count test",
      addressLine1: "Calle Query Count 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  producerId = producer.id;

  const consumerUser = await db.user.upsert({
    where: { auth0Sub: "test-cart-query-count-user" },
    create: {
      auth0Sub: "test-cart-query-count-user",
      email: "cart-query-count@test.local",
      role: "CONSUMER",
    },
    update: {},
  });
  userId = consumerUser.id;

  const product = await db.product.create({
    data: {
      producerId,
      categoryId: category.id,
      name: "Query Count Product",
      description: "Product used to populate a cart with one item",
      price: 9.99,
      stock: 20,
      isActive: true,
    },
  });
  productId = product.id;

  await db.productImage.create({
    data: {
      productId,
      position: 0,
      s3Key: "tests/cart-query-count/main.jpg",
      mimeType: "image/jpeg",
    },
  });

  // Populate the cart via the real service (uses the shared `prisma` singleton).
  await cartService.addItem(userId, productId, 1);
});

afterAll(async () => {
  if (dbReachable) {
    await db.cartItem.deleteMany({ where: { productId } });
    await db.cart.deleteMany({ where: { userId } });
    await db.product.deleteMany({ where: { id: productId } });
  }
  await db.$disconnect();
});

describe("cart NFR-1 — GET /carrito issues exactly ONE SQL query [Q1]", () => {
  it("[Q1] prisma.$on('query') observes exactly one SQL statement during getCartView", async (ctx) => {
    if (!dbReachable) {
      ctx.skip();
      return;
    }

    // PrismaClient exposes no $off — this listener lives for the process
    // lifetime, acceptable since this is a single-test, single-purpose file.
    const queries: string[] = [];
    prisma.$on("query", (e) => {
      queries.push(e.query);
    });

    const view = await cartService.getCartView(userId);

    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.product.images).toEqual([
      {
        id: expect.any(String),
        position: 0,
        url: "https://test-cdn.example.com/tests/cart-query-count/main.jpg",
      },
    ]);
    // Filter out transaction-control statements (BEGIN/COMMIT/ROLLBACK/
    // DEALLOCATE). These are not data queries — Vitest's "forks" pool
    // reuses the same worker process (and thus the same imported `prisma`
    // module instance) across multiple integration test files, so a
    // COMMIT emitted by an unrelated $transaction() finishing in that
    // shared process can land on this listener while it is attached. The
    // NFR-1 proof cares about SQL *data* statements only — one SELECT is
    // the claim being verified, not the surrounding transaction chatter.
    const dataQueries = (): string[] =>
      queries.filter((query) => !/^(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/i.test(query.trim()));

    // Prisma delivers `query` events asynchronously through an event
    // emitter, so the SELECT issued by getCartView can arrive on a later
    // tick than the awaited result. Under full-suite load the event loop is
    // busy enough that a synchronous assertion can observe ZERO events — a
    // false failure that passes in isolation. Poll a bounded window until
    // the data query is delivered before asserting the NFR-1 count. Files
    // run sequentially within a worker, so no other suite's SELECT can
    // interleave into this window.
    const deadline = Date.now() + 5000;
    while (dataQueries().length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(dataQueries()).toHaveLength(1);
  }, 15000);
});
