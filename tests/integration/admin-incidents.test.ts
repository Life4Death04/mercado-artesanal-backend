/**
 * Integration tests — admin-incidents.service ADMIN triage/resolution
 * surface (admin-incidents WU3, real Postgres + Supertest).
 *
 * Strategy: real Postgres on localhost:5433 (same disposable test container
 * used by incidents.test.ts / orders.test.ts / payments.test.ts). Does NOT
 * mock prisma — exercises the real `prisma.$transaction`, the real
 * conditional `updateMany` claim, and real concurrent-race behavior that
 * unit tests (mocked `tx`) cannot prove.
 *
 * Scenarios covered (incident-management spec, notifications spec
 * §"Transactional incident notifications", error-handling spec §"Safe
 * incident resolution conflict"):
 *
 *   [AI1-AI4]  RBAC: missing JWT -> 401; CONSUMER/PRODUCER -> 403;
 *              PENDING_ROLE -> 403; ADMIN reaches the inbox -> 200.
 *   [AI5-AI8]  Pagination: defaults return page 1/limit 20 unfiltered
 *              all-status inbox; `createdAt DESC, id DESC` order; boundary
 *              values accepted; `page=0`/`limit=0`/`limit=101`/fraction/
 *              unknown filter key -> 422, no mutation.
 *   [AI9-AI11] Safe detail: snapshot vs live split, reporter name/email
 *              allowlist (both `name` set and `firstName`/`lastName`
 *              fallback), unknown id -> 404.
 *   [AI12-AI13] First resolution: audit recorded, no commercial side
 *              effects (payment/subOrder/product/stock unchanged).
 *   [AI14]     Reporter-only INCIDENT_RESOLVED notification, no `data`,
 *              no notification to other admins.
 *   [AI15]     Repeated resolution on an already-resolved incident -> 409
 *              INCIDENT_ALREADY_RESOLVED, first audit unchanged.
 *   [AI16]     True concurrent resolution — two ADMIN requests race the
 *              SAME OPEN incident: exactly one 200 + one 409, persisted
 *              audit matches only the winner.
 *   [AI17]     Unknown id resolve -> 404.
 *   [AI18]     Invalid resolve body (empty reason / unknown field) -> 422.
 *   [AI19]     A forced notification-write failure rolls back the WHOLE
 *              resolution transaction — status remains OPEN, no audit, no
 *              notification row persists.
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent
 * false-greens. The CI pipeline MUST start the postgres container before
 * running `pnpm test`.
 *
 * Spec references:
 *   incident-management §"ADMIN inbox pagination"
 *   incident-management §"Safe ADMIN detail"
 *   incident-management §"Final conditional resolution"
 *   incident-management §"Scope exclusions"
 *   notifications §"Transactional incident notifications"
 *   error-handling §"Safe incident resolution conflict"
 * Design: §"API Contracts", §"Transactions, Errors, and Testing"
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer ONLY — same test double as incidents.test.ts.
// `@/shared/utils/prisma` is intentionally NOT mocked here — admin-incidents
// hits the REAL Postgres test database through the real singleton.
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
// Cleanup registries — collected across tests, torn down in afterAll.
// ---------------------------------------------------------------------------
const cleanupUserIds: string[] = [];
const cleanupProducerIds: string[] = [];
const cleanupCategorySlugs = new Set<string>();

let nifCounter = 95000000;
function nextNif(): string {
  nifCounter += 1;
  return `B${nifCounter}`;
}

async function seedProducer(namePrefix: string, nif: string) {
  const category = await db.category.upsert({
    where: { slug: `test-admin-incidents-${namePrefix}-cat` },
    create: {
      slug: `test-admin-incidents-${namePrefix}-cat`,
      name: `Test Admin Incidents ${namePrefix} Category`,
      isActive: true,
    },
    update: {},
  });
  cleanupCategorySlugs.add(category.slug);

  const producerUser = await db.user.upsert({
    where: { auth0Sub: `test-admin-incidents-${namePrefix}-producer` },
    create: {
      auth0Sub: `test-admin-incidents-${namePrefix}-producer`,
      email: `admin-incidents-${namePrefix}-producer@test.local`,
      role: "PRODUCER",
    },
    update: {},
  });
  cleanupUserIds.push(producerUser.id);

  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: `Test Admin Incidents Producer ${namePrefix}`,
      nif,
      description: "Producer for admin-incidents WU3 integration tests",
      addressLine1: "Calle Incidencias Admin 1",
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
    },
    update: {},
  });
  cleanupProducerIds.push(producer.id);

  return { category, producer };
}

async function seedConsumer(
  namePrefix: string,
  options?: { name?: string | null; firstName?: string | null; lastName?: string | null },
) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-admin-incidents-${namePrefix}-user` },
    create: {
      auth0Sub: `test-admin-incidents-${namePrefix}-user`,
      email: `admin-incidents-${namePrefix}@test.local`,
      role: "CONSUMER",
      name: options?.name,
      firstName: options?.firstName,
      lastName: options?.lastName,
    },
    update: {
      name: options?.name,
      firstName: options?.firstName,
      lastName: options?.lastName,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedRoleUser(namePrefix: string, role: "PRODUCER" | "PENDING_ROLE") {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-admin-incidents-${namePrefix}-role` },
    create: {
      auth0Sub: `test-admin-incidents-${namePrefix}-role`,
      email: `admin-incidents-${namePrefix}-role@test.local`,
      role,
    },
    update: { role },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedAdmin(namePrefix: string) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-admin-incidents-${namePrefix}-admin` },
    create: {
      auth0Sub: `test-admin-incidents-${namePrefix}-admin`,
      email: `admin-incidents-${namePrefix}-admin@test.local`,
      role: "ADMIN",
    },
    update: {},
  });
  cleanupUserIds.push(user.id);
  return user;
}

/** Seeds one owned, paid, non-cancelled SubOrder + its OrderLine. */
async function seedSubOrder(
  namePrefix: string,
  options?: { consumer?: Awaited<ReturnType<typeof seedConsumer>> },
) {
  const { producer, category } = await seedProducer(namePrefix, nextNif());
  const consumer = options?.consumer ?? (await seedConsumer(namePrefix));

  const deliveryMode = await db.deliveryMode.create({
    data: { producerId: producer.id, type: "SHIPPING_FLAT_RATE", cost: 2.5, isActive: true },
  });
  const product = await db.product.create({
    data: {
      producerId: producer.id,
      categoryId: category.id,
      name: `${namePrefix.toUpperCase()} Product`,
      description: "d",
      price: 12.5,
      stock: 10,
      isActive: true,
    },
  });

  const payment = await db.payment.create({
    data: { status: "SUCCEEDED", amount: 15.0 },
  });
  const order = await db.order.create({
    data: { userId: consumer.id, paymentId: payment.id, totalAmount: 15.0 },
  });
  const subOrder = await db.subOrder.create({
    data: {
      orderId: order.id,
      producerId: producer.id,
      deliveryModeId: deliveryMode.id,
      status: "pending",
      shippingCostSnapshot: 2.5,
    },
  });
  const orderLine = await db.orderLine.create({
    data: { subOrderId: subOrder.id, productId: product.id, quantity: 1, unitPriceSnapshot: 12.5 },
  });

  return { producer, category, consumer, deliveryMode, product, payment, order, subOrder, orderLine };
}

async function seedIncident(
  reporterId: string,
  subOrderId: string,
  producerId: string,
  reportReason: string,
  overrides?: {
    status?: "OPEN" | "RESOLVED";
    resolvedById?: string;
    resolutionReason?: string;
    resolvedAt?: Date;
  },
) {
  return db.incident.create({
    data: {
      reporterId,
      subOrderId,
      producerId,
      reportReason,
      status: overrides?.status ?? "OPEN",
      resolvedById: overrides?.resolvedById,
      resolutionReason: overrides?.resolutionReason,
      resolvedAt: overrides?.resolvedAt,
    },
  });
}

/** FK-safe deletion of every Incident row created against our test fixtures. */
async function deleteIncidentsFor(subOrderIds: string[], reporterIds: string[]): Promise<void> {
  await db.incident.deleteMany({
    where: { OR: [{ subOrderId: { in: subOrderIds } }, { reporterId: { in: reporterIds } }] },
  });
}

afterAll(async () => {
  if (dbReachable) {
    const orders = await db.order.findMany({ where: { userId: { in: cleanupUserIds } } });
    const orderIds = orders.map((o) => o.id);
    const paymentIds = orders.map((o) => o.paymentId);
    const subOrders = await db.subOrder.findMany({ where: { orderId: { in: orderIds } } });
    const subOrderIds = subOrders.map((s) => s.id);

    await deleteIncidentsFor(subOrderIds, cleanupUserIds);

    await db.orderLine.deleteMany({ where: { subOrderId: { in: subOrderIds } } });
    await db.subOrder.deleteMany({ where: { id: { in: subOrderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// [AI1-AI4] RBAC / wire routing — reuses adminRouter's centralized guard
// ===========================================================================

describe("Admin incidents RBAC — /api/v1/admin/incidents", () => {
  it(
    "[AI1] missing JWT returns 401",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const res = await request.get("/api/v1/admin/incidents");
      expect(res.status).toBe(401);
    },
    20000,
  );

  it(
    "[AI2] CONSUMER returns 403 FORBIDDEN",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const consumer = await seedConsumer("ai2");

      const res = await request
        .get("/api/v1/admin/incidents")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    },
    20000,
  );

  it(
    "[AI3] PENDING_ROLE returns 403 FORBIDDEN",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const pending = await seedRoleUser("ai3", "PENDING_ROLE");

      const res = await request
        .get("/api/v1/admin/incidents")
        .set("X-Test-Auth", authHeader({ sub: pending.auth0Sub }));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    },
    20000,
  );

  it(
    "[AI4] ADMIN reaches the inbox -> 200",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai4");

      const res = await request
        .get("/api/v1/admin/incidents")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 20 });
      expect(Array.isArray(res.body.items)).toBe(true);
    },
    20000,
  );
});

// ===========================================================================
// [AI5-AI8] ADMIN inbox pagination — all statuses, no filters
// ===========================================================================

describe("GET /api/v1/admin/incidents — pagination [AI5-AI8]", () => {
  it(
    "[AI5] defaults return page 1/limit 20, includes BOTH OPEN and RESOLVED incidents unfiltered",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai5");
      const { consumer, subOrder, producer } = await seedSubOrder("ai5open");
      const openIncident = await seedIncident(consumer.id, subOrder.id, producer.id, "Open one");
      const { consumer: consumer2, subOrder: subOrder2, producer: producer2 } =
        await seedSubOrder("ai5resolved");
      const resolvedIncident = await seedIncident(
        consumer2.id,
        subOrder2.id,
        producer2.id,
        "Resolved one",
        {
          status: "RESOLVED",
          resolvedById: admin.id,
          resolutionReason: "Handled",
          resolvedAt: new Date(),
        },
      );

      const res = await request
        .get("/api/v1/admin/incidents")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(20);
      expect(res.body.items.length).toBeLessThanOrEqual(20);
      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(openIncident.id);
      expect(ids).toContain(resolvedIncident.id);
    },
    20000,
  );

  it(
    "[AI6] ordered createdAt DESC, id DESC — limit=2 returns the two MOST RECENT first",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai6");
      const { consumer: c1, subOrder: s1, producer: p1 } = await seedSubOrder("ai6a");
      const i1 = await seedIncident(c1.id, s1.id, p1.id, "First");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { consumer: c2, subOrder: s2, producer: p2 } = await seedSubOrder("ai6b");
      const i2 = await seedIncident(c2.id, s2.id, p2.id, "Second");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { consumer: c3, subOrder: s3, producer: p3 } = await seedSubOrder("ai6c");
      const i3 = await seedIncident(c3.id, s3.id, p3.id, "Third");

      const res = await request
        .get("/api/v1/admin/incidents?page=1&limit=2")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].id).toBe(i3.id);
      expect(res.body.items[1].id).toBe(i2.id);
      expect(res.body.items.map((it: { id: string }) => it.id)).not.toContain(i1.id);
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      expect(res.body.totalPages).toBeGreaterThanOrEqual(Math.ceil(res.body.total / 2));
    },
    20000,
  );

  it(
    "[AI7] boundary pagination values (page=1, limit=1) are accepted",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai7");
      const { consumer, subOrder, producer } = await seedSubOrder("ai7");
      await seedIncident(consumer.id, subOrder.id, producer.id, "Boundary check");

      const res = await request
        .get("/api/v1/admin/incidents?page=1&limit=1")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    },
    20000,
  );

  it(
    "[AI8] page=0, limit=0, limit=101, fractional page, and an unknown filter key all return 422 VALIDATION_FAILED",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai8");
      const header = authHeader({ sub: admin.auth0Sub });

      const zeroPage = await request.get("/api/v1/admin/incidents?page=0").set("X-Test-Auth", header);
      expect(zeroPage.status).toBe(422);
      expect(zeroPage.body.code).toBe("VALIDATION_FAILED");

      const zeroLimit = await request
        .get("/api/v1/admin/incidents?limit=0")
        .set("X-Test-Auth", header);
      expect(zeroLimit.status).toBe(422);

      const overLimit = await request
        .get("/api/v1/admin/incidents?limit=101")
        .set("X-Test-Auth", header);
      expect(overLimit.status).toBe(422);

      const fractionalPage = await request
        .get("/api/v1/admin/incidents?page=1.5")
        .set("X-Test-Auth", header);
      expect(fractionalPage.status).toBe(422);

      const unknownFilter = await request
        .get("/api/v1/admin/incidents?status=OPEN")
        .set("X-Test-Auth", header);
      expect(unknownFilter.status).toBe(422);
      expect(unknownFilter.body.code).toBe("VALIDATION_FAILED");
    },
    20000,
  );
});

// ===========================================================================
// [AI9-AI11] Safe ADMIN detail
// ===========================================================================

describe("GET /api/v1/admin/incidents/:id — safe detail [AI9-AI11]", () => {
  it(
    "[AI9] detail separates historical snapshot from live fulfillment/tracking, and allowlists reporter name/email",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai9");
      const consumer = await seedConsumer("ai9", { name: "Ana García" });
      const { subOrder, producer } = await seedSubOrder("ai9", { consumer });
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Detail check");

      // Fulfillment changed post-purchase — a LIVE field, distinct from the
      // frozen commercial snapshot (shippingCostSnapshot / orderLine.unitPriceSnapshot).
      await db.subOrder.update({
        where: { id: subOrder.id },
        data: { status: "sent", trackingNumber: "TRACK123" },
      });

      const res = await request
        .get(`/api/v1/admin/incidents/${incident.id}`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.reporter).toEqual({ name: "Ana García", email: consumer.email });
      expect(res.body.target.fulfillmentStatus).toBe("sent");
      expect(res.body.target.trackingNumber).toBe("TRACK123");
      // Snapshot fields remain the ORIGINAL purchase-time values.
      expect(res.body.target.subtotal).toBe("12.50");
      expect(res.body.target.shippingCost).toBe("2.50");
      expect(res.body.target.lines).toEqual([
        { productId: expect.any(String), quantity: 1, unitPrice: "12.50" },
      ]);
      // No protected fields leak.
      expect(res.body).not.toHaveProperty("auth0Sub");
      expect(JSON.stringify(res.body)).not.toContain("addressLine1");
    },
    20000,
  );

  it(
    "[AI10] reporter name falls back to joined firstName/lastName when `name` is null",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai10");
      const consumer = await seedConsumer("ai10", {
        name: null,
        firstName: "Luis",
        lastName: "Pérez",
      });
      const { subOrder, producer } = await seedSubOrder("ai10", { consumer });
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Name fallback");

      const res = await request
        .get(`/api/v1/admin/incidents/${incident.id}`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.reporter.name).toBe("Luis Pérez");
    },
    20000,
  );

  it(
    "[AI11] unknown incident id returns 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai11");

      const res = await request
        .get("/api/v1/admin/incidents/incident_does_not_exist")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    },
    20000,
  );
});

// ===========================================================================
// [AI12-AI14] Final conditional resolution — first success
// ===========================================================================

describe("PATCH /api/v1/admin/incidents/:id/resolve — first resolution [AI12-AI14]", () => {
  it(
    "[AI12] resolves an OPEN incident, records audit (resolver, reason, timestamp), preserves report data",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai12");
      const { consumer, subOrder, producer } = await seedSubOrder("ai12");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Needs resolution");

      const res = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "Refund issued outside this system" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("RESOLVED");
      expect(res.body.reportReason).toBe("Needs resolution");
      expect(res.body.resolution).toEqual({
        reason: "Refund issued outside this system",
        resolvedAt: expect.any(String),
        resolvedById: admin.id,
      });

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(persisted.status).toBe("RESOLVED");
      expect(persisted.resolvedById).toBe(admin.id);
      expect(persisted.resolutionReason).toBe("Refund issued outside this system");
      expect(persisted.resolvedAt).not.toBeNull();
    },
    20000,
  );

  it(
    "[AI13] resolution has no commercial/fulfillment side effect (payment, subOrder status, product stock unchanged)",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai13");
      const { consumer, subOrder, producer, payment, product } = await seedSubOrder("ai13");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "No side effects");

      const beforeSubOrder = await db.subOrder.findUniqueOrThrow({ where: { id: subOrder.id } });
      const beforePayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const beforeProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });

      const res = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "Resolved without touching commerce state" });

      expect(res.status).toBe(200);

      const afterSubOrder = await db.subOrder.findUniqueOrThrow({ where: { id: subOrder.id } });
      const afterPayment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const afterProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } });

      expect(afterSubOrder.status).toBe(beforeSubOrder.status);
      expect(afterSubOrder.trackingNumber).toBe(beforeSubOrder.trackingNumber);
      expect(afterPayment.status).toBe(beforePayment.status);
      expect(afterProduct.stock).toBe(beforeProduct.stock);
    },
    20000,
  );

  it(
    "[AI14] resolution notifies ONLY the reporter with INCIDENT_RESOLVED and no data; other admins receive nothing",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai14");
      const otherAdmin = await seedAdmin("ai14other");
      const { consumer, subOrder, producer } = await seedSubOrder("ai14");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Notify reporter only");

      const res = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "Reporter should be notified" });

      expect(res.status).toBe(200);

      const reporterNotifications = await db.notification.findMany({
        where: { userId: consumer.id, type: "INCIDENT_RESOLVED" },
      });
      expect(reporterNotifications).toHaveLength(1);
      expect(reporterNotifications[0]?.data).toBeNull();

      const otherAdminNotifications = await db.notification.findMany({
        where: { userId: otherAdmin.id, type: "INCIDENT_RESOLVED" },
      });
      expect(otherAdminNotifications).toHaveLength(0);

      const adminNotifications = await db.notification.findMany({
        where: { userId: admin.id, type: "INCIDENT_RESOLVED" },
      });
      expect(adminNotifications).toHaveLength(0);
    },
    20000,
  );
});

// ===========================================================================
// [AI15-AI18] Conflict / concurrency / validation
// ===========================================================================

describe("PATCH /api/v1/admin/incidents/:id/resolve — conflict and races [AI15-AI18]", () => {
  it(
    "[AI15] repeated resolution on an already-resolved incident returns 409 INCIDENT_ALREADY_RESOLVED, first audit unchanged",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai15");
      const secondAdmin = await seedAdmin("ai15second");
      const { consumer, subOrder, producer } = await seedSubOrder("ai15");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Repeat check");

      const first = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "First resolver wins" });
      expect(first.status).toBe(200);

      const second = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: secondAdmin.auth0Sub }))
        .send({ reason: "This must be rejected" });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe("INCIDENT_ALREADY_RESOLVED");
      expect(JSON.stringify(second.body)).not.toContain("First resolver wins");
      expect(JSON.stringify(second.body)).not.toContain(consumer.email);

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(persisted.resolvedById).toBe(admin.id);
      expect(persisted.resolutionReason).toBe("First resolver wins");
    },
    20000,
  );

  it(
    "[AI16] true concurrent resolution — exactly one 200 and one 409; persisted audit matches only the winner",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const adminA = await seedAdmin("ai16a");
      const adminB = await seedAdmin("ai16b");
      const { consumer, subOrder, producer } = await seedSubOrder("ai16");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Race check");

      const [resA, resB] = await Promise.all([
        request
          .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
          .set("X-Test-Auth", authHeader({ sub: adminA.auth0Sub }))
          .send({ reason: "Admin A racing" }),
        request
          .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
          .set("X-Test-Auth", authHeader({ sub: adminB.auth0Sub }))
          .send({ reason: "Admin B racing" }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const winner = resA.status === 200 ? resA : resB;
      const loser = resA.status === 200 ? resB : resA;
      expect(loser.body.code).toBe("INCIDENT_ALREADY_RESOLVED");

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(persisted.status).toBe("RESOLVED");
      expect(persisted.resolvedById).toBe(winner.body.resolution.resolvedById);
      expect(persisted.resolutionReason).toBe(winner.body.resolution.reason);

      // Exactly ONE notification was written — the loser rolled back cleanly.
      const notifications = await db.notification.findMany({
        where: { userId: consumer.id, type: "INCIDENT_RESOLVED" },
      });
      expect(notifications).toHaveLength(1);
    },
    20000,
  );

  it(
    "[AI17] unknown incident id resolve returns 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai17");

      const res = await request
        .patch("/api/v1/admin/incidents/incident_does_not_exist/resolve")
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "Doesn't matter" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    },
    20000,
  );

  it(
    "[AI18] empty reason and an unknown body field both return 422 VALIDATION_FAILED, no mutation",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai18");
      const { consumer, subOrder, producer } = await seedSubOrder("ai18");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Validation check");

      const emptyReason = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "" });
      expect(emptyReason.status).toBe(422);
      expect(emptyReason.body.code).toBe("VALIDATION_FAILED");

      const unknownField = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "Valid reason", status: "RESOLVED" });
      expect(unknownField.status).toBe(422);
      expect(unknownField.body.code).toBe("VALIDATION_FAILED");

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(persisted.status).toBe("OPEN");
    },
    20000,
  );
});

// ===========================================================================
// [AI19] Transaction failure emits nothing
// ===========================================================================

describe("PATCH /api/v1/admin/incidents/:id/resolve — forced notification-write failure rolls back everything [AI19]", () => {
  it(
    "[AI19] a thrown error inside the reporter notification write rolls back the WHOLE transaction — status remains OPEN, no audit, no notification row persists",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ai19");
      const { consumer, subOrder, producer } = await seedSubOrder("ai19");
      const incident = await seedIncident(consumer.id, subOrder.id, producer.id, "Must roll back");

      const spy = vi
        .spyOn(notificationsService, "createNotification")
        .mockRejectedValueOnce(new Error("forced notification-write failure"));

      const res = await request
        .patch(`/api/v1/admin/incidents/${incident.id}/resolve`)
        .set("X-Test-Auth", authHeader({ sub: admin.auth0Sub }))
        .send({ reason: "This must roll back entirely" });

      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalled();

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(persisted.status).toBe("OPEN");
      expect(persisted.resolvedById).toBeNull();
      expect(persisted.resolutionReason).toBeNull();
      expect(persisted.resolvedAt).toBeNull();

      const notificationCount = await db.notification.count({
        where: { userId: consumer.id, type: "INCIDENT_RESOLVED" },
      });
      expect(notificationCount).toBe(0);
    },
    20000,
  );
});
