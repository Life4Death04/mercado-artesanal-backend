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
 *   [DM11] POST   /producers/me/delivery-modes               — 422 unknown type rejected at API boundary
 *   [DM12] PATCH  /producers/me/delivery-modes/:id           — 422 unknown type rejected at API boundary
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
  auth:
    () =>
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
      cart: { findUnique: vi.fn() },
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCart = mockedPrisma.cart as any;

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
    carrierCompany: "Correos",
    notes: "Shared notes",
    pickupLocation: null,
    pickupLocationName: null,
    pickupStreet: null,
    pickupMunicipality: null,
    pickupPostalCode: null,
    pickupOpeningHours: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeConsumerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "cuid_consumer_001",
    role: "CONSUMER",
    email: "consumer@example.com",
    ...overrides,
  };
}

function makeCartForCheckout(producerIds: string[]) {
  return {
    id: "cart_001",
    userId: "cuid_consumer_001",
    items: producerIds.map((producerId, index) => ({
      id: `cart_item_${index}`,
      productId: `product_${index}`,
      quantity: 1,
      unitPriceSnapshot: new Decimal("10.00"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      product: {
        id: `product_${index}`,
        name: `Product ${index}`,
        price: new Decimal("10.00"),
        stock: 10,
        isActive: true,
        deletedAt: null,
        producer: { id: producerId, deletedAt: null },
      },
    })),
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

  it("creates PERSONAL_DELIVERY and exposes every new field with Decimal cost as a string", async () => {
    const sub = "auth0|producer001";
    mockLoadUser(makeProducerUser({ auth0Sub: sub }));
    mockedDeliveryMode.create.mockResolvedValueOnce(
      makeDeliveryMode({
        type: "PERSONAL_DELIVERY" as DeliveryModeType,
        cost: new Decimal("3.50"),
        coverageZone: "Madrid city",
        carrierCompany: null,
        notes: "Call before delivery",
      }),
    );

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "PERSONAL_DELIVERY",
        cost: 3.5,
        coverageZone: "Madrid city",
        notes: "Call before delivery",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        type: "PERSONAL_DELIVERY",
        cost: "3.5",
        coverageZone: "Madrid city",
        carrierCompany: null,
        notes: "Call before delivery",
        pickupLocationName: null,
        pickupStreet: null,
        pickupMunicipality: null,
        pickupPostalCode: null,
        pickupOpeningHours: null,
      }),
    );
  });

  it("rejects an invalid pickupPostalCode at the strict API boundary", async () => {
    const sub = "auth0|producer001";
    mockLoadUser(makeProducerUser({ auth0Sub: sub }));

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "PICKUP",
        cost: 0,
        pickupStreet: "Calle Mayor 1",
        pickupPostalCode: "2800A",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(mockedDeliveryMode.create).not.toHaveBeenCalled();
  });

  it.each([1.001, 100_000_000])("rejects invalid Decimal(10,2) cost %s", async (cost) => {
    const sub = "auth0|producer001";
    mockLoadUser(makeProducerUser({ auth0Sub: sub }));

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ type: "SHIPPING_FLAT_RATE", cost });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(mockedDeliveryMode.create).not.toHaveBeenCalled();
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

  it("clears a nullable configuration field when PATCH explicitly sends null", async () => {
    const sub = "auth0|producer001";
    const updateSpy = vi.fn().mockResolvedValue(makeDeliveryMode({ notes: null }));
    mockLoadUser(makeProducerUser({ auth0Sub: sub }));
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) =>
        fn({
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            update: updateSpy,
          },
        } as unknown as typeof prisma),
    );

    const res = await request
      .patch("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ notes: null });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBeNull();
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "dm_001" },
      data: expect.objectContaining({ notes: null }),
    });
  });

  it("applies an explicitly patched legacy pickupLocation on a structured PICKUP", async () => {
    const sub = "auth0|producer001";
    const updateSpy = vi
      .fn()
      .mockResolvedValue(
        makeDeliveryMode({ type: "PICKUP" as DeliveryModeType, pickupLocation: "New point" }),
      );
    mockLoadUser(makeProducerUser({ auth0Sub: sub }));
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) =>
        fn({
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(
              makeDeliveryMode({
                type: "PICKUP" as DeliveryModeType,
                pickupLocation: "Old generated point",
                pickupStreet: "Old street 1",
              }),
            ),
            update: updateSpy,
          },
        } as unknown as typeof prisma),
    );

    const res = await request
      .patch("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ pickupLocation: "New point" });

    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "dm_001" },
      data: expect.objectContaining({ pickupLocation: "New point" }),
    });
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

// ===========================================================================
// Enum widening rejection — API boundary contract
// ===========================================================================

describe("Enum widening rejection — unknown type rejected at API boundary", () => {
  /**
   * [DM11] POST with type='COURIER' (outside the allowed enum PICKUP | SHIPPING_FLAT_RATE)
   * MUST be rejected by the DTO validation layer before reaching the service.
   *
   * Strict TDD note: The DTO already enforces DeliveryModeTypeSchema = z.enum(["PICKUP",
   * "SHIPPING_FLAT_RATE"]) via validateBody(), which throws ValidationFailedError (422).
   * This test proves that invariant holds at the full HTTP boundary, not just at unit level.
   *
   * Spec: delivery-modes §"Enum literal stability", §"Forward contract for Cycle 3"
   */
  it("[DM11] rejects unknown delivery mode type at API boundary with 422 VALIDATION_FAILED (POST)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // No Prisma mock needed — DTO validation rejects the request before the service is called.

    const res = await request
      .post("/api/v1/producers/me/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "COURIER", // Not in the allowed enum — must be rejected
        cost: 3.5,
        coverageZone: "Valencia",
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  /**
   * [DM12] PATCH with type='COURIER' MUST also be rejected by the update DTO schema.
   *
   * UpdateDeliveryModeBodySchema uses DeliveryModeTypeSchema.optional() — same enum,
   * same rejection. Proves the API boundary is closed on both write paths.
   *
   * No existing-record seed needed: the DTO validation runs before any Prisma look-up.
   */
  it("[DM12] rejects unknown delivery mode type at API boundary with 422 VALIDATION_FAILED (PATCH)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    // No Prisma $transaction mock needed — DTO validation rejects before service is reached.

    const res = await request
      .patch("/api/v1/producers/me/delivery-modes/dm_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        type: "COURIER", // Not in the allowed enum — must be rejected
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

// ===========================================================================
// GET /api/v1/pagos/delivery-modes — checkout-delivery-modes (WU2 RED)
// ===========================================================================

describe("GET /api/v1/pagos/delivery-modes — consumer delivery modes", () => {
  it("[BE1-R1a] returns 401 without authentication", async () => {
    const res = await request.get("/api/v1/pagos/delivery-modes");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("[BE1-R1b] returns 403 ONBOARDING_REQUIRED for a pending caller", async () => {
    const sub = "auth0|pending-consumer";
    mockLoadUser(
      makeConsumerUser({ auth0Sub: sub, role: "PENDING_ROLE" }) as ReturnType<
        typeof makeProducerUser
      >,
    );

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ONBOARDING_REQUIRED");
  });

  it("[BE1-R2] returns one active-mode group for each distinct producer in a multi-producer cart", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser(makeConsumerUser({ auth0Sub: sub }) as ReturnType<typeof makeProducerUser>);
    mockedCart.findUnique.mockResolvedValueOnce(
      makeCartForCheckout(["prod_a", "prod_b", "prod_a"]),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([
      makeDeliveryMode({ id: "dm_shipping", producerId: "prod_a", cost: new Decimal("5.50") }),
      makeDeliveryMode({
        id: "dm_pickup",
        producerId: "prod_b",
        type: "PICKUP" as DeliveryModeType,
        cost: new Decimal("0.00"),
        pickupLocation: "Calle Mayor 1",
        pickupLocationName: "Central Market",
      }),
      makeDeliveryMode({
        id: "dm_personal",
        producerId: "prod_a",
        type: "PERSONAL_DELIVERY" as DeliveryModeType,
        cost: new Decimal("2.50"),
      }),
    ]);

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        producerId: "prod_a",
        modes: [
          { id: "dm_shipping", name: "Shipping", type: "shipping", price: "5.50" },
          {
            id: "dm_personal",
            name: "Personal delivery",
            type: "shipping",
            price: "2.50",
          },
        ],
      },
      {
        producerId: "prod_b",
        modes: [{ id: "dm_pickup", name: "Central Market", type: "pickup", price: "0.00" }],
      },
    ]);
  });

  it("[BE1-R2b] returns an empty array for an existing empty cart", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser(makeConsumerUser({ auth0Sub: sub }) as ReturnType<typeof makeProducerUser>);
    mockedCart.findUnique.mockResolvedValueOnce(makeCartForCheckout([]));

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockedDeliveryMode.findMany).not.toHaveBeenCalled();
  });

  it("[BE1-R3a] excludes inactive and unrelated producer modes", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser(makeConsumerUser({ auth0Sub: sub }) as ReturnType<typeof makeProducerUser>);
    mockedCart.findUnique.mockResolvedValueOnce(makeCartForCheckout(["prod_a"]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([
      makeDeliveryMode({ id: "dm_active", producerId: "prod_a" }),
      makeDeliveryMode({ id: "dm_inactive", producerId: "prod_a", isActive: false }),
      makeDeliveryMode({ id: "dm_unrelated", producerId: "prod_other" }),
    ]);

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        producerId: "prod_a",
        modes: [{ id: "dm_active", name: "Shipping", type: "shipping", price: "5.00" }],
      },
    ]);
    expect(mockedDeliveryMode.findMany).toHaveBeenCalledWith({
      where: { producerId: { in: ["prod_a"] }, isActive: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("[BE1-R3b] preserves a cart producer group with no active modes", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser(makeConsumerUser({ auth0Sub: sub }) as ReturnType<typeof makeProducerUser>);
    mockedCart.findUnique.mockResolvedValueOnce(makeCartForCheckout(["prod_a"]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([]);

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ producerId: "prod_a", modes: [] }]);
  });

  it("[BE1-R4] serializes exactly four DTO fields and performs no write", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser(makeConsumerUser({ auth0Sub: sub }) as ReturnType<typeof makeProducerUser>);
    mockedCart.findUnique.mockResolvedValueOnce(makeCartForCheckout(["prod_a"]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryMode({ producerId: "prod_a" })]);

    const res = await request
      .get("/api/v1/pagos/delivery-modes")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body[0].modes[0])).toEqual(["id", "name", "type", "price"]);
    expect(mockedDeliveryMode.create).not.toHaveBeenCalled();
    expect(mockedDeliveryMode.update).not.toHaveBeenCalled();
    expect(mockedDeliveryMode.delete).not.toHaveBeenCalled();
  });
});
