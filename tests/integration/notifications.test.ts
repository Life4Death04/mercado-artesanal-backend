/**
 * Integration tests — notifications module core CRUD (Cycle 5 notifications
 * WU3, real Postgres), per tasks.md Phase 3 (3.1-3.8, RED).
 *
 * Strategy: real Postgres on localhost:5433 (same test container as
 * orders.test.ts / sub-orders.transitions.test.ts). `@/shared/utils/prisma`
 * is NOT mocked — loadUser, notifications.service, and the guard chain all
 * hit the REAL test database, mirroring orders.test.ts's WU3 (Read Surface)
 * precedent for owner-scoped HTTP reads (real DB is the only way to prove
 * the real `where: { id, userId }` no-leak query against a second real
 * user).
 *
 * Scenarios covered (spec §Requirements, design "Testing Strategy"):
 *
 *   [N1] createNotification persists an unread row; type/payload match input
 *        (spec "Notification Type Contract" §"Generic creator persists a notification")
 *   [N2] incident types (INCIDENT_REPORTED, INCIDENT_RESOLVED) are valid
 *        NotificationType enum values, accepted by createNotification with
 *        no emitting code path elsewhere in this change's scope
 *        (spec §"Incident types are contract-only")
 *   [N3] GET /api/v1/notifications returns ONLY the caller's rows, newest
 *        first (spec "List Own Notifications")
 *   [N4] GET /api/v1/notifications without credentials is rejected (401)
 *        (spec §"Unauthenticated request is rejected")
 *   [N5] GET /api/v1/notifications/unread-count returns 2 for a user with
 *        2 unread + 1 read notification (spec "Unread Count")
 *   [N6] PATCH /api/v1/notifications/:id/read marks the owner's row read
 *        with a read timestamp (spec §"Owner marks their notification as read")
 *   [N7] Repeating the PATCH is idempotent — succeeds, read state unchanged,
 *        no error (spec §"Marking again is idempotent")
 *   [N8a] PATCH on an unknown id returns 404 (spec "Mark Notification As Read")
 *   [N8b] PATCH on another user's id returns 404 (no-leak) and leaves that
 *        row completely untouched (spec §"Cross-user access returns 404")
 *
 * SKIP POLICY: When the database is unreachable, each test calls `ctx.skip()`
 * so Vitest reports it as SKIPPED (not passed) — mirrors orders.test.ts /
 * sub-orders.transitions.test.ts.
 *
 * Spec references:
 *   sdd/notifications/spec — domain "notifications", all 5 requirements
 *   sdd/notifications/design — "notifications module core" file changes,
 *     Testing Strategy row "Integration | List / unread-count / mark-as-read
 *     owner-scoped, 404 no-leak, idempotent read | Mirror orders/sub-orders
 *     test shape"
 */
import { PrismaClient } from "@prisma/client";
import supertest from "supertest";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer ONLY — same test double as orders.test.ts /
// cart.test.ts / addresses.test.ts. `@/shared/utils/prisma` is intentionally
// NOT mocked here — loadUser and notifications.service both hit the REAL
// Postgres test database through the real singleton.
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
// Cleanup registry — collected across tests, torn down in afterAll.
// ---------------------------------------------------------------------------
const cleanupUserIds: string[] = [];

async function seedConsumer(namePrefix: string) {
  const user = await db.user.upsert({
    where: { auth0Sub: `test-notif-${namePrefix}-user` },
    create: {
      auth0Sub: `test-notif-${namePrefix}-user`,
      email: `notif-${namePrefix}@test.local`,
      role: "CONSUMER",
    },
    update: {},
  });
  cleanupUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (dbReachable) {
    await db.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await db.$disconnect();
  await prisma.$disconnect();
});

beforeAll(async () => {
  dbReachable = await isDbReachable();
});

// ===========================================================================
// [N1] createNotification persists an unread row; type/payload match
// ===========================================================================

describe("createNotification — persists an unread row [N1]", () => {
  it(
    "[N1] writes a Notification row (unread by default), type and payload match input, and returns a PendingEmail",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const consumer = await seedConsumer("n1");

      const pendingEmail = await prisma.$transaction((tx) =>
        notificationsService.createNotification(tx, {
          userId: consumer.id,
          type: "PAYMENT_CONFIRMED",
          data: { orderId: "order_n1_fixture" },
          toEmail: consumer.email,
        }),
      );

      expect(pendingEmail.to).toBe(consumer.email);
      expect(pendingEmail.subject.length).toBeGreaterThan(0);
      expect(pendingEmail.body.length).toBeGreaterThan(0);

      const rows = await db.notification.findMany({ where: { userId: consumer.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("PAYMENT_CONFIRMED");
      expect(rows[0]!.read).toBe(false);
      expect(rows[0]!.readAt).toBeNull();
      expect(rows[0]!.data).toMatchObject({ orderId: "order_n1_fixture" });
    },
  );
});

// ===========================================================================
// [N2] Incident types are valid enum values, contract-only
// ===========================================================================

describe("createNotification — incident types are contract-only [N2]", () => {
  it(
    "[N2] INCIDENT_REPORTED and INCIDENT_RESOLVED are accepted by createNotification as valid NotificationType values",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const consumer = await seedConsumer("n2");

      await prisma.$transaction((tx) =>
        notificationsService.createNotification(tx, {
          userId: consumer.id,
          type: "INCIDENT_REPORTED",
          toEmail: consumer.email,
        }),
      );
      await prisma.$transaction((tx) =>
        notificationsService.createNotification(tx, {
          userId: consumer.id,
          type: "INCIDENT_RESOLVED",
          toEmail: consumer.email,
        }),
      );

      const rows = await db.notification.findMany({
        where: { userId: consumer.id },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => r.type)).toEqual(["INCIDENT_REPORTED", "INCIDENT_RESOLVED"]);
    },
  );
});

// ===========================================================================
// [N3][N4] GET /api/v1/notifications — owner-scoped list, newest first, 401
// ===========================================================================

describe("GET /api/v1/notifications — owner-scoped list [N3][N4]", () => {
  it(
    "[N3] returns ONLY the caller's notifications, newest first — a stranger's notification never leaks in",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const owner = await seedConsumer("n3-owner");
      const stranger = await seedConsumer("n3-stranger");

      const older = await db.notification.create({
        data: { userId: owner.id, type: "PAYMENT_CONFIRMED", title: "t1", body: "b1" },
      });
      // Ensure a distinct createdAt ordering (millisecond-granularity clock).
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await db.notification.create({
        data: { userId: owner.id, type: "ORDER_CREATED", title: "t2", body: "b2" },
      });
      await db.notification.create({
        data: { userId: stranger.id, type: "PAYMENT_CONFIRMED", title: "t3", body: "b3" },
      });

      const res = await request
        .get("/api/v1/notifications")
        .set("x-test-auth", authHeader({ sub: owner.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const ids = (res.body as Array<{ id: string }>).map((n) => n.id);
      expect(ids[0]).toBe(newer.id);
      expect(ids[1]).toBe(older.id);
      expect(ids).not.toContain(
        (await db.notification.findFirst({ where: { userId: stranger.id } }))!.id,
      );
    },
  );

  it("[N4] rejects an unauthenticated request (401, not 200)", async (ctx) => {
    if (!dbReachable) {
      ctx.skip();
      return;
    }

    const res = await request.get("/api/v1/notifications");

    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// [N5] GET /api/v1/notifications/unread-count — owner-scoped count
// ===========================================================================

describe("GET /api/v1/notifications/unread-count — owner-scoped count [N5]", () => {
  it(
    "[N5] returns 2 for a user with 2 unread and 1 read notification",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const consumer = await seedConsumer("n5");

      await db.notification.create({
        data: { userId: consumer.id, type: "PAYMENT_CONFIRMED", title: "t1", body: "b1" },
      });
      await db.notification.create({
        data: { userId: consumer.id, type: "ORDER_CREATED", title: "t2", body: "b2" },
      });
      await db.notification.create({
        data: {
          userId: consumer.id,
          type: "SUBORDER_STATUS_CHANGED",
          title: "t3",
          body: "b3",
          read: true,
          readAt: new Date(),
        },
      });

      const res = await request
        .get("/api/v1/notifications/unread-count")
        .set("x-test-auth", authHeader({ sub: consumer.auth0Sub }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ count: 2 });
    },
  );
});

// ===========================================================================
// [N6][N7] PATCH /api/v1/notifications/:id/read — mark read, idempotent
// ===========================================================================

describe("PATCH /api/v1/notifications/:id/read — mark read, idempotent [N6][N7]", () => {
  it(
    "[N6][N7] marks the owner's notification read with a timestamp; a repeat PATCH is idempotent and leaves state unchanged",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const consumer = await seedConsumer("n6");
      const notification = await db.notification.create({
        data: { userId: consumer.id, type: "PAYMENT_CONFIRMED", title: "t1", body: "b1" },
      });

      // [N6] first PATCH: unread -> read, readAt populated.
      const firstRes = await request
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set("x-test-auth", authHeader({ sub: consumer.auth0Sub }));

      expect(firstRes.status).toBe(200);
      expect(firstRes.body).toMatchObject({ id: notification.id, read: true });
      expect(firstRes.body.readAt).not.toBeNull();

      const afterFirst = await db.notification.findUniqueOrThrow({ where: { id: notification.id } });
      expect(afterFirst.read).toBe(true);
      expect(afterFirst.readAt).not.toBeNull();

      // [N7] second PATCH: idempotent no-op — succeeds, read state unchanged.
      const secondRes = await request
        .patch(`/api/v1/notifications/${notification.id}/read`)
        .set("x-test-auth", authHeader({ sub: consumer.auth0Sub }));

      expect(secondRes.status).toBe(200);
      expect(secondRes.body).toMatchObject({ id: notification.id, read: true });

      const afterSecond = await db.notification.findUniqueOrThrow({ where: { id: notification.id } });
      expect(afterSecond.read).toBe(true);
      expect(afterSecond.readAt?.toISOString()).toBe(afterFirst.readAt?.toISOString());
    },
  );
});

// ===========================================================================
// [N8a][N8b] PATCH /api/v1/notifications/:id/read — 404 no-leak
// ===========================================================================

describe("PATCH /api/v1/notifications/:id/read — 404 no-leak [N8a][N8b]", () => {
  it("[N8a] an unknown id returns 404", async (ctx) => {
    if (!dbReachable) {
      ctx.skip();
      return;
    }

    const consumer = await seedConsumer("n8a");

    const res = await request
      .patch("/api/v1/notifications/nonexistent-id-000/read")
      .set("x-test-auth", authHeader({ sub: consumer.auth0Sub }));

    expect(res.status).toBe(404);
  });

  it(
    "[N8b] another user's notification id returns 404 (no-leak) and the other user's row is left completely untouched",
    async (ctx) => {
      if (!dbReachable) {
        ctx.skip();
        return;
      }

      const owner = await seedConsumer("n8b-owner");
      const intruder = await seedConsumer("n8b-intruder");
      const ownerNotification = await db.notification.create({
        data: { userId: owner.id, type: "PAYMENT_CONFIRMED", title: "t1", body: "b1" },
      });

      const res = await request
        .patch(`/api/v1/notifications/${ownerNotification.id}/read`)
        .set("x-test-auth", authHeader({ sub: intruder.auth0Sub }));

      expect(res.status).toBe(404);

      const untouched = await db.notification.findUniqueOrThrow({
        where: { id: ownerNotification.id },
      });
      expect(untouched.read).toBe(false);
      expect(untouched.readAt).toBeNull();
      expect(untouched.updatedAt.toISOString()).toBe(ownerNotification.updatedAt.toISOString());
    },
  );
});
