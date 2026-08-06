/**
 * Shared seed/cleanup scaffolding for the payments integration suite
 * (cycle-5 payments — WU1 Payment Intent creation, and the anticipated WU2
 * webhook trust boundary / WU3 atomic webhook events work units).
 *
 * REFACTOR NOTE (post-WU1, strict TDD REFACTOR step): extracted verbatim
 * from `tests/integration/payments.test.ts` to remove duplicated seed/
 * cleanup boilerplate before WU2/WU3 re-author their own scaffolding. No
 * behavior changed — every function body is byte-for-byte the same logic
 * that lived inline in the test file, only parameterized on `db` and a
 * `PaymentsFixtureCleanup` bag instead of closing over file-level `let`s.
 *
 * Mirrors the seedProducer/seedConsumer pattern established by
 * `tests/integration/orders.test.ts`. `orders.test.ts` itself is
 * intentionally NOT modified or migrated to this module — it stays frozen;
 * only payments-module tests consume this file.
 *
 * Pure test infrastructure — no production code (`src/**`) is modified by
 * this file, and importing it does not change any request/response
 * assertion in the tests that use it.
 */
import type { PrismaClient } from "@prisma/client";

import * as cartService from "@/modules/cart/services/cart.service";

/**
 * Tracks the rows created by the seed helpers below so a single
 * `cleanupPaymentsFixtures` call can tear them all down in FK-safe order
 * (children before parents).
 *
 * `providerRefs` (WU3 addition): Stripe PaymentIntent ids used by webhook
 * atomic-event tests (`tests/integration/payments.test.ts` WU3 describe
 * blocks) — these tests write REAL `Order`/`SubOrder`/`OrderLine`/`Payment`
 * rows via the frozen `createOrderFromPayment`, which WU1/WU2 never did.
 * `Order`/`SubOrder`/`OrderLine` are Restrict-FK'd to `Producer`/`Product`/
 * `DeliveryMode` (schema.prisma), so this file's existing `deliveryMode`/
 * `product`/`producer` deletes below would fail with a foreign-key violation
 * once any WU3 test has run, UNLESS the Order aggregate is deleted first —
 * see `cleanupPaymentsFixtures`.
 */
export interface PaymentsFixtureCleanup {
  userIds: string[];
  producerIds: string[];
  categorySlugs: Set<string>;
  providerRefs: string[];
}

export function createPaymentsFixtureCleanup(): PaymentsFixtureCleanup {
  return { userIds: [], producerIds: [], categorySlugs: new Set<string>(), providerRefs: [] };
}

export async function isDbReachable(db: PrismaClient): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

export function consumerClaim(sub: string): Record<string, unknown> {
  return { sub, "https://mercado-artesanal.com/email": `${sub}@test.local` };
}

/** The `auth0Sub` convention used by `seedConsumer` below — exposed so
 * callers can build a matching claim/header without duplicating the
 * `test-payments-${namePrefix}-user` string. */
export function consumerSubFor(namePrefix: string): string {
  return `test-payments-${namePrefix}-user`;
}

/** Convenience: `authHeader(consumerClaim(consumerSubFor(namePrefix)))` in
 * one call — the exact pattern every WU1 test repeats per scenario. */
export function consumerAuthHeaderFor(namePrefix: string): string {
  return authHeader(consumerClaim(consumerSubFor(namePrefix)));
}

export async function seedProducer(db: PrismaClient, cleanup: PaymentsFixtureCleanup, namePrefix: string, nif: string) {
  const category = await db.category.upsert({
    where: { slug: `test-payments-${namePrefix}-cat` },
    create: { slug: `test-payments-${namePrefix}-cat`, name: `Test Payments ${namePrefix} Category`, isActive: true },
    update: {},
  });
  cleanup.categorySlugs.add(category.slug);

  const producerUser = await db.user.upsert({
    where: { auth0Sub: `test-payments-${namePrefix}-producer` },
    create: {
      auth0Sub: `test-payments-${namePrefix}-producer`,
      email: `payments-${namePrefix}-producer@test.local`,
      role: "PRODUCER",
    },
    update: {},
  });
  cleanup.userIds.push(producerUser.id);

  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: `Test Payments Producer ${namePrefix}`,
      nif,
      description: "Producer for payments WU1 integration tests",
      addressLine1: "Calle Pagos 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  cleanup.producerIds.push(producer.id);

  return { category, producer };
}

export async function seedConsumer(db: PrismaClient, cleanup: PaymentsFixtureCleanup, namePrefix: string) {
  const user = await db.user.upsert({
    where: { auth0Sub: consumerSubFor(namePrefix) },
    create: {
      auth0Sub: consumerSubFor(namePrefix),
      email: `payments-${namePrefix}@test.local`,
      role: "CONSUMER",
    },
    update: {},
  });
  cleanup.userIds.push(user.id);
  return user;
}

/**
 * Composed convenience seed: producer + category + an active delivery mode
 * + one in-stock product + a consumer with the product already in cart.
 * Covers the "checkout-ready cart" shape shared by every WU1 test that
 * needs live stock + an active delivery mode (PH1/PH6/PH7/PH8), and the
 * anticipated WU2/WU3 succeeded/failed webhook scenarios that need the same
 * starting fixture before the webhook fires.
 *
 * checkout-contracts WU4 (BE-3, design Fork 1): the delivery mode this
 * helper creates is always `SHIPPING_FLAT_RATE`, so BE-3 now requires an
 * `addressId` on `POST /pagos/intent` for every caller of this composed
 * helper. An owned `Address` is seeded alongside the consumer and its id is
 * returned as `addressId` so existing PH1/PH6/PH7/PH8/WU2-4/BE2-R3-* call
 * sites can pass it through unchanged in shape, just with one more field.
 *
 * Callers that need a DIFFERENT shape (no delivery mode, no cart item, an
 * empty cart, etc. — e.g. PH3/PH4/PH5) use `seedProducer`/`seedConsumer`
 * directly instead of this composed helper.
 */
export async function seedCheckoutReadyCart(
  db: PrismaClient,
  cleanup: PaymentsFixtureCleanup,
  options: {
    namePrefix: string;
    nif: string;
    price?: number;
    stock?: number;
    deliveryCost?: number;
    quantity?: number;
  },
) {
  const { namePrefix, nif, price = 5.0, stock = 10, deliveryCost = 2.0, quantity = 1 } = options;

  const { producer, category } = await seedProducer(db, cleanup, namePrefix, nif);
  const consumer = await seedConsumer(db, cleanup, namePrefix);

  const deliveryMode = await db.deliveryMode.create({
    data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: deliveryCost, isActive: true },
  });
  const product = await db.product.create({
    data: {
      producerId: producer.id,
      categoryId: category.id,
      name: `${namePrefix.toUpperCase()} Product`,
      description: "d",
      price,
      stock,
      isActive: true,
    },
  });

  await cartService.addItem(consumer.id, product.id, quantity);

  const address = await db.address.create({
    data: {
      userId: consumer.id,
      line1: "Calle Envio 1",
      city: "Valencia",
      postalCode: "46001",
      province: "Valencia",
      isDefault: true,
    },
  });

  // WU3 rework: `cartId` is exposed so webhook-event fixtures can build a
  // `metadata.cartId` that matches what `getCartForCheckout` will ACTUALLY
  // resolve at webhook time (Bug 2 fix — the reconciliation guard compares
  // `cartView.cartId === metadata.cartId`).
  const cartView = await cartService.getCartForCheckout(consumer.id);

  return {
    producer,
    category,
    consumer,
    deliveryMode,
    product,
    quantity,
    cartId: cartView.cartId,
    addressId: address.id,
  };
}

export async function cleanupPaymentsFixtures(db: PrismaClient, cleanup: PaymentsFixtureCleanup): Promise<void> {
  // WU3: tear down any real Order aggregate written by webhook atomic-event
  // tests BEFORE the deliveryMode/product/producer deletes below — both are
  // Restrict-FK'd from SubOrder/OrderLine and would otherwise fail once any
  // WU3 test has created an Order. Order/SubOrder have no cascade, so this
  // must run child-first: OrderLine -> SubOrder -> Order -> Payment.
  await db.orderLine.deleteMany({ where: { subOrder: { order: { userId: { in: cleanup.userIds } } } } });
  await db.subOrder.deleteMany({ where: { order: { userId: { in: cleanup.userIds } } } });
  await db.order.deleteMany({ where: { userId: { in: cleanup.userIds } } });
  await db.payment.deleteMany({ where: { providerRef: { in: cleanup.providerRefs } } });
  await db.pendingCheckout.deleteMany({ where: { userId: { in: cleanup.userIds } } });

  await db.cartItem.deleteMany({ where: { cart: { userId: { in: cleanup.userIds } } } });
  await db.cart.deleteMany({ where: { userId: { in: cleanup.userIds } } });
  // checkout-contracts WU4: seedCheckoutReadyCart now seeds an owned Address
  // (Address.userId is onDelete: Restrict) — must be cleared before the
  // user delete below, or that delete would fail with a FK violation.
  await db.address.deleteMany({ where: { userId: { in: cleanup.userIds } } });
  await db.deliveryMode.deleteMany({ where: { producerId: { in: cleanup.producerIds } } });
  await db.product.deleteMany({ where: { producerId: { in: cleanup.producerIds } } });
  await db.producer.deleteMany({ where: { id: { in: cleanup.producerIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
  await db.category.deleteMany({ where: { slug: { in: [...cleanup.categorySlugs] } } });
}
