/**
 * Integration tests — orders.service `createOrderFromPayment` (Cycle 4 orders
 * WU2, real Postgres).
 *
 * Strategy: real Postgres on localhost:5433 (same test container used by
 * other integration suites, e.g. inventory.concurrency.test.ts /
 * cart.concurrency.test.ts). Does NOT mock prisma — exercises the real
 * `prisma.$transaction` + unique-constraint semantics that the unit tests
 * (mocked `tx`) cannot prove: actual rollback, actual row-level locking, and
 * the actual `Payment.providerRef` unique-constraint race (P2002).
 *
 * Scenarios covered (design Decision 4, spec §ADDED requirements):
 *
 *   [O1] Two-producer cart creates one Order with two SubOrders (spec scenario)
 *     GIVEN a cart with 3 items across producers A (2 items) and B (1 item)
 *     WHEN createOrderFromPayment runs inside a real $transaction
 *     THEN exactly ONE Order + SUCCEEDED Payment exist, TWO SubOrders, THREE
 *     OrderLines, stock decremented per line, and the cart is cleared
 *
 *   [O2] Any step failure rolls back the WHOLE order (real Postgres proof)
 *     GIVEN a cart where the second line's decrementStock would go negative
 *     WHEN createOrderFromPayment runs
 *     THEN InsufficientStockError propagates AND no Payment/Order/SubOrder/
 *     OrderLine row persists AND the first line's stock is untouched AND the
 *     cart items are NOT cleared (real ROLLBACK, not just an early throw)
 *
 *   [O3] Live availability + completeness re-check (real DB, not the snapshot)
 *     [O3a] a CartItem removed after the snapshot was taken (findMany returns
 *           fewer rows) -> CartItemNotAvailableError, no writes
 *     [O3b] a product deactivated after the snapshot was taken (snapshot said
 *           isAvailable=true) -> CartItemNotAvailableError, no writes
 *     [O3c] a producer soft-deleted (`producer.deletedAt` set) on ONE item of
 *           a 2-item multi-producer cart -> CartItemNotAvailableError, no
 *           writes, no stock decrement on EITHER line (all-or-nothing)
 *
 *   [O4] Snapshot-scoped cart clear — items added mid-window survive
 *     GIVEN a snapshot of items [A, B] and a NEW item C added to the SAME
 *     cart after the snapshot was taken (simulating the checkout-to-webhook
 *     window)
 *     WHEN createOrderFromPayment completes successfully
 *     THEN A and B are deleted but C SURVIVES (delete is id-scoped, not
 *     cart-scoped)
 *
 *   [O5] Duplicate-intent fresh-$transaction recovery (real P2002, FORCED overlap)
 *     GIVEN two calls to createOrderFromPayment for the SAME stripeIntentId
 *     (simulating a replayed webhook racing the original), where the FIRST
 *     call is deliberately held open (uncommitted) via a barrier after its
 *     writes complete, and the SECOND is only released past its lock-wait
 *     once `pg_stat_activity` confirms it is genuinely blocked — this
 *     guarantees a real overlap instead of hoping the event loop races two
 *     unconstrained calls (which can validly no-op via the step-0 pre-check
 *     with zero P2002 ever occurring)
 *     WHEN the loser's payment.create BLOCKS on the winner's still-open
 *     transaction, then hits the real `providerRef @unique` constraint
 *     (P2002) once the winner commits, and bubbles out uncaught
 *     THEN a CALLER-level fresh-$transaction retry (mirroring the payments
 *     webhook handler contract) recovers idempotently via the step-0
 *     pre-check — proven via a deterministic `recoveryFired` flag, not just
 *     outcome inference — and exactly ONE Order/Payment row exists
 *
 *   [O6] Delivery-cost snapshot immutability after a LATER DeliveryMode update
 *     GIVEN a SubOrder created with `shippingCostSnapshot` from the
 *     DeliveryMode's cost at checkout time
 *     WHEN that DeliveryMode's live `cost` is updated AFTER order creation
 *     THEN the already-created SubOrder's `shippingCostSnapshot` is UNCHANGED
 *     (never re-read from the live DeliveryMode row)
 *
 * [O1] above is also the runtime proof for the "Cart is cleared after
 * successful creation" scenario's SECOND clause: the Cart ROW itself
 * (its `id`) is preserved across the snapshot-scoped clear — only CartItem
 * rows are deleted, the parent Cart entity is never deleted/recreated.
 *
 * WU3 (Read Surface, HTTP) additions below use real Postgres AND Supertest
 * together — a deliberate deviation from the repo's usual "Supertest =
 * mocked prisma" convention (cart.test.ts, addresses.test.ts, etc.). Real
 * rows with nested payment/subOrders/orderLines are far cheaper to SEED via
 * the real service layer than to hand-construct as a deeply nested Prisma
 * mock, and this is the only way to prove the real ownership-scoped SQL
 * query (`where: { id, userId }`) actually no-leaks against a second real
 * user — mirroring the cart.authz.test.ts precedent for that specific
 * concern, but wired through the real HTTP layer (routes + middleware
 * chain) instead of calling the service directly.
 *
 *   [OH1] GET /pedidos — owner-scoped summary history
 *   [OH2] GET /pedidos — empty list for a user with zero orders
 *   [OH3] GET /pedidos/:id — nested detail (payment/subOrders/orderLines)
 *   [OH4] GET /pedidos/:id — non-owned order returns 404 (no-leak)
 *   [OH5] GET /pedidos/:id — unknown id returns 404
 *   [OH6] GET /pedidos — 401 unauthenticated
 *   [OH7] GET /pedidos — 403 ONBOARDING_REQUIRED for a PENDING_ROLE user
 *   [OH3-EXACT] GET /pedidos/:id — the spec-mandated exact fixture: an order
 *          with 2 SubOrders and 3 OrderLines total (spec scenario "Owner
 *          reads fully nested detail"). [OH3] proves the shape with 2
 *          SubOrders/2 lines only; this proves the exact 3-line aggregate.
 *
 * WU4 (Cancellation, real Postgres + Supertest, design Decision 3) additions:
 *
 *   [CXH1] PATCH /pedidos/:id/cancelar — success: every SubOrder -> cancelled,
 *          Order.status derives CANCELLED, stock restored EXACTLY (inverse of
 *          the checkout decrement)
 *   [CXH2] PATCH /pedidos/:id/cancelar — non-owner returns 404 (no-leak), the
 *          order is left completely unchanged
 *   [CXH3] PATCH /pedidos/:id/cancelar — a non-PENDING order (one SubOrder
 *          already "preparing", no race involved) returns 409
 *          INVALID_ORDER_TRANSITION, no SubOrder changes, no stock restored
 *   [CX-RACE] cancelOrder (direct service call, precise DB-state control) —
 *          PRODUCER-WINS interleaving: a producer transition() that commits
 *          strictly BETWEEN cancel's step-1 read and its guarded updateMany
 *          causes the count-guard to reject with 409
 *          INVALID_ORDER_TRANSITION, and the WHOLE cancel transaction
 *          (including the step-3 restock) rolls back — proving restock is
 *          never left committed without cancel actually taking effect. Does
 *          NOT cover the reverse CANCEL-WINS residual race (design Decision 3
 *          "Known constraint") — that direction is an ACCEPTED, documented
 *          limitation, not exercised here.
 *
 * Spec references:
 *   orders §"createOrderFromPayment writes the order aggregate atomically"
 *   orders §"Checkout enforces all-or-nothing availability"
 *   orders §"Duplicate webhook must not double-create an order"
 *   orders §"GET /pedidos returns owner-scoped summary history"
 *   orders §"GET /pedidos/:id returns nested detail with no-leak 404"
 *   orders §"PATCH /pedidos/:id/cancelar cancels only at PENDING and restores stock"
 *   design Decision 3 (cancel TOCTOU guard), Decision 4 (internals, atomic step order, idempotency backstop)
 *   design Decision 6 (guard chain, owner = req.user.id, no-leak 404)
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent
 * false-greens. The CI pipeline MUST start the postgres container before
 * running `pnpm test`.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InsufficientStockError } from "@/shared/errors/errors";
import * as cartService from "@/modules/cart/services/cart.service";
import * as ordersService from "@/modules/orders/services/orders.service";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer ONLY — same test double as cart.test.ts /
// addresses.test.ts. `@/shared/utils/prisma` is intentionally NOT mocked
// here (see file header WU3 note): loadUser and orders.service both hit the
// REAL Postgres test database through the real singleton.
// ---------------------------------------------------------------------------
vi.mock("express-oauth2-jwt-bearer", () => ({
  auth: () =>
    (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const header = req.headers["x-test-auth"] as string | undefined;
      if (!header) {
        next({ status: 401, name: "UnauthorizedError" });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
        req.auth = { payload: payload as never, header: {}, token: "test-token" };
        next();
      } catch {
        next({ status: 401, name: "UnauthorizedError" });
      }
    },
}));

// eslint-disable-next-line import/first
import { createApp } from "@/app";

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

const app = createApp();
const request = supertest(app);

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

// ---------------------------------------------------------------------------
// Caller-level recovery wrapper — mirrors the payments webhook handler
// contract (design Decision 4, "Recovery is a CALLER contract, not an
// in-tx catch"): open a FRESH $transaction on P2002 and retry.
//
// `onRecovery` is an optional test-only hook invoked exactly when the catch
// branch actually fires (i.e. a real P2002 was caught) — [O5] below uses it
// as a deterministic, non-flaky proof that the recovery path executed,
// instead of inferring it indirectly from settlement order.
//
// `applicationNameTag`, when provided, is applied via `SET LOCAL
// application_name` as the FIRST statement inside each attempt's
// transaction — [O5]'s `waitForLockWait` uses this tag to identify THIS
// call's own Postgres backend specifically, instead of matching ANY backend
// blocked on ANY lock. `SET LOCAL` is transaction-scoped: it is
// automatically reset at COMMIT/ROLLBACK, so it cannot leak onto the pooled
// connection for unrelated queries once this attempt's transaction ends.
// ---------------------------------------------------------------------------
async function invokeWithP2002Recovery(
  stripeIntentId: string,
  cartView: Awaited<ReturnType<typeof cartService.getCartForCheckout>>,
  deliverySelections: { producerId: string; deliveryModeId: string }[],
  options?: { onRecovery?: () => void; applicationNameTag?: string },
): Promise<ordersService.OrderDetailView> {
  const { onRecovery, applicationNameTag } = options ?? {};

  const attempt = () =>
    prisma.$transaction(
      async (tx) => {
        if (applicationNameTag) {
          // SET does not accept bind parameters in Postgres — safe here
          // because the tag is a test-generated constant, never user input.
          await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationNameTag}'`);
        }
        return ordersService.createOrderFromPayment(stripeIntentId, cartView, deliverySelections, tx);
      },
      { timeout: 20000, maxWait: 20000 },
    );

  try {
    return await attempt();
  } catch (err: unknown) {
    const isProviderRefConflict =
      typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
    if (!isProviderRefConflict) {
      throw err;
    }
    onRecovery?.();
    return attempt();
  }
}

/**
 * Resolves once the backend tagged with `applicationNameTag` (via `SET
 * LOCAL application_name` — see `invokeWithP2002Recovery`) is genuinely
 * BLOCKED waiting on a lock (`pg_stat_activity.wait_event_type = 'Lock'`) —
 * used by [O5] to confirm, via real DB state rather than a timing guess,
 * that Call B SPECIFICALLY has reached and is stuck on its conflicting
 * INSERT before we allow Call A's held transaction to commit.
 *
 * Scoping to `applicationNameTag` (rather than "any backend blocked on any
 * lock") matters under parallel vitest integration files: an UNRELATED
 * concurrent lock wait in a different test file could otherwise satisfy an
 * unscoped predicate, releasing Call A prematurely and letting Call B's
 * step-0 idempotency pre-check no-op — silently defeating the race this
 * test exists to prove.
 *
 * Throws (test fails LOUDLY, never silently passes) if no such block from
 * the tagged backend appears within `timeoutMs`.
 */
async function waitForLockWait(dbClient: PrismaClient, timeoutMs: number, applicationNameTag: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await dbClient.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND application_name = ${applicationNameTag}
        AND pid <> pg_backend_pid()
    `;
    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `waitForLockWait: timed out waiting for backend tagged "${applicationNameTag}" to block on a lock — the forced overlapping race did not materialize`,
  );
}

/**
 * Resolves once ANY backend other than the caller's own polling connection is
 * genuinely BLOCKED waiting on a lock while running a query that touches
 * `sub_orders` — used by [CX-RACE] to confirm, via real DB state rather than a
 * fixed delay, that cancel's guarded `updateMany` has reached and is stuck on
 * the row lock held by the still-open producer transaction before that
 * transaction is released.
 *
 * Unlike `waitForLockWait` (used by [O5]), this cannot scope to an
 * `application_name` tag on the BLOCKED backend: `cancelOrder` self-manages
 * its own `prisma.$transaction` internally (design Decision 3 — no caller-tx
 * parameter, unlike `createOrderFromPayment`) and has no test-only
 * instrumentation hook to tag its own connection. Scoping by `query ILIKE
 * '%sub_orders%'` combined with `wait_event_type = 'Lock'` is deliberately
 * narrow: only an UPDATE/DELETE (or a locking SELECT) against that specific
 * table can report this wait state, which in this test's controlled fixture
 * data can only be cancel's own guarded `updateMany`. As with [O5], an
 * unrelated concurrent lock wait touching `sub_orders` from a different
 * parallel test file is a theoretical (documented) risk, not something this
 * helper can fully eliminate without a production instrumentation hook.
 *
 * Throws (test fails LOUDLY, never silently passes) if no such block appears
 * within `timeoutMs`.
 */
async function waitForBlockedSubOrderUpdate(dbClient: PrismaClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await dbClient.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
        AND query ILIKE '%sub_orders%'
    `;
    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "waitForBlockedSubOrderUpdate: timed out waiting for a blocked sub_orders UPDATE — the forced overlapping race did not materialize",
  );
}

/** Deferred promise — used to hold a transaction open until explicitly released. */
function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Cleanup registries — collected across tests, torn down in afterAll.
// ---------------------------------------------------------------------------
const cleanupUserIds: string[] = [];
const cleanupProducerIds: string[] = [];
const cleanupCategorySlugs = new Set<string>();

async function seedProducer(namePrefix: string, nif: string) {
  const category = await db.category.upsert({
    where: { slug: `test-orders-${namePrefix}-cat` },
    create: { slug: `test-orders-${namePrefix}-cat`, name: `Test Orders ${namePrefix} Category`, isActive: true },
    update: {},
  });
  cleanupCategorySlugs.add(category.slug);

  const producerUser = await db.user.upsert({
    where: { auth0Sub: `test-orders-${namePrefix}-producer` },
    create: {
      auth0Sub: `test-orders-${namePrefix}-producer`,
      email: `orders-${namePrefix}-producer@test.local`,
      role: "PRODUCER",
    },
    update: {},
  });
  cleanupUserIds.push(producerUser.id);

  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: `Test Orders Producer ${namePrefix}`,
      nif,
      description: "Producer for orders WU2 integration tests",
      addressLine1: "Calle Orders 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  cleanupProducerIds.push(producer.id);

  return { category, producer };
}

async function seedConsumer(namePrefix: string) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-orders-${namePrefix}-user` },
    create: {
      auth0Sub: `test-orders-${namePrefix}-user`,
      email: `orders-${namePrefix}@test.local`,
      role: "CONSUMER",
    },
    update: {},
  });
  cleanupUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (dbReachable) {
    // OrderLines/SubOrders/Orders/Payments cascade-delete via onDelete: Restrict
    // is NOT cascade, so delete children before parents. Scope by our test users.
    const orders = await db.order.findMany({ where: { userId: { in: cleanupUserIds } } });
    const orderIds = orders.map((o) => o.id);
    const paymentIds = orders.map((o) => o.paymentId);
    const subOrders = await db.subOrder.findMany({ where: { orderId: { in: orderIds } } });
    const subOrderIds = subOrders.map((s) => s.id);

    await db.orderLine.deleteMany({ where: { subOrderId: { in: subOrderIds } } });
    await db.subOrder.deleteMany({ where: { id: { in: subOrderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
    await db.cartItem.deleteMany({ where: { cart: { userId: { in: cleanupUserIds } } } });
    await db.cart.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await db.deliveryMode.deleteMany({ where: { producerId: { in: cleanupProducerIds } } });
    await db.product.deleteMany({ where: { producerId: { in: cleanupProducerIds } } });
    await db.producer.deleteMany({ where: { id: { in: cleanupProducerIds } } });
    await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await db.category.deleteMany({ where: { slug: { in: [...cleanupCategorySlugs] } } });
  }
  await db.$disconnect();
  await prisma.$disconnect();
});

beforeAll(async () => {
  dbReachable = await isDbReachable();
});

// ===========================================================================
// [O1] Two-producer cart creates one Order with two SubOrders
// ===========================================================================

describe("createOrderFromPayment — two-producer create [O1]", () => {
  it(
    "[O1] creates ONE Order, TWO SubOrders, THREE OrderLines, decrements stock, clears the cart",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer: producerA, category } = await seedProducer("o1a", "B10000011");
      const { producer: producerB } = await seedProducer("o1b", "B10000012");
      const consumer = await seedConsumer("o1");

      const dmA = await db.deliveryMode.create({
        data: { producerId: producerA.id, type: "SHIPPING_FLAT_RATE", cost: 2.0, isActive: true },
      });
      const dmB = await db.deliveryMode.create({
        data: { producerId: producerB.id, type: "SHIPPING_FLAT_RATE", cost: 4.0, isActive: true },
      });

      const productA1 = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "O1 Product A1", description: "d", price: 5.0, stock: 10, isActive: true },
      });
      const productA2 = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "O1 Product A2", description: "d", price: 3.0, stock: 10, isActive: true },
      });
      const productB1 = await db.product.create({
        data: { producerId: producerB.id, categoryId: category.id, name: "O1 Product B1", description: "d", price: 10.0, stock: 5, isActive: true },
      });

      await cartService.addItem(consumer.id, productA1.id, 1);
      await cartService.addItem(consumer.id, productA2.id, 1);
      await cartService.addItem(consumer.id, productB1.id, 1);

      const cartView = await cartService.getCartForCheckout(consumer.id);
      expect(cartView.items).toHaveLength(3);

      const cartBeforeCheckout = await db.cart.findUniqueOrThrow({ where: { userId: consumer.id } });

      const result = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_o1_two_producer",
          cartView,
          [
            { producerId: producerA.id, deliveryModeId: dmA.id },
            { producerId: producerB.id, deliveryModeId: dmB.id },
          ],
          tx,
        ),
      );

      expect(result.status).toBe("PENDING");
      expect(result.payment.status).toBe("SUCCEEDED");
      expect(result.subOrders).toHaveLength(2);
      // (5+3) + 2.00 shipping A = 10.00; 10 + 4.00 shipping B = 14.00 -> total 24.00
      expect(result.totalAmount).toBe("24.00");

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o1_two_producer" } });
      expect(payment?.status).toBe("SUCCEEDED");

      const order = await db.order.findFirst({ where: { paymentId: payment!.id } });
      expect(order?.userId).toBe(consumer.id);

      const subOrderCount = await db.subOrder.count({ where: { orderId: order!.id } });
      expect(subOrderCount).toBe(2);

      const orderLineCount = await db.orderLine.count({ where: { subOrder: { orderId: order!.id } } });
      expect(orderLineCount).toBe(3);

      const [freshA1, freshA2, freshB1] = await Promise.all([
        db.product.findUniqueOrThrow({ where: { id: productA1.id } }),
        db.product.findUniqueOrThrow({ where: { id: productA2.id } }),
        db.product.findUniqueOrThrow({ where: { id: productB1.id } }),
      ]);
      expect(freshA1.stock).toBe(9);
      expect(freshA2.stock).toBe(9);
      expect(freshB1.stock).toBe(4);

      const remainingCartItems = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(remainingCartItems).toBe(0);

      // Cart ROW identity preserved (spec "Cart is cleared after successful
      // creation": items removed, but the Cart entity itself is NOT
      // deleted/recreated) — the snapshot-scoped delete (design Decision 4
      // step 9) targets CartItem rows only, never the parent Cart row.
      const cartAfterCheckout = await db.cart.findUnique({ where: { userId: consumer.id } });
      expect(cartAfterCheckout).not.toBeNull();
      expect(cartAfterCheckout!.id).toBe(cartBeforeCheckout.id);
    },
    20000,
  );
});

// ===========================================================================
// [O2] Any step failure rolls back the WHOLE order (real Postgres proof)
// ===========================================================================

describe("createOrderFromPayment — full rollback on decrementStock failure [O2]", () => {
  it(
    "[O2] InsufficientStockError on the second line rolls back the ENTIRE transaction — no rows persist, first line's stock is untouched, cart is not cleared",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o2", "B10000021");
      const consumer = await seedConsumer("o2");

      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });

      // P1: healthy stock, decrements cleanly. P2: stock=1, requested qty=5 -> InsufficientStockError.
      const productHealthy = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O2 Product Healthy", description: "d", price: 2.0, stock: 10, isActive: true },
      });
      const productShort = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O2 Product Short", description: "d", price: 2.0, stock: 1, isActive: true },
      });

      await cartService.addItem(consumer.id, productHealthy.id, 1);
      // Bypass addItem's own pre-check (which would reject qty > stock at cart time) by
      // writing the CartItem directly with a quantity that only decrementStock's
      // post-decrement guard will catch — this proves the ROLLBACK, not an early 422.
      const cart = await db.cart.findUniqueOrThrow({ where: { userId: consumer.id } });
      await db.cartItem.create({
        data: { cartId: cart.id, productId: productShort.id, quantity: 5, unitPriceSnapshot: 2.0 },
      });

      const cartView = await cartService.getCartForCheckout(consumer.id);
      expect(cartView.items).toHaveLength(2);

      // `getCartForCheckout` has NO `orderBy` (cart.service.ts:440-459) —
      // Postgres/Prisma give no ordering guarantee on `cartView.items`. If the
      // SHORT line happened to come first, `createOrderFromPayment` would
      // throw on step 8's FIRST iteration, before the healthy line's
      // `decrementStock` ever ran — in that case `freshHealthy.stock === 10`
      // below would pass TRIVIALLY (nothing was ever touched), proving
      // nothing about rollback. Force the healthy line to be processed FIRST
      // so its decrement is GUARANTEED to happen (and be visible only inside
      // the still-open tx) before the short line's throw, making the
      // post-rollback assertion an unambiguous proof of atomicity.
      const healthyItem = cartView.items.find((item) => item.productId === productHealthy.id)!;
      const shortItem = cartView.items.find((item) => item.productId === productShort.id)!;
      expect(healthyItem).toBeDefined();
      expect(shortItem).toBeDefined();
      const orderedCartView = { ...cartView, items: [healthyItem, shortItem] };

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderFromPayment(
            "pi_o2_rollback",
            orderedCartView,
            [{ producerId: producer.id, deliveryModeId: dm.id }],
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o2_rollback" } });
      expect(payment).toBeNull();

      const freshHealthy = await db.product.findUniqueOrThrow({ where: { id: productHealthy.id } });
      // Healthy is FORCED (see orderedCartView above) to be decremented before the
      // short line throws, so stock===10 here is an unambiguous proof of rollback —
      // not a coincidence of an early throw that never touched this row.
      expect(freshHealthy.stock).toBe(10);

      const remainingCartItems = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(remainingCartItems).toBe(2); // cart clear also rolled back
    },
    20000,
  );
});

// ===========================================================================
// [O3] Live availability + completeness re-check (real DB, not the snapshot)
// ===========================================================================

describe("createOrderFromPayment — live re-check overrides a stale snapshot [O3]", () => {
  it(
    "[O3a] a CartItem removed after the snapshot was taken -> CartItemNotAvailableError, no writes",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o3a", "B10000031");
      const consumer = await seedConsumer("o3a");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O3a Product", description: "d", price: 2.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);

      // Simulate removal AFTER the snapshot: delete the CartItem row directly.
      await db.cartItem.deleteMany({ where: { cart: { userId: consumer.id } } });

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderFromPayment(
            "pi_o3a_incomplete",
            cartView,
            [{ producerId: producer.id, deliveryModeId: dm.id }],
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: "CART_ITEM_NOT_AVAILABLE" });

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o3a_incomplete" } });
      expect(payment).toBeNull();
    },
    20000,
  );

  it(
    "[O3b] a product deactivated after the snapshot was taken -> CartItemNotAvailableError, no writes",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o3b", "B10000032");
      const consumer = await seedConsumer("o3b");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O3b Product", description: "d", price: 2.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      expect(cartView.items[0]!.isAvailable).toBe(true); // snapshot said available

      // Simulate deactivation AFTER the snapshot was taken (e.g. producer disables the product).
      await db.product.update({ where: { id: product.id }, data: { isActive: false } });

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderFromPayment(
            "pi_o3b_live_unavailable",
            cartView,
            [{ producerId: producer.id, deliveryModeId: dm.id }],
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: "CART_ITEM_NOT_AVAILABLE" });

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o3b_live_unavailable" } });
      expect(payment).toBeNull();

      const remainingCartItems = await db.cartItem.count({ where: { cart: { userId: consumer.id } } });
      expect(remainingCartItems).toBe(1); // not cleared — the whole write path aborted
    },
    20000,
  );

  it(
    "[O3c] a soft-deleted producer on one item in a multi-producer cart fails the WHOLE order -> CartItemNotAvailableError, no writes, no stock decrement on any line",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer: producerA, category } = await seedProducer("o3c-a", "B10000033");
      const { producer: producerB } = await seedProducer("o3c-b", "B10000034");
      const consumer = await seedConsumer("o3c");
      const dmA = await db.deliveryMode.create({
        data: { producerId: producerA.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const dmB = await db.deliveryMode.create({
        data: { producerId: producerB.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const productA = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "O3c Product A", description: "d", price: 2.0, stock: 10, isActive: true },
      });
      const productB = await db.product.create({
        data: { producerId: producerB.id, categoryId: category.id, name: "O3c Product B", description: "d", price: 3.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, productA.id, 1);
      await cartService.addItem(consumer.id, productB.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      expect(cartView.items).toHaveLength(2);

      // Simulate producer B being soft-deleted AFTER the snapshot was taken
      // (spec: "producer.deletedAt set" is an all-or-nothing availability failure,
      // distinct from the O3b product.isActive=false path).
      await db.producer.update({ where: { id: producerB.id }, data: { deletedAt: new Date() } });

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderFromPayment(
            "pi_o3c_soft_deleted_producer",
            cartView,
            [
              { producerId: producerA.id, deliveryModeId: dmA.id },
              { producerId: producerB.id, deliveryModeId: dmB.id },
            ],
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: "CART_ITEM_NOT_AVAILABLE" });

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o3c_soft_deleted_producer" } });
      expect(payment).toBeNull();

      const order = await db.order.findFirst({ where: { userId: consumer.id } });
      expect(order).toBeNull();

      const subOrderCount = await db.subOrder.count({
        where: { producerId: { in: [producerA.id, producerB.id] } },
      });
      expect(subOrderCount).toBe(0);

      // NO stock decrement on EITHER line — including producer A's item,
      // which was individually available; all-or-nothing means the whole
      // cart is rejected before any decrementStock call.
      const [freshA, freshB] = await Promise.all([
        db.product.findUniqueOrThrow({ where: { id: productA.id } }),
        db.product.findUniqueOrThrow({ where: { id: productB.id } }),
      ]);
      expect(freshA.stock).toBe(10);
      expect(freshB.stock).toBe(10);
    },
    20000,
  );
});

// ===========================================================================
// [O4] Snapshot-scoped cart clear — items added mid-window survive
// ===========================================================================

describe("createOrderFromPayment — snapshot-scoped cart clear [O4]", () => {
  it(
    "[O4] deletes only the snapshotted items; an item added to the cart AFTER the snapshot survives",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o4", "B10000041");
      const consumer = await seedConsumer("o4");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const productA = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O4 Product A", description: "d", price: 2.0, stock: 10, isActive: true },
      });
      const productB = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O4 Product B", description: "d", price: 3.0, stock: 10, isActive: true },
      });
      const productC = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O4 Product C (added mid-window)", description: "d", price: 4.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, productA.id, 1);
      await cartService.addItem(consumer.id, productB.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      expect(cartView.items).toHaveLength(2);

      // Mid-window: the consumer adds a THIRD item after the checkout snapshot was taken.
      await cartService.addItem(consumer.id, productC.id, 1);

      await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_o4_snapshot_scoped_clear",
          cartView,
          [{ producerId: producer.id, deliveryModeId: dm.id }],
          tx,
        ),
      );

      const remaining = await db.cartItem.findMany({ where: { cart: { userId: consumer.id } } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.productId).toBe(productC.id);
    },
    20000,
  );
});

// ===========================================================================
// [O5] Duplicate-intent fresh-$transaction recovery (real P2002)
// ===========================================================================

describe("createOrderFromPayment — duplicate webhook recovers via real P2002 [O5]", () => {
  it(
    "[O5] two concurrent calls for the SAME stripeIntentId: the loser hits a real unique-constraint violation, a caller-level fresh-transaction retry recovers idempotently, and exactly ONE Order/Payment exists",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o5", "B10000051");
      const consumer = await seedConsumer("o5");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O5 Product", description: "d", price: 5.0, stock: 100, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);

      const intentId = "pi_o5_duplicate_webhook";
      const selections = [{ producerId: producer.id, deliveryModeId: dm.id }];

      // ---------------------------------------------------------------------
      // Force a GENUINE, deterministic overlap instead of hoping the event
      // loop interleaves two `Promise.allSettled` calls into a real race.
      // (A naive `expect(recoveryCount).toBeGreaterThan(0)` on an
      // unconstrained race would FLAKE: a valid scheduling has the second
      // call's step-0 pre-check see the first call's already-committed
      // Payment and no-op WITHOUT ever reaching `payment.create` — zero
      // P2002, zero recovery, yet the outcome assertions would still pass.)
      //
      // Call A runs `createOrderFromPayment` to completion inside its own
      // `$transaction`, then HOLDS that transaction open (uncommitted) on a
      // barrier before returning. Its `Payment` row is written but NOT YET
      // COMMITTED, so under Postgres READ COMMITTED it stays invisible to
      // every other transaction.
      // ---------------------------------------------------------------------
      const releaseA = createDeferred();
      const aWritesDone = createDeferred();

      const aPromise = prisma.$transaction(
        async (tx) => {
          const result = await ordersService.createOrderFromPayment(intentId, cartView, selections, tx);
          aWritesDone.resolve();
          await releaseA.promise;
          return result;
        },
        { timeout: 20000, maxWait: 20000 },
      );

      // Wait until A's payment.create has actually executed (still uncommitted).
      await aWritesDone.promise;

      // Call B starts a FRESH transaction. Because A has not committed yet,
      // B's step-0 idempotency pre-check is GUARANTEED to see no existing
      // Payment row (A's insert is invisible pre-commit) — this is what makes
      // the race deterministic rather than incidental. B therefore proceeds
      // through every step and reaches its OWN `payment.create` with the
      // SAME `providerRef`, which BLOCKS on the unique-index entry A's still-
      // open transaction holds (Postgres row-level lock wait, not an
      // immediate error).
      //
      // Call B's own transaction is tagged with a per-run-unique
      // `application_name` (via `invokeWithP2002Recovery`'s `SET LOCAL`) so
      // `waitForLockWait` below can confirm SPECIFICALLY Call B is blocked —
      // not an unrelated backend from a parallel test file.
      let recoveryFired = false;
      const callBTag = `orders_test_o5_call_b_${randomUUID()}`;
      const bPromise = invokeWithP2002Recovery(intentId, cartView, selections, {
        onRecovery: () => {
          recoveryFired = true;
        },
        applicationNameTag: callBTag,
      });

      // Confirm Call B specifically is genuinely blocked on that lock (via
      // real DB state, not a timing guess) before releasing A. This removes
      // the last source of non-determinism: we only proceed once Postgres
      // itself reports Call B's own backend waiting on a lock.
      //
      // `releaseA.resolve()` MUST run on every exit path from here — even if
      // `waitForLockWait` throws (bounded 5s timeout) — otherwise Call A's
      // interactive transaction stays open until Prisma's 20s tx timeout,
      // potentially leaking locks into later tests/teardown. The try/finally
      // guarantees that; `Promise.allSettled` afterwards guarantees BOTH
      // Call A's and Call B's promises are fully drained/settled before this
      // test exits on every path, so no transaction is left dangling.
      let lockWaitError: unknown;
      try {
        await waitForLockWait(db, 5000, callBTag);
      } catch (err) {
        lockWaitError = err;
      } finally {
        // Release A -> A commits -> Postgres immediately fails B's blocked
        // INSERT with a REAL unique_violation (P2002), which bubbles out of
        // B's `tx` UNCAUGHT (design Decision 4, "Recovery is a CALLER
        // contract, not an in-tx catch") and is caught by
        // `invokeWithP2002Recovery`, which retries with a FRESH
        // `$transaction` — that retry's step-0 pre-check now finds A's
        // committed row and recovers idempotently. If the lock wait timed
        // out instead, this release still prevents A's transaction from
        // leaking past this test.
        releaseA.resolve();
      }

      const [aSettled, bSettled] = await Promise.allSettled([aPromise, bPromise]);

      if (lockWaitError) {
        throw lockWaitError;
      }
      if (aSettled.status === "rejected") {
        throw aSettled.reason;
      }
      if (bSettled.status === "rejected") {
        throw bSettled.reason;
      }
      const aResult = aSettled.value;
      const bResult = bSettled.value;

      // Deterministic proof the RECOVERY PATH fired — not just that both
      // calls happened to settle to the same order (which a purely
      // sequential idempotent no-op would also satisfy).
      expect(recoveryFired).toBe(true);
      expect(aResult.id).toBe(bResult.id);

      const paymentCount = await db.payment.count({ where: { providerRef: intentId } });
      expect(paymentCount).toBe(1);
      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(1);
    },
    25000,
  );
});

// ===========================================================================
// [O6] Delivery-cost snapshot immutability after a later DeliveryMode update
// ===========================================================================

describe("createOrderFromPayment — delivery-cost snapshot stays frozen after a later DeliveryMode.cost update [O6]", () => {
  it(
    "[O6] SubOrder.shippingCostSnapshot keeps the checkout-time cost; a LATER DeliveryMode.cost change does not alter the stored snapshot",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("o6", "B10000042");
      const consumer = await seedConsumer("o6");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 4.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "O6 Product", description: "d", price: 5.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);

      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_o6_delivery_cost_snapshot",
          cartView,
          [{ producerId: producer.id, deliveryModeId: dm.id }],
          tx,
        ),
      );

      const subOrderId = created.subOrders[0]!.id;
      const beforeUpdate = await db.subOrder.findUniqueOrThrow({ where: { id: subOrderId } });
      expect(beforeUpdate.shippingCostSnapshot.toFixed(2)).toBe("4.00");

      // A LATER change to the DeliveryMode's live cost — spec §"Order snapshots
      // are immutable at creation" requires the already-created SubOrder's
      // shippingCostSnapshot to be unaffected.
      await db.deliveryMode.update({ where: { id: dm.id }, data: { cost: 9.99 } });

      const afterUpdate = await db.subOrder.findUniqueOrThrow({ where: { id: subOrderId } });
      expect(afterUpdate.shippingCostSnapshot.toFixed(2)).toBe("4.00");
      expect(afterUpdate.shippingCostSnapshot.toFixed(2)).not.toBe("9.99");
    },
    20000,
  );
});

// ===========================================================================
// WU3 (Read Surface, HTTP) — real Postgres + Supertest
// ===========================================================================

describe("GET /api/v1/pedidos and /api/v1/pedidos/:id — real Postgres + Supertest [OH]", () => {
  it(
    "[OH1][OH2][OH3][OH4][OH5][OH6][OH7] owner-scoped history, nested detail, no-leak 404, 401, and onboarding 403",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer: producerA, category } = await seedProducer("oh1a", "B10000061");
      const { producer: producerB } = await seedProducer("oh1b", "B10000062");
      const owner = await seedConsumer("oh-owner");
      const stranger = await seedConsumer("oh-stranger");

      const pendingUser = await db.user.upsert({
        where: { auth0Sub: "test-orders-oh-pending-user" },
        create: {
          auth0Sub: "test-orders-oh-pending-user",
          email: "orders-oh-pending@test.local",
          role: "PENDING_ROLE",
        },
        update: { role: "PENDING_ROLE" },
      });
      cleanupUserIds.push(pendingUser.id);

      const dmA = await db.deliveryMode.create({
        data: { producerId: producerA.id, type: "SHIPPING_FLAT_RATE", cost: 2.0, isActive: true },
      });
      const dmB = await db.deliveryMode.create({
        data: { producerId: producerB.id, type: "SHIPPING_FLAT_RATE", cost: 4.0, isActive: true },
      });
      const productA = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "OH1 Product A", description: "d", price: 5.0, stock: 10, isActive: true },
      });
      const productB = await db.product.create({
        data: { producerId: producerB.id, categoryId: category.id, name: "OH1 Product B", description: "d", price: 10.0, stock: 5, isActive: true },
      });

      // Owner: one two-producer order (2 SubOrders, 2 OrderLines) via the real service.
      await cartService.addItem(owner.id, productA.id, 1);
      await cartService.addItem(owner.id, productB.id, 1);
      const ownerCartView = await cartService.getCartForCheckout(owner.id);
      const createdOrder = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_oh1_owner_order",
          ownerCartView,
          [
            { producerId: producerA.id, deliveryModeId: dmA.id },
            { producerId: producerB.id, deliveryModeId: dmB.id },
          ],
          tx,
        ),
      );

      // Stranger: their OWN separate order — must never leak into owner's list/detail.
      await cartService.addItem(stranger.id, productA.id, 1);
      const strangerCartView = await cartService.getCartForCheckout(stranger.id);
      const strangerOrder = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_oh1_stranger_order",
          strangerCartView,
          [{ producerId: producerA.id, deliveryModeId: dmA.id }],
          tx,
        ),
      );

      const ownerAuth = authHeader({ sub: owner.auth0Sub });
      const strangerAuth = authHeader({ sub: stranger.auth0Sub });
      const pendingAuth = authHeader({ sub: pendingUser.auth0Sub });

      // [OH1] owner-scoped summary history — only the owner's order appears.
      const listRes = await request.get("/api/v1/pedidos").set("x-test-auth", ownerAuth);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);
      expect(listRes.body[0]).toMatchObject({
        id: createdOrder.id,
        status: "PENDING",
        producerCount: 2,
      });
      const listedIds = (listRes.body as Array<{ id: string }>).map((o) => o.id);
      expect(listedIds).not.toContain(strangerOrder.id);

      // [OH2] a brand-new consumer with zero orders gets an empty list.
      const emptyConsumer = await seedConsumer("oh2-empty");
      const emptyAuth = authHeader({ sub: emptyConsumer.auth0Sub });
      const emptyListRes = await request.get("/api/v1/pedidos").set("x-test-auth", emptyAuth);
      expect(emptyListRes.status).toBe(200);
      expect(emptyListRes.body).toEqual([]);

      // [OH3] nested detail — payment/subOrders/orderLines all present.
      const detailRes = await request
        .get(`/api/v1/pedidos/${createdOrder.id}`)
        .set("x-test-auth", ownerAuth);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body).toMatchObject({
        id: createdOrder.id,
        status: "PENDING",
        payment: { status: "SUCCEEDED" },
      });
      expect(detailRes.body.subOrders).toHaveLength(2);
      const allLines = (detailRes.body.subOrders as Array<{ orderLines: unknown[] }>).flatMap(
        (s) => s.orderLines,
      );
      expect(allLines).toHaveLength(2);

      // [OH4] the STRANGER cannot read the OWNER's order — 404, no-leak (never 403).
      const crossUserRes = await request
        .get(`/api/v1/pedidos/${createdOrder.id}`)
        .set("x-test-auth", strangerAuth);
      expect(crossUserRes.status).toBe(404);
      expect(crossUserRes.body).toMatchObject({ code: "NOT_FOUND" });

      // [OH5] an unknown id also returns 404 (same status as unowned — no-leak).
      const unknownRes = await request
        .get("/api/v1/pedidos/bogus-order-id")
        .set("x-test-auth", ownerAuth);
      expect(unknownRes.status).toBe(404);
      expect(unknownRes.body).toMatchObject({ code: "NOT_FOUND" });

      // [OH6] no Authorization header -> 401.
      const unauthRes = await request.get("/api/v1/pedidos");
      expect(unauthRes.status).toBe(401);

      // [OH7] PENDING_ROLE user is blocked by onboardingGate -> 403 ONBOARDING_REQUIRED.
      const onboardingRes = await request.get("/api/v1/pedidos").set("x-test-auth", pendingAuth);
      expect(onboardingRes.status).toBe(403);
      expect(onboardingRes.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
    },
    30000,
  );
});

// ===========================================================================
// [OH3-EXACT] Nested detail — the spec-mandated exact fixture: 2 SubOrders,
// 3 OrderLines total (spec §"GET /pedidos/:id returns nested detail with
// no-leak 404", scenario "Owner reads fully nested detail": "U owns order O
// with 2 SubOrders and 3 OrderLines total, payment SUCCEEDED"). [OH3] above
// proves the shape with 2 SubOrders / 2 OrderLines only — this test proves
// the EXACT 3-line aggregate the spec scenario specifies.
// ===========================================================================

describe("GET /api/v1/pedidos/:id — exact spec fixture: 2 SubOrders, 3 OrderLines total [OH3-EXACT]", () => {
  it(
    "[OH3-EXACT] returns nested detail for an order with 2 SubOrders and 3 OrderLines total, each SubOrder status alongside the derived Order.status, and payment.status SUCCEEDED",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer: producerA, category } = await seedProducer("oh3x-a", "B10000081");
      const { producer: producerB } = await seedProducer("oh3x-b", "B10000082");
      const owner = await seedConsumer("oh3x-owner");

      const dmA = await db.deliveryMode.create({
        data: { producerId: producerA.id, type: "SHIPPING_FLAT_RATE", cost: 2.0, isActive: true },
      });
      const dmB = await db.deliveryMode.create({
        data: { producerId: producerB.id, type: "SHIPPING_FLAT_RATE", cost: 4.0, isActive: true },
      });

      const productA1 = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "OH3X Product A1", description: "d", price: 5.0, stock: 10, isActive: true },
      });
      const productA2 = await db.product.create({
        data: { producerId: producerA.id, categoryId: category.id, name: "OH3X Product A2", description: "d", price: 3.0, stock: 10, isActive: true },
      });
      const productB1 = await db.product.create({
        data: { producerId: producerB.id, categoryId: category.id, name: "OH3X Product B1", description: "d", price: 10.0, stock: 5, isActive: true },
      });

      await cartService.addItem(owner.id, productA1.id, 1);
      await cartService.addItem(owner.id, productA2.id, 1);
      await cartService.addItem(owner.id, productB1.id, 1);
      const cartView = await cartService.getCartForCheckout(owner.id);
      expect(cartView.items).toHaveLength(3);

      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment(
          "pi_oh3x_three_line_detail",
          cartView,
          [
            { producerId: producerA.id, deliveryModeId: dmA.id },
            { producerId: producerB.id, deliveryModeId: dmB.id },
          ],
          tx,
        ),
      );

      const ownerAuth = authHeader({ sub: owner.auth0Sub });
      const detailRes = await request
        .get(`/api/v1/pedidos/${created.id}`)
        .set("x-test-auth", ownerAuth);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body).toMatchObject({
        id: created.id,
        status: "PENDING",
        payment: { status: "SUCCEEDED" },
      });
      expect(detailRes.body.subOrders).toHaveLength(2);
      for (const subOrder of detailRes.body.subOrders as Array<{ status: string }>) {
        expect(subOrder.status).toBe("pending");
      }
      const allLines = (detailRes.body.subOrders as Array<{ orderLines: unknown[] }>).flatMap(
        (s) => s.orderLines,
      );
      expect(allLines).toHaveLength(3);
    },
    30000,
  );
});

// ===========================================================================
// WU4 (Cancellation, real Postgres + Supertest) — design Decision 3
// ===========================================================================

describe("PATCH /api/v1/pedidos/:id/cancelar — success, restores stock exactly [CXH1]", () => {
  it(
    "[CXH1] cancels a PENDING order: every SubOrder -> cancelled, Order.status derives CANCELLED, stock restored exactly",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("cxh1", "B10000071");
      const consumer = await seedConsumer("cxh1");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "CXH1 Product", description: "d", price: 5.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 2);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment("pi_cxh1_cancel_success", cartView, [
          { producerId: producer.id, deliveryModeId: dm.id },
        ], tx),
      );

      const freshAfterCheckout = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(freshAfterCheckout.stock).toBe(8); // 10 - 2

      const consumerAuth = authHeader({ sub: consumer.auth0Sub });
      const cancelRes = await request
        .patch(`/api/v1/pedidos/${created.id}/cancelar`)
        .set("x-test-auth", consumerAuth);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body).toMatchObject({ id: created.id, status: "CANCELLED" });
      expect(cancelRes.body.subOrders).toHaveLength(1);
      expect(
        (cancelRes.body.subOrders as Array<{ status: string }>).every((s) => s.status === "cancelled"),
      ).toBe(true);

      const freshAfterCancel = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(freshAfterCancel.stock).toBe(10); // restored to the pre-checkout level

      const subOrders = await db.subOrder.findMany({ where: { orderId: created.id } });
      expect(subOrders.every((s) => s.status === "cancelled")).toBe(true);
    },
    20000,
  );
});

describe("PATCH /api/v1/pedidos/:id/cancelar — non-owner returns 404 no-leak [CXH2]", () => {
  it(
    "[CXH2] a stranger cancelling the owner's order gets 404, and the order is left completely unchanged",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("cxh2", "B10000072");
      const owner = await seedConsumer("cxh2-owner");
      const stranger = await seedConsumer("cxh2-stranger");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "CXH2 Product", description: "d", price: 5.0, stock: 10, isActive: true },
      });

      await cartService.addItem(owner.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(owner.id);
      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment("pi_cxh2_non_owner", cartView, [
          { producerId: producer.id, deliveryModeId: dm.id },
        ], tx),
      );

      const strangerAuth = authHeader({ sub: stranger.auth0Sub });
      const cancelRes = await request
        .patch(`/api/v1/pedidos/${created.id}/cancelar`)
        .set("x-test-auth", strangerAuth);

      expect(cancelRes.status).toBe(404);
      expect(cancelRes.body).toMatchObject({ code: "NOT_FOUND" });

      const subOrders = await db.subOrder.findMany({ where: { orderId: created.id } });
      expect(subOrders.every((s) => s.status === "pending")).toBe(true);
      const freshProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(freshProduct.stock).toBe(9); // unchanged — 10 - 1, never restored
    },
    20000,
  );
});

describe("PATCH /api/v1/pedidos/:id/cancelar — non-PENDING order returns 409 [CXH3]", () => {
  it(
    "[CXH3] an order with one SubOrder already 'preparing' (no race) returns 409 INVALID_ORDER_TRANSITION, no SubOrder changes, no stock restored",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("cxh3", "B10000073");
      const consumer = await seedConsumer("cxh3");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "CXH3 Product", description: "d", price: 5.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 3);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment("pi_cxh3_non_pending", cartView, [
          { producerId: producer.id, deliveryModeId: dm.id },
        ], tx),
      );

      // Producer moves the SubOrder to "preparing" BEFORE the cancel attempt —
      // a straightforward, non-racing precondition (no concurrency involved).
      await db.subOrder.update({
        where: { id: created.subOrders[0]!.id },
        data: { status: "preparing" },
      });

      const consumerAuth = authHeader({ sub: consumer.auth0Sub });
      const cancelRes = await request
        .patch(`/api/v1/pedidos/${created.id}/cancelar`)
        .set("x-test-auth", consumerAuth);

      expect(cancelRes.status).toBe(409);
      expect(cancelRes.body).toMatchObject({ code: "INVALID_ORDER_TRANSITION" });

      const subOrder = await db.subOrder.findUniqueOrThrow({ where: { id: created.subOrders[0]!.id } });
      expect(subOrder.status).toBe("preparing"); // unchanged by the rejected cancel
      const freshProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(freshProduct.stock).toBe(7); // 10 - 3, never restored
    },
    20000,
  );
});

describe("cancelOrder — producer-wins count-guard: concurrent transition rejects cancel [CX-RACE]", () => {
  it(
    "[CX-RACE] a producer transition that commits strictly between cancel's read and its guarded updateMany causes a 409 rejection, and the WHOLE cancel transaction (including restock) rolls back",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("cxrace", "B10000091");
      const consumer = await seedConsumer("cxrace");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 1.0, isActive: true },
      });
      const product = await db.product.create({
        data: { producerId: producer.id, categoryId: category.id, name: "CXRace Product", description: "d", price: 5.0, stock: 10, isActive: true },
      });

      await cartService.addItem(consumer.id, product.id, 2);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      const created = await prisma.$transaction((tx) =>
        ordersService.createOrderFromPayment("pi_cxrace_producer_wins", cartView, [
          { producerId: producer.id, deliveryModeId: dm.id },
        ], tx),
      );
      const subOrderId = created.subOrders[0]!.id;

      // ---------------------------------------------------------------------
      // Force a GENUINE, deterministic interleave (mirrors [O5]'s approach,
      // adapted for cancel): a raw producer-transition-shaped transaction is
      // opened directly (NOT via the frozen sub-orders service, which self-
      // commits immediately and offers no barrier hook) and HELD OPEN
      // (uncommitted) after its UPDATE executes. Because cancel's step-1 read
      // is a plain SELECT under Postgres READ COMMITTED, a NEW transaction
      // started while this producer transaction is still uncommitted will see
      // the OLD "pending" value — exactly the TOCTOU window design Decision 3
      // describes.
      // ---------------------------------------------------------------------
      const releaseProducer = createDeferred();
      const producerUpdateDone = createDeferred();

      const producerTxPromise = db.$transaction(
        async (tx) => {
          await tx.subOrder.update({ where: { id: subOrderId }, data: { status: "preparing" } });
          producerUpdateDone.resolve();
          await releaseProducer.promise;
        },
        // Explicit { timeout, maxWait } hardening (mirrors [O5]'s
        // invokeWithP2002Recovery) — Prisma's 5000ms default interactive-tx
        // timeout raced against this test's own 5000ms waitForBlockedSubOrderUpdate
        // poll window; widening both removes that coincidental-timing risk
        // (previously deferred as a FOLLOW-UP in the verify report).
        { timeout: 20000, maxWait: 20000 },
      );

      // Guarantee the producer's UPDATE has executed (row lock acquired,
      // uncommitted) before cancel's read runs.
      await producerUpdateDone.promise;

      // Kick off cancel WITHOUT awaiting — its step-1 read is guaranteed to
      // see "pending" (producer's update is invisible pre-commit), so the
      // step-2 pre-check passes and cancel proceeds to restock and then its
      // guarded updateMany, which will BLOCK on the row lock producer holds.
      const cancelPromise = ordersService.cancelOrder(consumer.id, created.id);

      let lockWaitError: unknown;
      try {
        await waitForBlockedSubOrderUpdate(db, 5000);
      } catch (err) {
        lockWaitError = err;
      } finally {
        // Release producer -> it commits ("preparing") -> cancel's blocked
        // updateMany resumes, re-evaluates WHERE status='pending' against the
        // NOW-committed "preparing" row, excludes it, and the count mismatch
        // (0 matched vs 1 expected) throws InvalidOrderTransitionError,
        // rolling back the ENTIRE cancel transaction (including the restock
        // that already ran in step 3).
        releaseProducer.resolve();
      }

      const [cancelSettled, producerSettled] = await Promise.allSettled([cancelPromise, producerTxPromise]);

      if (lockWaitError) {
        throw lockWaitError;
      }
      if (producerSettled.status === "rejected") {
        throw producerSettled.reason;
      }

      expect(cancelSettled.status).toBe("rejected");
      if (cancelSettled.status === "rejected") {
        expect(cancelSettled.reason).toMatchObject({ code: "INVALID_ORDER_TRANSITION" });
      }

      // Whole cancel tx rolled back — the step-3 restock never took effect.
      const freshProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(freshProduct.stock).toBe(8); // still 10 - 2, restock reverted

      // Producer's committed transition stands untouched by cancel's rollback.
      const freshSubOrder = await db.subOrder.findUniqueOrThrow({ where: { id: subOrderId } });
      expect(freshSubOrder.status).toBe("preparing");
    },
    20000,
  );
});
