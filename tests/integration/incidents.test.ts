/**
 * Integration tests — incidents.service consumer surface (admin-incidents
 * WU2, real Postgres + Supertest).
 *
 * Strategy: real Postgres on localhost:5433 (same disposable test container
 * used by orders.test.ts / payments.test.ts). Does NOT mock prisma —
 * exercises the real `prisma.$transaction`, the real ownership-scoped
 * queries, and real ROLLBACK behavior that unit tests (mocked `tx`) cannot
 * prove.
 *
 * Scenarios covered (incident-management spec, notifications spec §"Transactional
 * incident notifications", error-handling spec §"Incident validation errors"):
 *
 *   [IC1] Eligible owner reports a sub-order -> 201, full detail shape
 *         (snapshot subtotal/lines vs live fulfillmentStatus/trackingNumber
 *         correctly split, per design "Snapshot vs broad joins").
 *   [IC2] Unknown subOrderId -> opaque 404.
 *   [IC3] Unowned subOrderId (another consumer's sub-order) -> opaque 404.
 *   [IC4] Unpaid target (Payment.status != SUCCEEDED) -> opaque 404.
 *   [IC5] Cancelled target (SubOrder.status = cancelled) -> opaque 404.
 *   [IC6] Strict body rejects extra targets/fields, empty reason, missing
 *         subOrderId -> 422 VALIDATION_FAILED, no rejected value echoed.
 *   [IC7] Reporter reads own incidents — list ordered `createdAt DESC, id
 *         DESC`, safe shape only.
 *   [IC8] Reporter reads own incident detail — 200 with full detail shape.
 *   [IC9] Cross-owner detail probe -> opaque 404 (no incident data leaked).
 *   [IC10] Report notifies every non-deleted ADMIN with `INCIDENT_REPORTED`
 *          and no `data`; a deleted ADMIN receives none.
 *   [IC11] A forced notification-write failure rolls back the WHOLE creation
 *          transaction — no Incident row, no notification rows persist.
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed). This prevents silent
 * false-greens. The CI pipeline MUST start the postgres container before
 * running `pnpm test`.
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 *   notifications §"Transactional incident notifications"
 *   error-handling §"Incident validation errors"
 * Design: §"API Contracts", §"Data Flow", §"Architecture Decisions"
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer ONLY — same test double as orders.test.ts /
// cart.test.ts. `@/shared/utils/prisma` is intentionally NOT mocked here —
// incidents.service hits the REAL Postgres test database through the real
// singleton.
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

// Monotonic counter for unique test NIFs — a string-concatenation scheme
// keyed on `namePrefix` (e.g. "ic1" vs "ic10") can collide because
// `.padEnd()` with "0" makes distinct prefixes produce the identical
// padded string ("ic1".padEnd(7,"0") === "ic10".padEnd(7,"0") ===
// "ic10000"). A counter has no such collision risk.
let nifCounter = 90000000;
function nextNif(): string {
  nifCounter += 1;
  return `B${nifCounter}`;
}

async function seedProducer(namePrefix: string, nif: string) {
  const category = await db.category.upsert({
    where: { slug: `test-incidents-${namePrefix}-cat` },
    create: {
      slug: `test-incidents-${namePrefix}-cat`,
      name: `Test Incidents ${namePrefix} Category`,
      isActive: true,
    },
    update: {},
  });
  cleanupCategorySlugs.add(category.slug);

  const producerUser = await db.user.upsert({
    where: { auth0Sub: `test-incidents-${namePrefix}-producer` },
    create: {
      auth0Sub: `test-incidents-${namePrefix}-producer`,
      email: `incidents-${namePrefix}-producer@test.local`,
      role: "PRODUCER",
    },
    update: {},
  });
  cleanupUserIds.push(producerUser.id);

  const producer = await db.producer.upsert({
    where: { userId: producerUser.id },
    create: {
      userId: producerUser.id,
      businessName: `Test Incidents Producer ${namePrefix}`,
      nif,
      description: "Producer for admin-incidents WU2 integration tests",
      addressLine1: "Calle Incidencias 1",
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
    where: { auth0Sub: `test-incidents-${namePrefix}-user` },
    create: {
      auth0Sub: `test-incidents-${namePrefix}-user`,
      email: `incidents-${namePrefix}@test.local`,
      role: "CONSUMER",
    },
    update: {},
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function seedAdmin(namePrefix: string, options?: { deleted?: boolean }) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-incidents-${namePrefix}-admin` },
    create: {
      auth0Sub: `test-incidents-${namePrefix}-admin`,
      email: `incidents-${namePrefix}-admin@test.local`,
      role: "ADMIN",
      deletedAt: options?.deleted ? new Date() : null,
    },
    update: { deletedAt: options?.deleted ? new Date() : null },
  });
  cleanupUserIds.push(user.id);
  return user;
}

/**
 * Seeds one owned, paid, non-cancelled SubOrder + its OrderLine — the
 * baseline eligible target for POST /incidencias. `paymentStatus` and
 * `subOrderStatus` overrides build the ineligible fixtures for [IC4]/[IC5].
 */
async function seedSubOrder(
  namePrefix: string,
  options?: {
    consumer?: Awaited<ReturnType<typeof seedConsumer>>;
    paymentStatus?: "PENDING" | "SUCCEEDED";
    subOrderStatus?: "pending" | "cancelled";
  },
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
    data: { status: options?.paymentStatus ?? "SUCCEEDED", amount: 15.0 },
  });
  const order = await db.order.create({
    data: { userId: consumer.id, paymentId: payment.id, totalAmount: 15.0 },
  });
  const subOrder = await db.subOrder.create({
    data: {
      orderId: order.id,
      producerId: producer.id,
      deliveryModeId: deliveryMode.id,
      status: options?.subOrderStatus ?? "pending",
      shippingCostSnapshot: 2.5,
    },
  });
  const orderLine = await db.orderLine.create({
    data: { subOrderId: subOrder.id, productId: product.id, quantity: 1, unitPriceSnapshot: 12.5 },
  });

  return { producer, category, consumer, deliveryMode, product, payment, order, subOrder, orderLine };
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

    // Incidents are Restrict-FK'd from User/SubOrder/Producer — must be
    // deleted before any of those parent rows.
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
// [IC1] Eligible owner reports a sub-order
// ===========================================================================

describe("POST /api/v1/incidencias — eligible creation [IC1]", () => {
  it(
    "[IC1] creates ONE OPEN incident with the full detail shape (snapshot vs live split)",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const { consumer, subOrder, producer } = await seedSubOrder("ic1");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Package arrived damaged" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: "OPEN",
        reportReason: "Package arrived damaged",
        resolvedAt: null,
        resolution: null,
        target: {
          subOrderId: subOrder.id,
          producerBusinessName: producer.businessName,
          subtotal: "12.50",
          fulfillmentStatus: "pending",
          shippingCost: "2.50",
          trackingNumber: null,
          deliveryModeType: "SHIPPING_FLAT_RATE",
        },
      });
      expect(res.body.target.lines).toEqual([
        { productId: expect.any(String), quantity: 1, unitPrice: "12.50" },
      ]);
      expect(typeof res.body.id).toBe("string");
      expect(typeof res.body.createdAt).toBe("string");
      expect(typeof res.body.updatedAt).toBe("string");

      const persisted = await db.incident.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(persisted.reporterId).toBe(consumer.id);
      expect(persisted.subOrderId).toBe(subOrder.id);
      expect(persisted.producerId).toBe(producer.id);
      expect(persisted.status).toBe("OPEN");
    },
    20000,
  );
});

// ===========================================================================
// [IC2]-[IC5] Ineligible target is opaque
// ===========================================================================

describe("POST /api/v1/incidencias — ineligible target is opaque 404 [IC2-IC5]", () => {
  it(
    "[IC2] unknown subOrderId -> 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const consumer = await seedConsumer("ic2");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: "so_does_not_exist", reason: "Anything" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    },
    20000,
  );

  it(
    "[IC3] unowned subOrderId (another consumer's sub-order) -> 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { subOrder } = await seedSubOrder("ic3owner");
      const otherConsumer = await seedConsumer("ic3prober");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: otherConsumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Not mine but I'll try" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");

      const count = await db.incident.count({ where: { subOrderId: subOrder.id } });
      expect(count).toBe(0);
    },
    20000,
  );

  it(
    "[IC4] unpaid target (Payment.status = PENDING) -> 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer, subOrder } = await seedSubOrder("ic4", { paymentStatus: "PENDING" });

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Unpaid target" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    },
    20000,
  );

  it(
    "[IC5] cancelled target (SubOrder.status = cancelled) -> 404 NOT_FOUND",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer, subOrder } = await seedSubOrder("ic5", { subOrderStatus: "cancelled" });

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Cancelled target" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    },
    20000,
  );
});

// ===========================================================================
// [IC6] Create body rejects extra targets or fields
// ===========================================================================

describe("POST /api/v1/incidencias — strict body validation [IC6]", () => {
  it(
    "[IC6a] unknown field -> 422 VALIDATION_FAILED, no incident created",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer, subOrder } = await seedSubOrder("ic6a");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Valid reason", status: "OPEN" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(res.body)).not.toContain("Valid reason");

      const count = await db.incident.count({ where: { subOrderId: subOrder.id } });
      expect(count).toBe(0);
    },
    20000,
  );

  it(
    "[IC6b] empty reason -> 422 VALIDATION_FAILED",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer, subOrder } = await seedSubOrder("ic6b");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    },
    20000,
  );

  it(
    "[IC6c] missing subOrderId -> 422 VALIDATION_FAILED",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const consumer = await seedConsumer("ic6c");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ reason: "No target given" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    },
    20000,
  );
});

// ===========================================================================
// [IC7]-[IC9] Owner-scoped consumer views
// ===========================================================================

describe("GET /api/v1/incidencias[/:id] — owner-scoped views [IC7-IC9]", () => {
  it(
    "[IC7] reporter reads only their own incidents, ordered createdAt DESC, id DESC",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const consumer = await seedConsumer("ic7");
      const { subOrder: subOrderA } = await seedSubOrder("ic7a", { consumer });
      const { subOrder: subOrderB } = await seedSubOrder("ic7b", { consumer });
      const otherConsumer = await seedConsumer("ic7other");
      const { subOrder: otherSubOrder } = await seedSubOrder("ic7c", { consumer: otherConsumer });

      const incidentA = await db.incident.create({
        data: {
          reporterId: consumer.id,
          subOrderId: subOrderA.id,
          producerId: (await db.subOrder.findUniqueOrThrow({ where: { id: subOrderA.id } })).producerId,
          reportReason: "First report",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const incidentB = await db.incident.create({
        data: {
          reporterId: consumer.id,
          subOrderId: subOrderB.id,
          producerId: (await db.subOrder.findUniqueOrThrow({ where: { id: subOrderB.id } })).producerId,
          reportReason: "Second report",
        },
      });
      await db.incident.create({
        data: {
          reporterId: otherConsumer.id,
          subOrderId: otherSubOrder.id,
          producerId: (await db.subOrder.findUniqueOrThrow({ where: { id: otherSubOrder.id } })).producerId,
          reportReason: "Not the reporter's incident",
        },
      });

      const res = await request
        .get("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // createdAt DESC, id DESC -> the LATER-created incident (B) first.
      expect(res.body[0].id).toBe(incidentB.id);
      expect(res.body[1].id).toBe(incidentA.id);
      expect(res.body.every((i: { target: unknown }) => i.target !== undefined)).toBe(true);
    },
    20000,
  );

  it(
    "[IC8] reporter reads own incident detail -> 200 with full shape",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer, subOrder, producer } = await seedSubOrder("ic8");
      const incident = await db.incident.create({
        data: {
          reporterId: consumer.id,
          subOrderId: subOrder.id,
          producerId: producer.id,
          reportReason: "Detail check",
        },
      });

      const res = await request
        .get(`/api/v1/incidencias/${incident.id}`)
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(incident.id);
      expect(res.body.status).toBe("OPEN");
      expect(res.body.target.subOrderId).toBe(subOrder.id);
      expect(res.body.resolution).toBeNull();
    },
    20000,
  );

  it(
    "[IC9] cross-owner detail probe -> opaque 404, no incident data leaked",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const { consumer: owner, subOrder, producer } = await seedSubOrder("ic9owner");
      const prober = await seedConsumer("ic9prober");
      const incident = await db.incident.create({
        data: {
          reporterId: owner.id,
          subOrderId: subOrder.id,
          producerId: producer.id,
          reportReason: "Owner-only report — must not leak",
        },
      });

      const res = await request
        .get(`/api/v1/incidencias/${incident.id}`)
        .set("X-Test-Auth", authHeader({ sub: prober.auth0Sub }));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("Owner-only report");
    },
    20000,
  );
});

// ===========================================================================
// [IC10] Report notifies current administrators
// ===========================================================================

describe("POST /api/v1/incidencias — ADMIN notification fan-out [IC10]", () => {
  it(
    "[IC10] two non-deleted ADMINs each receive one INCIDENT_REPORTED with no data; the deleted ADMIN receives none",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin1 = await seedAdmin("ic10a");
      const admin2 = await seedAdmin("ic10b");
      const deletedAdmin = await seedAdmin("ic10c", { deleted: true });
      const { consumer, subOrder } = await seedSubOrder("ic10");

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "Notify the admins" });

      expect(res.status).toBe(201);

      const rows = await db.notification.findMany({
        where: { type: "INCIDENT_REPORTED", userId: { in: [admin1.id, admin2.id, deletedAdmin.id] } },
      });

      expect(rows).toHaveLength(2);
      const recipientIds = rows.map((r) => r.userId).sort();
      expect(recipientIds).toEqual([admin1.id, admin2.id].sort());
      for (const row of rows) {
        expect(row.data).toBeNull();
      }
    },
    20000,
  );
});

// ===========================================================================
// [IC11] Transaction failure emits nothing
// ===========================================================================

describe("POST /api/v1/incidencias — forced notification-write failure rolls back everything [IC11]", () => {
  it(
    "[IC11] a thrown error inside the ADMIN notification fan-out rolls back the WHOLE transaction — no Incident row, no notification rows persist",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }
      const admin = await seedAdmin("ic11admin");
      const { consumer, subOrder } = await seedSubOrder("ic11");

      const spy = vi
        .spyOn(notificationsService, "createNotification")
        .mockRejectedValueOnce(new Error("forced notification-write failure"));

      const res = await request
        .post("/api/v1/incidencias")
        .set("X-Test-Auth", authHeader({ sub: consumer.auth0Sub }))
        .send({ subOrderId: subOrder.id, reason: "This must roll back entirely" });

      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalled();

      const incidentCount = await db.incident.count({ where: { subOrderId: subOrder.id } });
      expect(incidentCount).toBe(0);

      // Scoped SPECIFICALLY to this test's own admin fixture — an
      // unambiguous proof that the ADMIN notification write (which the spy
      // caused to throw) never committed, and that the Incident row created
      // moments before it in the SAME transaction rolled back with it.
      const notificationCount = await db.notification.count({
        where: { userId: admin.id, type: "INCIDENT_REPORTED" },
      });
      expect(notificationCount).toBe(0);
    },
    20000,
  );
});
