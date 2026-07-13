/**
 * Integration tests — delivery-modes endpoints (Slice 7, RED phase).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; delivery-mode operations call
 *     `prisma.$transaction` (callback form) or direct model accessors.
 *
 * Scenarios covered (specs: delivery-modes):
 *   [DM1]  POST   /producers/me/delivery-modes                — 201 created
 *   [DM2]  POST   /producers/me/delivery-modes                — 422 PICKUP without pickupLocation
 *   [DM3]  GET    /producers/me/delivery-modes                — 200 list own delivery modes
 *   [DM4]  GET    /producers/me/delivery-modes/:id            — 200 get own delivery mode
 *   [DM5]  GET    /producers/me/delivery-modes/:id            — 404 DELIVERY_MODE_NOT_FOUND (cross-producer)
 *   [DM6]  PATCH  /producers/me/delivery-modes/:id            — 200 partial update
 *   [DM7]  PATCH  /producers/me/delivery-modes/:id            — 404 DELIVERY_MODE_NOT_FOUND (cross-producer)
 *   [DM8]  DELETE /producers/me/delivery-modes/:id            — 409 active SubOrder blocks delete
 *   [DM9]  DELETE /producers/me/delivery-modes/:id            — 204 hard-delete when no active SubOrders
 *   [DM10] GET    /producers/me/delivery-modes/:id            — enum literal "SHIPPING_FLAT_RATE" on wire
 *   [DM-unauth] POST /producers/me/delivery-modes             — 401 unauthenticated
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD", §"DeliveryMode entity",
 *                  §"PICKUP without pickupLocation rejected",
 *                  §"Cross-producer read returns 404",
 *                  §"Delete blocked by active SubOrder reference",
 *                  §"Enum literal stability"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as products.test.ts
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
// delivery-mode operations call prisma.$transaction (callback),
// prisma.deliveryMode.*, prisma.subOrder.count (delete guard).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
      deliveryMode: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      subOrder: { count: vi.fn() },
    },
  };
});

import type { DeliveryModeType } from "@prisma/client";
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
const mockedDeliveryMode = mockedPrisma.deliveryMode as any;

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

function makeDeliveryMode(overrides: Record<string, unknown> = {}) {
  return {
    id: "dm_001",
    producerId: "prod_001",
    type: "SHIPPING_FLAT_RATE" as DeliveryModeType,
    cost: new Decimal("5.00"),
    coverageZone: "Madrid",
    pickupLocation: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
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
// POST /api/v1/producers/me/delivery-modes
// ===========================================================================

describe("POST /api/v1/producers/me/delivery-modes — create delivery mode", () => {
  it("[DM1] returns 201 with created delivery mode (SHIPPING_FLAT_RATE)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const created = makeDeliveryMode();

    mockLoadUser(user);
    mockedDeliveryMode.create.mockResolvedValueOnce(created);

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "SHIPPING_FLAT_RATE",
        cost: 5.0,
        coverageZone: "Madrid",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(created.id);
    expect(res.body.type).toBe("SHIPPING_FLAT_RATE");
    expect(res.body.producerId).toBe("prod_001");
  });

  it("[DM2] returns 422 VALIDATION_FAILED when type=PICKUP and pickupLocation is absent", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "PICKUP",
        cost: 0,
        // pickupLocation intentionally omitted
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[DM-unauth] returns 401 when no auth header", async () => {
    const res = await request.post("/api/v1/producers/me/delivery-modes").send({
      type: "SHIPPING_FLAT_RATE",
      cost: 5.0,
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/delivery-modes
// ===========================================================================

describe("GET /api/v1/producers/me/delivery-modes — list delivery modes", () => {
  it("[DM3] returns 200 with array of own delivery modes", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const dm = makeDeliveryMode();

    mockLoadUser(user);
    mockedDeliveryMode.findMany.mockResolvedValueOnce([dm]);

    const res = await request
      .get("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(dm.id);
  });

  it("[DM3b] returns 200 with empty array when producer has no delivery modes", async () => {
    const sub = "auth0|producer002";
    const user = makeProducerUser({ id: "cuid_user_002", auth0Sub: sub, producerId: "prod_002" });

    mockLoadUser(user);
    mockedDeliveryMode.findMany.mockResolvedValueOnce([]);

    const res = await request
      .get("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/delivery-modes/:id
// ===========================================================================

describe("GET /api/v1/producers/me/delivery-modes/:id — get own delivery mode", () => {
  it("[DM4] returns 200 with delivery mode when owned by the requesting producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const dm = makeDeliveryMode();

    mockLoadUser(user);
    mockedDeliveryMode.findFirst.mockResolvedValueOnce(dm);

    const res = await request
      .get("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(dm.id);
  });

  it("[DM5] returns 404 DELIVERY_MODE_NOT_FOUND when delivery mode belongs to another producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedDeliveryMode.findFirst.mockResolvedValueOnce(null); // 404-no-leak

    const res = await request
      .get("/api/v1/producers/me/delivery-modes/dm_foreign")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DELIVERY_MODE_NOT_FOUND");
  });
});

// ===========================================================================
// PATCH /api/v1/producers/me/delivery-modes/:id
// ===========================================================================

describe("PATCH /api/v1/producers/me/delivery-modes/:id — update delivery mode", () => {
  it("[DM6] returns 200 with updated delivery mode when owned by producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const updated = makeDeliveryMode({ coverageZone: "Barcelona" });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            update: vi.fn().mockResolvedValue(updated),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ coverageZone: "Barcelona" });

    expect(res.status).toBe(200);
    expect(res.body.coverageZone).toBe("Barcelona");
  });

  it("[DM7] returns 404 DELIVERY_MODE_NOT_FOUND when delivery mode belongs to another producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(null), // 404-no-leak
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/producers/me/delivery-modes/dm_foreign")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ coverageZone: "Hacked" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DELIVERY_MODE_NOT_FOUND");
  });
});

// ===========================================================================
// DELETE /api/v1/producers/me/delivery-modes/:id
// ===========================================================================

describe("DELETE /api/v1/producers/me/delivery-modes/:id — hard delete", () => {
  it("[DM8] returns 409 PRODUCER_HAS_ACTIVE_ORDERS when active SubOrders reference the delivery mode", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            delete: vi.fn(),
          },
          subOrder: {
            count: vi.fn().mockResolvedValue(1), // active SubOrders exist
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCER_HAS_ACTIVE_ORDERS");
  });

  it("[DM9] returns 204 and hard-deletes when no active SubOrders reference the delivery mode", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            delete: vi.fn().mockResolvedValue(makeDeliveryMode()),
          },
          subOrder: {
            count: vi.fn().mockResolvedValue(0), // no active SubOrders
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});

// ===========================================================================
// Enum literal stability
// ===========================================================================

describe("Enum literal stability — DeliveryModeType wire strings", () => {
  it("[DM10] GET /producers/me/delivery-modes/:id returns type='SHIPPING_FLAT_RATE' verbatim", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const dm = makeDeliveryMode({ type: "SHIPPING_FLAT_RATE" as DeliveryModeType });

    mockLoadUser(user);
    mockedDeliveryMode.findFirst.mockResolvedValueOnce(dm);

    const res = await request
      .get("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    // The wire value MUST be the exact enum literal string, not a numeric ordinal.
    expect(res.body.type).toBe("SHIPPING_FLAT_RATE");
  });

  it("[DM10b] GET /producers/me/delivery-modes/:id returns type='PICKUP' verbatim", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const dm = makeDeliveryMode({
      type: "PICKUP" as DeliveryModeType,
      pickupLocation: "Calle Mayor 1, Madrid",
      cost: new Decimal("0.00"),
    });

    mockLoadUser(user);
    mockedDeliveryMode.findFirst.mockResolvedValueOnce(dm);

    const res = await request
      .get("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("PICKUP");
  });
});
