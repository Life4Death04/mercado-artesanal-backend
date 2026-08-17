/**
 * Integration tests — admin-users ADMIN discovery/lifecycle surface
 * (admin-user-management WU2-WU4, real Postgres + Supertest).
 *
 * Strategy: real Postgres on localhost:5433 (same disposable test container
 * used by admin-incidents.test.ts / orders.test.ts / payments.test.ts).
 * Does NOT mock `@/shared/utils/prisma` — exercises the real
 * `prisma.$transaction`, the real row lock (`lockUserRows`), and real
 * conditional-write behavior.
 *
 * Scenarios covered:
 *   [AU1-AU4]   RBAC: missing JWT -> 401; CONSUMER/PRODUCER/PENDING_ROLE -> 403 FORBIDDEN.
 *   [AU5]       ADMIN reaches the list; forbidden roles (ADMIN, PENDING_ROLE)
 *               never appear even when they match a search term.
 *   [AU6]       Deterministic page-8 listing, `createdAt DESC, id DESC`.
 *   [AU7]       Producer detail: activity counts unambiguous
 *               (2 producer orders, 3 published products), includes producerId.
 *   [AU8]       Unknown/non-actionable id -> 404 NOT_FOUND.
 *   [AU9]       Repeated deactivate is idempotent (no double state change).
 *   [AU10]      Activation from DEACTIVATED commits exactly one
 *               ACCOUNT_ACTIVATED notification atomically.
 *   [AU11]      Activating a DELETED (tombstoned) account -> 409 ACCOUNT_DELETED.
 *   [AU12]      Active orders block deletion -> 409 USER_HAS_ACTIVE_ORDERS,
 *               no profile or lifecycle data changes.
 *   [AU13]      Successful deletion redacts profile + address, retains id
 *               and producer commercial data; returns 204.
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed).
 *
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 *   account-lifecycle §"Approved tombstone redaction"
 *   notifications §"Event-to-Recipient Emission Mapping" — Activation
 *   error-handling §"Account lifecycle error contract"
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emailProvider } from "@/shared/email/email-provider";

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
// Seed helpers
// ---------------------------------------------------------------------------
const cleanupUserIds: string[] = [];
const cleanupProducerIds: string[] = [];
const cleanupCategorySlugs = new Set<string>();

let nifCounter = 96000000;
function nextNif(): string {
  nifCounter += 1;
  return `B${nifCounter}`;
}

async function seedAdmin(namePrefix: string) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-admin-users-${namePrefix}-admin` },
    create: {
      auth0Sub: `test-admin-users-${namePrefix}-admin`,
      email: `admin-users-${namePrefix}-admin@test.local`,
      role: "ADMIN",
    },
    update: {},
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedRoleUser(
  namePrefix: string,
  role: "CONSUMER" | "PRODUCER" | "PENDING_ROLE" | "ADMIN",
) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-admin-users-${namePrefix}-role` },
    create: {
      auth0Sub: `test-admin-users-${namePrefix}-role`,
      email: `admin-users-${namePrefix}-role@test.local`,
      role,
    },
    update: { role },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedConsumer(namePrefix: string, overrides: Record<string, unknown> = {}) {
  const user = await db.user.create({
    data: {
      auth0Sub: `test-admin-users-${namePrefix}-consumer-${Date.now()}-${Math.random()}`,
      email: `admin-users-${namePrefix}-consumer-${Date.now()}-${Math.random()}@test.local`,
      role: "CONSUMER",
      firstName: "Ana",
      lastName: "García",
      ...overrides,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedProducer(namePrefix: string, overrides: Record<string, unknown> = {}) {
  const category = await db.category.upsert({
    where: { slug: `test-admin-users-${namePrefix}-cat` },
    create: { slug: `test-admin-users-${namePrefix}-cat`, name: `Cat ${namePrefix}`, isActive: true },
    update: {},
  });
  cleanupCategorySlugs.add(category.slug);

  const producerUser = await db.user.create({
    data: {
      auth0Sub: `test-admin-users-${namePrefix}-producer-${Date.now()}-${Math.random()}`,
      email: `admin-users-${namePrefix}-producer-${Date.now()}-${Math.random()}@test.local`,
      role: "PRODUCER",
      ...overrides,
    },
  });
  cleanupUserIds.push(producerUser.id);

  const producer = await db.producer.create({
    data: {
      userId: producerUser.id,
      businessName: `Test Admin Users Producer ${namePrefix}`,
      nif: nextNif(),
      description: "Producer for admin-user-management WU2-WU4 tests",
      addressLine1: "Calle Admin Users 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
  });
  cleanupProducerIds.push(producer.id);

  return { producerUser, producer, category };
}

async function seedProduct(
  producerId: string,
  categoryId: string,
  overrides: Record<string, unknown> = {},
) {
  return db.product.create({
    data: {
      producerId,
      categoryId,
      name: "Product",
      description: "d",
      price: 5.0,
      stock: 10,
      isActive: true,
      moderationStatus: "OK",
      ...overrides,
    },
  });
}

async function seedSubOrderForProducer(
  producerId: string,
  consumerId: string,
  status: "pending" | "preparing" | "sent" | "delivered" | "cancelled" = "pending",
) {
  const dm = await db.deliveryMode.create({
    data: { producerId, type: "PICKUP", cost: 0, isActive: true, pickupLocation: "x" },
  });
  const payment = await db.payment.create({ data: { status: "SUCCEEDED", amount: 10.0 } });
  // order-public-numbers WU1/WU2: orderNumber/subOrderNumber are now
  // DB-required. This fixture writes Order/SubOrder directly (not through
  // the allocator-wired orders.service.ts) and is called REPEATEDLY for the
  // SAME producerId/consumerId, so count+1 derives a scope-unique value per
  // call — narrow type-safety compatibility only, unrelated to this suite's
  // admin-users behavior under test.
  const orderNumber = (await db.order.count({ where: { userId: consumerId } })) + 1;
  const order = await db.order.create({
    data: { userId: consumerId, paymentId: payment.id, totalAmount: 10.0, orderNumber },
  });
  const subOrderNumber = (await db.subOrder.count({ where: { producerId } })) + 1;
  const subOrder = await db.subOrder.create({
    data: {
      orderId: order.id,
      producerId,
      deliveryModeId: dm.id,
      status,
      shippingCostSnapshot: 0,
      subOrderNumber,
    },
  });
  return { dm, payment, order, subOrder };
}

function adminAuth(admin: { auth0Sub: string }): string {
  return authHeader({ sub: admin.auth0Sub });
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
    await db.deliveryMode.deleteMany({ where: { producerId: { in: cleanupProducerIds } } });
    await db.product.deleteMany({ where: { producerId: { in: cleanupProducerIds } } });
    await db.address.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await db.pendingCheckout.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await db.producer.deleteMany({ where: { id: { in: cleanupProducerIds } } });
    await db.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await db.category.deleteMany({ where: { slug: { in: [...cleanupCategorySlugs] } } });
  }
  await db.$disconnect();
});

beforeAll(async () => {
  dbReachable = await isDbReachable();
});

// ===========================================================================
// RBAC — admin-user-management §"Non-admin action is denied"
// ===========================================================================

describe("Admin users RBAC — /api/v1/admin/users/*", () => {
  it("[AU1] missing JWT returns 401", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const res = await request.get("/api/v1/admin/users");
    expect(res.status).toBe(401);
  });

  it("[AU2] CONSUMER returns 403 FORBIDDEN", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const consumer = await seedRoleUser("rbac-consumer", "CONSUMER");
    const res = await request
      .get("/api/v1/admin/users")
      .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("[AU3] PRODUCER returns 403 FORBIDDEN", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const producer = await seedRoleUser("rbac-producer", "PRODUCER");
    const res = await request
      .get("/api/v1/admin/users")
      .set("X-Test-Auth", authHeader({ sub: producer.auth0Sub }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("[AU4] PENDING_ROLE returns 403 FORBIDDEN", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const pending = await seedRoleUser("rbac-pending", "PENDING_ROLE");
    const res = await request
      .get("/api/v1/admin/users")
      .set("X-Test-Auth", authHeader({ sub: pending.auth0Sub }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });
});

// ===========================================================================
// Discovery — admin-user-management §"Deterministic user discovery"
// ===========================================================================

describe("GET /api/v1/admin/users — discovery", () => {
  it("[AU5] forbidden roles never appear even when they match a search term", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au5");
    const uniqueTag = `au5tag${Date.now()}`;
    await seedConsumer("au5-visible", { firstName: uniqueTag });
    await seedRoleUser("au5-admin-hidden", "ADMIN");
    // ADMIN role account with a matching name — must never appear.
    await db.user.update({
      where: { id: (await seedRoleUser("au5-admin-match", "ADMIN")).id },
      data: { firstName: uniqueTag },
    });

    const res = await request
      .get(`/api/v1/admin/users?search=${uniqueTag}`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of res.body.items as Array<{ role: string }>) {
      expect(["CONSUMER", "PRODUCER"]).toContain(item.role);
    }
  });

  it("[AU6] returns a deterministic createdAt DESC, id DESC page-8 listing", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au6");
    const uniqueTag = `au6tag${Date.now()}`;
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await seedConsumer(`au6-${i}`, { firstName: uniqueTag }));
    }

    const res1 = await request
      .get(`/api/v1/admin/users?search=${uniqueTag}&page=1`)
      .set("X-Test-Auth", adminAuth(admin));
    const res2 = await request
      .get(`/api/v1/admin/users?search=${uniqueTag}&page=1`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res1.status).toBe(200);
    expect(res1.body.items.map((i: { id: string }) => i.id)).toEqual(
      res2.body.items.map((i: { id: string }) => i.id),
    );
    expect(res1.body.pageSize).toBe(8);
    expect(res1.body.totalItems).toBeGreaterThanOrEqual(3);
  });

  // Spec: admin-user-management §"Search and filters produce a stable page"
  // — descending id tie-break when createdAt is identical, plus full page
  // metadata.
  it("[AU6b] ties on createdAt break by descending id, and page metadata is complete", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au6b");
    const uniqueTag = `au6btag${Date.now()}`;
    const tiedAt = new Date("2026-01-01T00:00:00Z");
    const first = await seedConsumer("au6b-a", { firstName: uniqueTag });
    const second = await seedConsumer("au6b-b", { firstName: uniqueTag });
    await db.user.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { createdAt: tiedAt },
    });
    const expectedOrder = [first.id, second.id].sort().reverse();

    const res = await request
      .get(`/api/v1/admin/users?search=${uniqueTag}&page=1`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(expectedOrder);
    expect(res.body).toMatchObject({ page: 1, pageSize: 8, totalItems: 2, totalPages: 1 });
  });
});

// ===========================================================================
// Detail + activity — admin-user-management §"User detail and activity
// definitions"
// ===========================================================================

describe("GET /api/v1/admin/users/:id — detail and activity", () => {
  it("[AU7] producer activity reports 2 producer orders and 3 published products, includes producerId", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au7");
    const { producerUser, producer, category } = await seedProducer("au7");
    const consumer = await seedConsumer("au7-buyer");

    await seedProduct(producer.id, category.id, { name: "P1", isActive: true, moderationStatus: "OK" });
    await seedProduct(producer.id, category.id, { name: "P2", isActive: true, moderationStatus: "OK" });
    await seedProduct(producer.id, category.id, { name: "P3", isActive: true, moderationStatus: "OK" });
    await seedProduct(producer.id, category.id, {
      name: "P4-inactive",
      isActive: false,
      moderationStatus: "OK",
    });

    await seedSubOrderForProducer(producer.id, consumer.id, "pending");
    await seedSubOrderForProducer(producer.id, consumer.id, "delivered");

    const res = await request
      .get(`/api/v1/admin/users/${producerUser.id}`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(200);
    expect(res.body.producerId).toBe(producer.id);
    expect(res.body.activity.orderCount).toBe(2);
    expect(res.body.activity.publishedProductCount).toBe(3);
    expect(res.body.activity.activeOrderCount).toBe(1);
  });

  it("[AU8] unknown or non-actionable (ADMIN) id returns 404 NOT_FOUND", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au8");
    const otherAdmin = await seedRoleUser("au8-other", "ADMIN");

    const resUnknown = await request
      .get("/api/v1/admin/users/does-not-exist")
      .set("X-Test-Auth", adminAuth(admin));
    expect(resUnknown.status).toBe(404);
    expect(resUnknown.body.code).toBe("NOT_FOUND");

    const resAdminTarget = await request
      .get(`/api/v1/admin/users/${otherAdmin.id}`)
      .set("X-Test-Auth", adminAuth(admin));
    expect(resAdminTarget.status).toBe(404);
  });
});

// ===========================================================================
// Guarded lifecycle actions — admin-user-management §"Guarded lifecycle
// actions"
// ===========================================================================

describe("PATCH /api/v1/admin/users/:id/deactivate — idempotent", () => {
  it("[AU9] repeated deactivate succeeds without creating another state change", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au9");
    const consumer = await seedConsumer("au9-target");

    const first = await request
      .patch(`/api/v1/admin/users/${consumer.id}/deactivate`)
      .set("X-Test-Auth", adminAuth(admin));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("DEACTIVATED");

    const firstRow = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });

    const second = await request
      .patch(`/api/v1/admin/users/${consumer.id}/deactivate`)
      .set("X-Test-Auth", adminAuth(admin));
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("DEACTIVATED");

    const secondRow = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });
    expect(secondRow.deactivatedAt?.getTime()).toBe(firstRow.deactivatedAt?.getTime());
  });
});

describe("PATCH /api/v1/admin/users/:id/activate — atomic notification", () => {
  it("[AU10] activation from DEACTIVATED commits exactly one ACCOUNT_ACTIVATED notification", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au10");
    const consumer = await seedConsumer("au10-target");
    await db.user.update({ where: { id: consumer.id }, data: { deactivatedAt: new Date() } });

    const res = await request
      .patch(`/api/v1/admin/users/${consumer.id}/activate`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");

    const notifications = await db.notification.findMany({
      where: { userId: consumer.id, type: "ACCOUNT_ACTIVATED" },
    });
    expect(notifications).toHaveLength(1);

    // Spec: notifications §"Replayed event does not duplicate" — an
    // already-ACTIVE target's activation is an idempotent no-op and MUST
    // NOT create a second notification.
    const replay = await request
      .patch(`/api/v1/admin/users/${consumer.id}/activate`)
      .set("X-Test-Auth", adminAuth(admin));
    expect(replay.status).toBe(200);
    const notificationsAfterReplay = await db.notification.findMany({
      where: { userId: consumer.id, type: "ACCOUNT_ACTIVATED" },
    });
    expect(notificationsAfterReplay).toHaveLength(1);
  });

  // Spec: email-provider §"Activation dispatches after commit", §"Email
  // failure does not undo activation" — spies on the real singleton
  // (Console provider, per test env), same pattern as payments.test.ts
  // [N-EMIT-NONBLOCKING].
  it("[AU10b] a rejected activation email never undoes the committed activation/notification", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au10b");
    const consumer = await seedConsumer("au10b-target");
    await db.user.update({ where: { id: consumer.id }, data: { deactivatedAt: new Date() } });
    const sendSpy = vi.spyOn(emailProvider, "send").mockRejectedValueOnce(new Error("SMTP down"));

    const res = await request
      .patch(`/api/v1/admin/users/${consumer.id}/activate`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const notifications = await db.notification.findMany({
      where: { userId: consumer.id, type: "ACCOUNT_ACTIVATED" },
    });
    expect(notifications).toHaveLength(1);
    sendSpy.mockRestore();
  });

  it("[AU11] activating a DELETED account returns 409 ACCOUNT_DELETED", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au11");
    const consumer = await seedConsumer("au11-target");
    await db.user.update({ where: { id: consumer.id }, data: { deletedAt: new Date() } });
    const sendSpy = vi.spyOn(emailProvider, "send");

    const res = await request
      .patch(`/api/v1/admin/users/${consumer.id}/activate`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_DELETED");
    expect(res.body.type).toBe("/errors/account-deleted");
    // Spec: email-provider §"Rolled-back activation sends no email".
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();

    // Spec: notifications §"Activation is atomic and unique" — "activation
    // failure or rollback MUST leave neither outcome": a rejected
    // activation attempt commits no ACCOUNT_ACTIVATED notification.
    const notifications = await db.notification.findMany({
      where: { userId: consumer.id, type: "ACCOUNT_ACTIVATED" },
    });
    expect(notifications).toHaveLength(0);
  });
});

// ===========================================================================
// Tombstone deletion — admin-user-management §"Guarded lifecycle actions",
// account-lifecycle §"Approved tombstone redaction"
// ===========================================================================

describe("DELETE /api/v1/admin/users/:id — irreversible tombstone deletion", () => {
  it("[AU12] active orders block deletion with no profile or lifecycle change", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au12");
    const consumer = await seedConsumer("au12-target");
    const { producer, category } = await seedProducer("au12-owner");
    const product = await seedProduct(producer.id, category.id);
    void product;
    await seedSubOrderForProducer(producer.id, consumer.id, "sent");

    const before = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });

    const res = await request
      .delete(`/api/v1/admin/users/${consumer.id}`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("USER_HAS_ACTIVE_ORDERS");
    expect(res.body.type).toBe("/errors/user-has-active-orders");

    const after = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });
    expect(after.email).toBe(before.email);
    expect(after.deletedAt).toBeNull();
  });

  it("[AU13] successful deletion redacts profile + address, retains id, returns 204", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au13");
    const consumer = await seedConsumer("au13-target", {
      name: "Nombre Visible",
      avatar: "https://example.com/avatar.png",
      emailVerified: true,
    });
    await db.address.create({
      data: {
        userId: consumer.id,
        line1: "Calle Real 1",
        city: "Alicante",
        postalCode: "03001",
        province: "Alicante",
        isDefault: true,
      },
    });
    // account-lifecycle §"Approved tombstone redaction" — every PendingCheckout
    // row for the user MUST receive the same address tombstones.
    await db.pendingCheckout.create({
      data: {
        fingerprint: `au13-fp-${consumer.id}`,
        userId: consumer.id,
        addressLine1: "Calle Real 1",
        addressCity: "Alicante",
        addressPostalCode: "03001",
        addressProvince: "Alicante",
      },
    });

    const res = await request
      .delete(`/api/v1/admin/users/${consumer.id}`)
      .set("X-Test-Auth", adminAuth(admin));

    expect(res.status).toBe(204);

    const row = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBe(`deleted+${consumer.id}@tombstone.invalid`);
    expect(row.name).toBeNull();
    expect(row.avatar).toBeNull();
    expect(row.emailVerified).toBe(false);
    // Retained identifiers.
    expect(row.id).toBe(consumer.id);
    expect(row.auth0Sub).toBeTruthy();

    const addresses = await db.address.findMany({ where: { userId: consumer.id } });
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.isDefault).toBe(false);
    expect(addresses[0]!.deletedAt).not.toBeNull();
    expect(addresses[0]!.line1).toBe("REDACTED");
    expect(addresses[0]!.postalCode).toBe("00000");

    const pendingCheckouts = await db.pendingCheckout.findMany({ where: { userId: consumer.id } });
    expect(pendingCheckouts[0]!.addressLine1).toBe("REDACTED");
    expect(pendingCheckouts[0]!.addressPostalCode).toBe("00000");
  });

  // Spec: account-lifecycle §"Redaction failure is atomic". Forces the
  // Address redaction write (postalCode -> "00000") to fail with a real
  // Postgres CHECK constraint, so the SAME transaction's already-applied
  // User tombstone write MUST also roll back — proving deletion is
  // all-or-nothing, not "unless not real database" faith.
  it("[AU13b] a failed redaction write rolls back the whole deletion, including the User tombstone", async (ctx) => {
    if (!dbReachable) return ctx.skip();
    const admin = await seedAdmin("au13b");
    const consumer = await seedConsumer("au13b-target");
    await db.address.create({
      data: {
        userId: consumer.id,
        line1: "Calle Real 2",
        city: "Alicante",
        postalCode: "03002",
        province: "Alicante",
        isDefault: true,
      },
    });

    // NOT VALID: only newly written/updated rows are checked — pre-existing
    // "00000" rows left by other redaction tests must not block this ALTER.
    await db.$executeRawUnsafe(
      `ALTER TABLE "addresses" ADD CONSTRAINT au13b_block_redaction CHECK (postal_code <> '00000') NOT VALID`,
    );
    try {
      const res = await request
        .delete(`/api/v1/admin/users/${consumer.id}`)
        .set("X-Test-Auth", adminAuth(admin));
      expect(res.status).toBe(500);

      const row = await db.user.findUniqueOrThrow({ where: { id: consumer.id } });
      expect(row.deletedAt).toBeNull();
      expect(row.email).toBe(consumer.email);

      const addresses = await db.address.findMany({ where: { userId: consumer.id } });
      expect(addresses[0]!.postalCode).toBe("03002");
      expect(addresses[0]!.deletedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "addresses" DROP CONSTRAINT au13b_block_redaction`);
    }
  });
});
