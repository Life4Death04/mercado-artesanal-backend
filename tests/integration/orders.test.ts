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
 *
 *   [O4] Snapshot-scoped cart clear — items added mid-window survive
 *     GIVEN a snapshot of items [A, B] and a NEW item C added to the SAME
 *     cart after the snapshot was taken (simulating the checkout-to-webhook
 *     window)
 *     WHEN createOrderFromPayment completes successfully
 *     THEN A and B are deleted but C SURVIVES (delete is id-scoped, not
 *     cart-scoped)
 *
 *   [O5] Duplicate-intent fresh-$transaction recovery (real P2002)
 *     GIVEN two concurrent calls to createOrderFromPayment for the SAME
 *     stripeIntentId (simulating a replayed webhook racing the original)
 *     WHEN the loser's payment.create hits the real `providerRef @unique`
 *     constraint (P2002) and bubbles out uncaught
 *     THEN a CALLER-level fresh-$transaction retry (mirroring the payments
 *     webhook handler contract) recovers idempotently via the step-0
 *     pre-check, and exactly ONE Order/Payment row exists for that intent
 *
 * Spec references:
 *   orders §"createOrderFromPayment writes the order aggregate atomically"
 *   orders §"Checkout enforces all-or-nothing availability"
 *   orders §"Duplicate webhook must not double-create an order"
 *   design Decision 4 (internals, atomic step order, idempotency backstop)
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent
 * false-greens. The CI pipeline MUST start the postgres container before
 * running `pnpm test`.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InsufficientStockError } from "@/shared/errors/errors";
import * as cartService from "@/modules/cart/services/cart.service";
import * as ordersService from "@/modules/orders/services/orders.service";
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

// ---------------------------------------------------------------------------
// Caller-level recovery wrapper — mirrors the payments webhook handler
// contract (design Decision 4, "Recovery is a CALLER contract, not an
// in-tx catch"): open a FRESH $transaction on P2002 and retry.
// ---------------------------------------------------------------------------
async function invokeWithP2002Recovery(
  stripeIntentId: string,
  cartView: Awaited<ReturnType<typeof cartService.getCartForCheckout>>,
  deliverySelections: { producerId: string; deliveryModeId: string }[],
): Promise<ordersService.OrderDetailView> {
  try {
    return await prisma.$transaction((tx) =>
      ordersService.createOrderFromPayment(stripeIntentId, cartView, deliverySelections, tx),
    );
  } catch (err: unknown) {
    const isProviderRefConflict =
      typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
    if (!isProviderRefConflict) {
      throw err;
    }
    return prisma.$transaction((tx) =>
      ordersService.createOrderFromPayment(stripeIntentId, cartView, deliverySelections, tx),
    );
  }
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

      await expect(
        prisma.$transaction((tx) =>
          ordersService.createOrderFromPayment(
            "pi_o2_rollback",
            cartView,
            [{ producerId: producer.id, deliveryModeId: dm.id }],
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(InsufficientStockError);

      const payment = await db.payment.findUnique({ where: { providerRef: "pi_o2_rollback" } });
      expect(payment).toBeNull();

      const freshHealthy = await db.product.findUniqueOrThrow({ where: { id: productHealthy.id } });
      expect(freshHealthy.stock).toBe(10); // untouched — proves the FIRST line's decrement rolled back too

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

      const [r1, r2] = await Promise.allSettled([
        invokeWithP2002Recovery(intentId, cartView, selections),
        invokeWithP2002Recovery(intentId, cartView, selections),
      ]);

      // Both calls recover to a fulfilled result (the winner commits directly;
      // the loser's fresh-transaction retry finds the winner's row via step 0).
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");
      const orderId1 = (r1 as PromiseFulfilledResult<ordersService.OrderDetailView>).value.id;
      const orderId2 = (r2 as PromiseFulfilledResult<ordersService.OrderDetailView>).value.id;
      expect(orderId1).toBe(orderId2);

      const paymentCount = await db.payment.count({ where: { providerRef: intentId } });
      expect(paymentCount).toBe(1);
      const orderCount = await db.order.count({ where: { payment: { providerRef: intentId } } });
      expect(orderCount).toBe(1);
    },
    20000,
  );
});
