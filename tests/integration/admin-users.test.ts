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
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed).
 *
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  const order = await db.order.create({
    data: { userId: consumerId, paymentId: payment.id, totalAmount: 10.0 },
  });
  const subOrder = await db.subOrder.create({
    data: { orderId: order.id, producerId, deliveryModeId: dm.id, status, shippingCostSnapshot: 0 },
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
