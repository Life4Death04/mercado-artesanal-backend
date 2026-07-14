/**
 * Integration tests — sub-orders read endpoints (Slice 8, Commit A RED).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; sub-order operations call
 *     `prisma.subOrder.findMany`, `prisma.subOrder.findFirst`.
 *
 * Scenarios covered (specs: order-fulfillment):
 *   [SO-R1]  GET /producers/me/sub-orders               — 200 list own SubOrders
 *   [SO-R2]  GET /producers/me/sub-orders?status=sent   — 200 filter by status
 *   [SO-R3]  GET /producers/me/sub-orders               — 200 empty array when none owned
 *   [SO-R4]  GET /producers/me/sub-orders/:id           — 200 get own SubOrder with lines
 *   [SO-R5]  GET /producers/me/sub-orders/:id           — 404 cross-producer read (no-leak)
 *   [SO-R-unauth] GET /producers/me/sub-orders          — 401 unauthenticated
 *
 * Spec references:
 *   order-fulfillment §"Producer read of own SubOrders"
 *   order-fulfillment scenario "Filter by status"
 *   order-fulfillment scenario "Cross-producer read returns 404"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as delivery-modes.test.ts
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

// ---------------------------------------------------------------------------
// Mock: prisma singleton
// loadUser calls prisma.user.findUnique.
// sub-order read operations call prisma.subOrder.findMany and prisma.subOrder.findFirst.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
      subOrder: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

import type { SubOrderStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedSubOrder = mockedPrisma.subOrder as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function makeProducerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "cuid_user_001",
    role: "PRODUCER",
    email: "producer@example.com",
    producerId: "prod_001",
    ...overrides,
  };
}

function makeSubOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "so_001",
    orderId: "order_001",
    producerId: "prod_001",
    deliveryModeId: "dm_001",
    status: "pending" as SubOrderStatus,
    shippingCostSnapshot: new Decimal("5.00"),
    trackingNumber: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    orderLines: [],
    ...overrides,
  };
}

/**
 * Configure prisma.user.findUnique to return a user projection for loadUser.
 * PRODUCER role also returns a producer relation for producerId.
 */
function mockLoadUser(user: ReturnType<typeof makeProducerUser> | null): void {
  if (!user) {
    mockedUser.findUnique.mockResolvedValueOnce(null);
    return;
  }
  mockedUser.findUnique.mockResolvedValueOnce({
    id: user.id,
    role: user.role,
    email: user.email,
    producer: user.producerId ? { id: user.producerId } : null,
  });
}

// ---------------------------------------------------------------------------
// App + request
// ---------------------------------------------------------------------------

const app = createApp();
const request = supertest(app);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// GET /api/v1/producers/me/sub-orders
// ===========================================================================

describe("GET /api/v1/producers/me/sub-orders — list own SubOrders", () => {
  it("[SO-R1] returns 200 with array of own SubOrders", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const so = makeSubOrder();

    mockLoadUser(user);
    mockedSubOrder.findMany.mockResolvedValueOnce([so]);

    const res = await request
      .get("/api/v1/producers/me/sub-orders")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(so.id);
    expect(res.body[0].producerId).toBe("prod_001");
  });

  it("[SO-R2] returns 200 with only SubOrders matching status filter", async () => {
    // Spec: order-fulfillment scenario "Filter by status"
    // P1 calls GET /producers/me/sub-orders?status=sent → only sent SubOrders returned.
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const sentOrder = makeSubOrder({ id: "so_002", status: "sent" as SubOrderStatus });

    mockLoadUser(user);
    // Service layer filters by status; mock returns only the matching row.
    mockedSubOrder.findMany.mockResolvedValueOnce([sentOrder]);

    const res = await request
      .get("/api/v1/producers/me/sub-orders?status=sent")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("so_002");
    expect(res.body[0].status).toBe("sent");
  });

  it("[SO-R3] returns 200 with empty array when producer owns no SubOrders", async () => {
    const sub = "auth0|producer002";
    const user = makeProducerUser({ id: "cuid_user_002", auth0Sub: sub, producerId: "prod_002" });

    mockLoadUser(user);
    mockedSubOrder.findMany.mockResolvedValueOnce([]);

    const res = await request
      .get("/api/v1/producers/me/sub-orders")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("[SO-R-unauth] returns 401 when no auth header", async () => {
    const res = await request.get("/api/v1/producers/me/sub-orders");
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/sub-orders/:id
// ===========================================================================

describe("GET /api/v1/producers/me/sub-orders/:id — get own SubOrder with lines", () => {
  it("[SO-R4] returns 200 with SubOrder including orderLines when owned by producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const so = makeSubOrder({
      orderLines: [
        {
          id: "ol_001",
          subOrderId: "so_001",
          productId: "prod_item_001",
          quantity: 2,
          unitPriceSnapshot: new Decimal("10.00"),
        },
      ],
    });

    mockLoadUser(user);
    mockedSubOrder.findFirst.mockResolvedValueOnce(so);

    const res = await request
      .get("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("so_001");
    expect(res.body.producerId).toBe("prod_001");
    expect(Array.isArray(res.body.orderLines)).toBe(true);
    expect(res.body.orderLines).toHaveLength(1);
  });

  it("[SO-R5] returns 404 NOT_FOUND when SubOrder belongs to another producer (cross-producer no-leak)", async () => {
    // Spec: order-fulfillment scenario "Cross-producer read returns 404"
    // P1 calls GET /producers/me/sub-orders/S9.id where S9 is owned by P2 → 404, no 403.
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // Service uses findFirst({ where: { id, producerId } }) — returns null for cross-producer.
    mockedSubOrder.findFirst.mockResolvedValueOnce(null);

    const res = await request
      .get("/api/v1/producers/me/sub-orders/so_owned_by_p2")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
    // Must not be 403 — opaque no-leak (spec: "MUST NOT reveal ownership")
    expect(res.body.code).not.toBe("FORBIDDEN");
  });
});
