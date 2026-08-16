/**
 * Integration tests — account-lifecycle real Postgres concurrency proofs
 * (admin-user-management WU1, task 1.1).
 *
 * Strategy: real Postgres on localhost:5433 (same disposable test container
 * used by orders.test.ts / inventory.concurrency.test.ts). Does NOT mock
 * prisma — exercises the real `FOR UPDATE` row lock `lockUserRows` takes
 * and the real `prisma.$transaction` semantics that a mocked `tx` cannot
 * prove.
 *
 * Both scenarios below use the SAME forced-overlap technique as
 * `orders.test.ts`'s [O5]: a "holder" transaction acquires the real
 * `FOR UPDATE` lock on the target User row and is held open (uncommitted)
 * on a barrier; the "checkout" call is only released past its lock-wait
 * once `pg_stat_activity` confirms it is genuinely BLOCKED on that specific
 * lock (via a tagged `application_name`) — never a fixed delay or hopeful
 * `Promise.allSettled` interleaving. This guarantees a REAL overlap.
 *
 * The "holder" side intentionally does NOT call the production
 * `adminUsersService.activateUser`/`deactivateUser`/`deleteUser` functions
 * — those self-manage their OWN internal `$transaction` and cannot be held
 * open externally on a test barrier. Instead each test's holder issues the
 * SAME raw `SELECT ... FOR UPDATE` + lifecycle-column `UPDATE` those
 * service functions perform, inside its own `prisma.$transaction`. This
 * isolates exactly what this test exists to prove: that
 * `lockAndAssertOwnersActive`'s row lock genuinely blocks against ANY
 * concurrent holder of that same lock (production admin transition or
 * this test double — the lock itself does not care), and that checkout
 * correctly fails closed once it observes the now-inactive state.
 *
 * Scenarios covered:
 *
 *   [ALC1] Deactivation races checkout (producer owner)
 *     GIVEN a producer's owning User is about to be deactivated
 *     WHEN createOrderFromPayment's Step 1b lock blocks on that same row,
 *          the deactivation commits, THEN checkout's lock unblocks
 *     THEN checkout observes the deactivated owner and fails with
 *          CartItemNotAvailableError — no Order/Payment is ever created
 *     AND the deactivation itself is left committed (deactivatedAt set)
 *
 *   [ALC2] Deletion races checkout (consumer's own account)
 *     GIVEN a consumer is about to be deleted (tombstoned) while their own
 *     checkout is in flight
 *     WHEN createOrderFromPayment's Step 1b lock blocks on the consumer's
 *          own User row, the deletion commits, THEN checkout's lock unblocks
 *     THEN checkout observes the deleted consumer and fails with
 *          AccountInactiveError — no Order/Payment is ever created, and no
 *          active order is ever created for a deleted account
 *
 * Spec references:
 *   account-lifecycle §"Commerce lifecycle consistency" — "Deactivation
 *     races checkout", "Deletion races checkout"
 *   design — "ORM vs row locks", "Post-Stripe snapshot vs locked preflight"
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed).
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cartService from "@/modules/cart/services/cart.service";
import * as ordersService from "@/modules/orders/services/orders.service";
import { AccountInactiveError, CartItemNotAvailableError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

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
// Shared barrier/lock-wait helpers — mirror orders.test.ts's [O5] technique.
// ---------------------------------------------------------------------------

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

async function waitForLockWait(
  dbClient: PrismaClient,
  timeoutMs: number,
  applicationNameTag: string,
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
const cleanupUserIds: string[] = [];
const cleanupProducerIds: string[] = [];
const cleanupCategorySlugs = new Set<string>();

async function seedProducer(namePrefix: string, nif: string) {
  const category = await db.category.upsert({
    where: { slug: `test-alc-${namePrefix}-cat` },
    create: { slug: `test-alc-${namePrefix}-cat`, name: `Test ALC ${namePrefix} Category`, isActive: true },
    update: {},
  });
  cleanupCategorySlugs.add(category.slug);

  const producerUser = await db.user.create({
    data: {
      auth0Sub: `test-alc-${namePrefix}-producer-${randomUUID()}`,
      email: `alc-${namePrefix}-producer-${randomUUID()}@test.local`,
      role: "PRODUCER",
    },
  });
  cleanupUserIds.push(producerUser.id);

  const producer = await db.producer.create({
    data: {
      userId: producerUser.id,
      businessName: `Test ALC Producer ${namePrefix}`,
      nif,
      description: "Producer for account-lifecycle concurrency tests",
      addressLine1: "Calle ALC 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
  });
  cleanupProducerIds.push(producer.id);

  return { producerUser, producer, category };
}

async function seedConsumer(namePrefix: string) {
  const user = await db.user.create({
    data: {
      auth0Sub: `test-alc-${namePrefix}-consumer-${randomUUID()}`,
      email: `alc-${namePrefix}-consumer-${randomUUID()}@test.local`,
      role: "CONSUMER",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

let nifCounter = 97000000;
function nextNif(): string {
  nifCounter += 1;
  return `B${nifCounter}`;
}

afterAll(async () => {
  if (dbReachable) {
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
    await db.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
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
// [ALC1] Deactivation races checkout — producer owner
// ===========================================================================

describe("Deactivation races checkout [ALC1]", () => {
  it(
    "[ALC1] checkout observes the deactivated producer owner and fails; no order is ever created",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producerUser, producer, category } = await seedProducer("alc1", nextNif());
      const consumer = await seedConsumer("alc1");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "PICKUP", cost: 0, isActive: true, pickupLocation: "x" },
      });
      const product = await db.product.create({
        data: {
          producerId: producer.id,
          categoryId: category.id,
          name: "ALC1 Product",
          description: "d",
          price: 5.0,
          stock: 10,
          isActive: true,
        },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      const selections = [{ producerId: producer.id, deliveryModeId: dm.id }];
      const intentId = `pi_alc1_${randomUUID()}`;

      // Holder transaction: acquires the SAME FOR UPDATE lock
      // `lockAndAssertOwnersActive` takes on the producer's owning User
      // row, then deactivates it, then holds the transaction open
      // (uncommitted) on a barrier.
      const releaseHolder = createDeferred();
      const holderLockAcquired = createDeferred();
      const holderPromise = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT id FROM users WHERE id = '${producerUser.id}' FOR UPDATE`,
          );
          await tx.user.update({
            where: { id: producerUser.id },
            data: { deactivatedAt: new Date() },
          });
          holderLockAcquired.resolve();
          await releaseHolder.promise;
        },
        { timeout: 20000, maxWait: 20000 },
      );

      await holderLockAcquired.promise;

      // Checkout call: tagged so waitForLockWait can confirm SPECIFICALLY
      // this backend is blocked on the holder's lock.
      const checkoutTag = `alc1_checkout_${randomUUID()}`;
      const checkoutPromise = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL application_name = '${checkoutTag}'`);
          return ordersService.createOrderFromPayment(intentId, cartView, selections, tx);
        },
        { timeout: 20000, maxWait: 20000 },
      );

      let lockWaitError: unknown;
      try {
        await waitForLockWait(db, 5000, checkoutTag);
      } catch (err) {
        lockWaitError = err;
      } finally {
        releaseHolder.resolve();
      }

      const [holderSettled, checkoutSettled] = await Promise.allSettled([holderPromise, checkoutPromise]);

      if (lockWaitError) {
        throw lockWaitError;
      }
      expect(holderSettled.status).toBe("fulfilled");
      expect(checkoutSettled.status).toBe("rejected");
      const checkoutError = (checkoutSettled as PromiseRejectedResult).reason;
      expect(checkoutError).toBeInstanceOf(CartItemNotAvailableError);

      // No order/payment was ever created for this intent.
      const paymentCount = await db.payment.count({ where: { providerRef: intentId } });
      expect(paymentCount).toBe(0);

      // The deactivation itself committed successfully.
      const ownerRow = await db.user.findUniqueOrThrow({ where: { id: producerUser.id } });
      expect(ownerRow.deactivatedAt).not.toBeNull();
    },
    25000,
  );
});

// ===========================================================================
// [ALC2] Deletion races checkout — consumer's own account
// ===========================================================================

describe("Deletion races checkout [ALC2]", () => {
  it(
    "[ALC2] checkout observes the deleted consumer and fails; no active order is ever created for a deleted account",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { producer, category } = await seedProducer("alc2", nextNif());
      const consumer = await seedConsumer("alc2");
      const dm = await db.deliveryMode.create({
        data: { producerId: producer.id, type: "PICKUP", cost: 0, isActive: true, pickupLocation: "x" },
      });
      const product = await db.product.create({
        data: {
          producerId: producer.id,
          categoryId: category.id,
          name: "ALC2 Product",
          description: "d",
          price: 5.0,
          stock: 10,
          isActive: true,
        },
      });

      await cartService.addItem(consumer.id, product.id, 1);
      const cartView = await cartService.getCartForCheckout(consumer.id);
      const selections = [{ producerId: producer.id, deliveryModeId: dm.id }];
      const intentId = `pi_alc2_${randomUUID()}`;

      // Holder transaction: locks + tombstones the CONSUMER'S OWN User row
      // (mirrors adminUsersService.deleteUser's Step 1/4 — this test double
      // exists only because deleteUser self-manages its own $transaction
      // and cannot be held open externally on a barrier; see file header).
      const releaseHolder = createDeferred();
      const holderLockAcquired = createDeferred();
      const tombstoneEmail = `deleted+${consumer.id}@tombstone.invalid`;
      const holderPromise = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = '${consumer.id}' FOR UPDATE`);
          await tx.user.update({
            where: { id: consumer.id },
            data: { deletedAt: new Date(), email: tombstoneEmail, emailVerified: false },
          });
          holderLockAcquired.resolve();
          await releaseHolder.promise;
        },
        { timeout: 20000, maxWait: 20000 },
      );

      await holderLockAcquired.promise;

      const checkoutTag = `alc2_checkout_${randomUUID()}`;
      const checkoutPromise = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL application_name = '${checkoutTag}'`);
          return ordersService.createOrderFromPayment(intentId, cartView, selections, tx);
        },
        { timeout: 20000, maxWait: 20000 },
      );

      let lockWaitError: unknown;
      try {
        await waitForLockWait(db, 5000, checkoutTag);
      } catch (err) {
        lockWaitError = err;
      } finally {
        releaseHolder.resolve();
      }

      const [holderSettled, checkoutSettled] = await Promise.allSettled([holderPromise, checkoutPromise]);

      if (lockWaitError) {
        throw lockWaitError;
      }
      expect(holderSettled.status).toBe("fulfilled");
      expect(checkoutSettled.status).toBe("rejected");
      const checkoutError = (checkoutSettled as PromiseRejectedResult).reason;
      expect(checkoutError).toBeInstanceOf(AccountInactiveError);

      // No active order was ever created for the now-deleted account.
      const orderCount = await db.order.count({ where: { userId: consumer.id } });
      expect(orderCount).toBe(0);

      const consumerRow = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });
      expect(consumerRow.deletedAt).not.toBeNull();
    },
    25000,
  );
});
