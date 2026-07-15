/**
 * Integration tests — statistics endpoints (Slice 10 TDD, Commit A RED).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *   - `@/modules/inventory/services/inventory.service` mocked for low-stock delegation.
 *
 * Scenarios covered (specs: sales-stats):
 *   [SS-1]   GET /producers/me/stats/revenue?window=30d      — 200 { window, totalRevenue: string }
 *   [SS-2]   GET /producers/me/stats/revenue?window=7d       — 200 totalRevenue = "0.00" (empty)
 *   [SS-3]   GET /producers/me/stats/revenue?window=42d      — 422 VALIDATION_FAILED (unknown window)
 *   [SS-4]   GET /producers/me/stats/revenue (no window)     — 422 VALIDATION_FAILED (required)
 *   [SS-5]   GET /producers/me/stats/order-count?window=30d  — 200 { window, count: number }
 *   [SS-6]   GET /producers/me/stats/order-count?window=42d  — 422 VALIDATION_FAILED
 *   [SS-7]   GET /producers/me/stats/low-stock               — 200 products array
 *   [SS-8]   GET /producers/me/stats/low-stock?limit=5       — 200 with pagination
 *   [SS-9]   GET /producers/me/stats/revenue                 — 401 unauthenticated
 *   [SS-10]  GET /producers/me/stats/top-products            — 404 (non-goal: no ranking endpoint)
 *
 * Spec references:
 *   sales-stats §"Window parameter contract"
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint"
 *   sales-stats §"Non-goals"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as other integration tests
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
// Revenue uses prisma.$queryRaw; order count uses prisma.subOrder.count.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => ({
  prisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn() },
    subOrder: { count: vi.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Mock: inventory service — low-stock delegation
// ---------------------------------------------------------------------------
vi.mock("@/modules/inventory/services/inventory.service", () => ({
  findLowStock: vi.fn(),
}));

import { prisma } from "@/shared/utils/prisma";
import * as inventoryService from "@/modules/inventory/services/inventory.service";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedQueryRaw = mockedPrisma.$queryRaw as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedSubOrderCount = mockedPrisma.subOrder as any;
const mockedFindLowStock = vi.mocked(inventoryService.findLowStock);

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
// GET /api/v1/producers/me/stats/revenue
// ===========================================================================

describe("GET /api/v1/producers/me/stats/revenue — revenue window endpoint", () => {
  it("[SS-1] returns 200 with totalRevenue as decimal string for valid window", async () => {
    // Spec: revenue response includes window, totalRevenue (string), currency, from, to
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedQueryRaw.mockResolvedValueOnce([{ total: "350.75" }]);

    const res = await request
      .get("/api/v1/producers/me/stats/revenue?window=30d")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.window).toBe("30d");
    expect(res.body.totalRevenue).toBe("350.75");
    // INVARIANT: totalRevenue MUST be a string, not a number
    expect(typeof res.body.totalRevenue).toBe("string");
    expect(res.body.currency).toBe("EUR");
    expect(res.body.from).toBeDefined();
    expect(res.body.to).toBeDefined();
  });

  it("[SS-2] returns 200 with totalRevenue = '0.00' when no SubOrders in window", async () => {
    // Spec scenario: "Empty window returns zero"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // $queryRaw returns null total (no rows)
    mockedQueryRaw.mockResolvedValueOnce([{ total: null }]);

    const res = await request
      .get("/api/v1/producers/me/stats/revenue?window=7d")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe("0.00");
    expect(typeof res.body.totalRevenue).toBe("string");
  });

  it("[SS-3] returns 422 VALIDATION_FAILED for unknown window value", async () => {
    // Spec scenario: "Unknown window rejected"
    // GIVEN window = "42d" (not in 7d | 30d | 90d | 1y)
    // THEN 422 with code = "VALIDATION_FAILED"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .get("/api/v1/producers/me/stats/revenue?window=42d")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[SS-4] returns 422 VALIDATION_FAILED when window param is missing", async () => {
    // Spec: window is required on windowed endpoints
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .get("/api/v1/producers/me/stats/revenue")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[SS-unauth] returns 401 when no auth header provided", async () => {
    const res = await request.get("/api/v1/producers/me/stats/revenue?window=30d");
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/stats/order-count
// ===========================================================================

describe("GET /api/v1/producers/me/stats/order-count — order count endpoint", () => {
  it("[SS-5] returns 200 with count excluding cancelled SubOrders", async () => {
    // Spec scenario: "Count excludes cancelled"
    // GIVEN 3 SubOrders: 2 delivered, 1 cancelled → count = 2
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // Service uses prisma.subOrder.count filtering status NOT cancelled
    mockedSubOrderCount.count.mockResolvedValueOnce(2);

    const res = await request
      .get("/api/v1/producers/me/stats/order-count?window=30d")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.window).toBe("30d");
    expect(res.body.count).toBe(2);
    expect(typeof res.body.count).toBe("number");
    expect(res.body.from).toBeDefined();
    expect(res.body.to).toBeDefined();
  });

  it("[SS-6] returns 422 VALIDATION_FAILED for unknown window value", async () => {
    // Spec scenario: "Unknown window rejected" applies to order-count too
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .get("/api/v1/producers/me/stats/order-count?window=42d")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

// ===========================================================================
// GET /api/v1/producers/me/stats/low-stock
// ===========================================================================

describe("GET /api/v1/producers/me/stats/low-stock — low-stock alerts endpoint", () => {
  it("[SS-7] returns 200 with products at or below threshold (delegation)", async () => {
    // Spec scenario: "Returns products at or below threshold"
    // Products A(stock=0, thr=5), B(stock=5, thr=5) → in result
    // Product C(stock=6, thr=5) → excluded (handled by inventory.findLowStock)
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedFindLowStock.mockResolvedValueOnce([
      {
        id: "p_a",
        name: "Product A",
        stock: 0,
        lowStockThreshold: 5,
      },
      {
        id: "p_b",
        name: "Product B",
        stock: 5,
        lowStockThreshold: 5,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const res = await request
      .get("/api/v1/producers/me/stats/low-stock")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe("p_a");
    expect(res.body[1].id).toBe("p_b");
    // Verify delegation happened with correct producerId
    expect(mockedFindLowStock).toHaveBeenCalledTimes(1);
    expect(mockedFindLowStock).toHaveBeenCalledWith(
      expect.objectContaining({ producerId: "prod_001" }),
    );
  });

  it("[SS-8] passes limit and offset query params to inventory.findLowStock", async () => {
    // Spec: pagination — limit default 20, cap 100
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);

    const res = await request
      .get("/api/v1/producers/me/stats/low-stock?limit=5&offset=10")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(mockedFindLowStock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 10 }),
    );
  });

  it("[SS-7-empty] returns 200 with empty array when no low-stock products", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);

    const res = await request
      .get("/api/v1/producers/me/stats/low-stock")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ===========================================================================
// Non-goals — ranking / top-products endpoints MUST NOT exist
// Spec: sales-stats §"Non-goals"
// ===========================================================================

describe("Non-goals — spec-forbidden endpoints MUST NOT be registered", () => {
  it("[SS-10] GET /producers/me/stats/top-products returns 404 (not registered)", async () => {
    // Spec: "Top-N products / product ranking — MUST NOT ship in Cycle 2"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .get("/api/v1/producers/me/stats/top-products")
      .set("X-Test-Auth", authHeader({ sub }));

    // 404 means the route is not registered — correct behavior
    expect(res.status).toBe(404);
  });

  it("[SS-11] GET /producers/me/stats/cohort returns 404 (not registered)", async () => {
    // Spec: "Cohort or retention analytics — MUST NOT ship in Cycle 2"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .get("/api/v1/producers/me/stats/cohort")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
  });
});
