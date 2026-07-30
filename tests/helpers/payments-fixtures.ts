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
 */
export interface PaymentsFixtureCleanup {
  userIds: string[];
  producerIds: string[];
  categorySlugs: Set<string>;
}

export function createPaymentsFixtureCleanup(): PaymentsFixtureCleanup {
  return { userIds: [], producerIds: [], categorySlugs: new Set<string>() };
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

  return { producer, category, consumer, deliveryMode, product, quantity };
}

export async function cleanupPaymentsFixtures(db: PrismaClient, cleanup: PaymentsFixtureCleanup): Promise<void> {
  await db.cartItem.deleteMany({ where: { cart: { userId: { in: cleanup.userIds } } } });
  await db.cart.deleteMany({ where: { userId: { in: cleanup.userIds } } });
  await db.deliveryMode.deleteMany({ where: { producerId: { in: cleanup.producerIds } } });
  await db.product.deleteMany({ where: { producerId: { in: cleanup.producerIds } } });
  await db.producer.deleteMany({ where: { id: { in: cleanup.producerIds } } });
  await db.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
  await db.category.deleteMany({ where: { slug: { in: [...cleanup.categorySlugs] } } });
}
