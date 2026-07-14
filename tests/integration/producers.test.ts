/**
 * Integration tests — producers endpoints (Slice 9, Commit A RED).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; producer operations call
 *     `prisma.$transaction` (callback form), `prisma.producer.*`,
 *     `prisma.producerCategory.*`, `prisma.producerCategoryOnProducer.*`,
 *     `prisma.subOrder.count`.
 *
 * Scenarios covered (specs: producer-bootstrap):
 *   [PB1]  PATCH /producers/me                     — 200 partial update (businessName)
 *   [PB2]  PATCH /producers/me                     — 422 NIF edit rejected
 *   [PB3]  PATCH /producers/me                     — 422 UNKNOWN_CATEGORY for unknown slug
 *   [PB4]  PATCH /producers/me                     — 403 non-producer role forbidden
 *   [PB5]  DELETE /producers/me                    — 409 PRODUCER_HAS_ACTIVE_ORDERS (non-terminal SubOrder)
 *   [PB6]  DELETE /producers/me                    — 204 allowed when all SubOrders terminal
 *   [PB7]  DELETE /producers/me                    — 204 allowed when no SubOrders
 *   [PB8]  GET /producers/:id                      — 200 public projection (PII redacted)
 *   [PB9]  GET /producers/:id                      — 404 soft-deleted producer
 *   [PB10] GET /producers/:id                      — 404 unknown producer
 *   [PB-unauth] PATCH /producers/me                — 401 unauthenticated
 *
 * Spec references:
 *   producer-bootstrap §"Private profile edit endpoint"
 *   producer-bootstrap §"Public producer projection endpoint"
 *   producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 *   producer-bootstrap scenario "NIF edit rejected"
 *   producer-bootstrap scenario "Unknown categorySlug rejected"
 *   producer-bootstrap scenario "Public projection redacts PII"
 *   producer-bootstrap scenario "Delete blocked by non-terminal SubOrder"
 *   producer-bootstrap scenario "Delete allowed when all SubOrders terminal"
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
// producer operations call prisma.$transaction (callback), prisma.producer.*,
// prisma.producerCategory.findMany, prisma.producerCategoryOnProducer.*,
// and prisma.subOrder.count (soft-delete guard).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
      producer: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      producerCategory: {
        findMany: vi.fn(),
      },
      producerCategoryOnProducer: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      subOrder: { count: vi.fn() },
    },
  };
});

import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProducer = mockedPrisma.producer as any;

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

function makeConsumerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "cuid_user_002",
    role: "CONSUMER",
    email: "consumer@example.com",
    producerId: null,
    ...overrides,
  };
}

function makeProducer(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_001",
    userId: "cuid_user_001",
    businessName: "Old Business",
    nif: "B12345678",
    description: "A producer description",
    addressLine1: "Calle X 1",
    addressLine2: null,
    addressCity: "Madrid",
    addressPostalCode: "28001",
    addressProvince: "Madrid",
    addressCountry: "ES",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    categories: [{ category: { slug: "artesania", name: "Artesanía" } }],
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
// PATCH /api/v1/producers/me
// ===========================================================================

describe("PATCH /api/v1/producers/me — partial profile update", () => {
  it("[PB1] returns 200 with updated producer when patching businessName", async () => {
    // Spec: producer-bootstrap §"Private profile edit endpoint"
    // Scenario: "Partial update succeeds"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const existing = makeProducer();
    const updated = makeProducer({ businessName: "New Business" });

    mockLoadUser(user);

    // $transaction callback: findFirst → update
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn().mockResolvedValueOnce(updated),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
        producerCategory: { findMany: vi.fn().mockResolvedValueOnce([]) },
        producerCategoryOnProducer: {
          deleteMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
          createMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
        },
      };
      return fn(tx);
    });

    const res = await request
      .patch("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ businessName: "New Business" });

    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("New Business");
  });

  it("[PB2] returns 422 VALIDATION_FAILED when nif is present in body", async () => {
    // Spec: producer-bootstrap scenario "NIF edit rejected"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .patch("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ nif: "B99999999" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[PB3] returns 422 UNKNOWN_CATEGORY when unknown categorySlug provided", async () => {
    // Spec: producer-bootstrap scenario "Unknown categorySlug rejected"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const existing = makeProducer();

    mockLoadUser(user);

    // $transaction callback: findFirst → producerCategory.findMany returns only 1 (not 2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn(),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
        producerCategory: {
          findMany: vi.fn().mockResolvedValueOnce([
            // only 1 found out of 2 requested
            { id: "cat_queso", slug: "queso", name: "Queso" },
          ]),
        },
        producerCategoryOnProducer: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
      };
      return fn(tx);
    });

    const res = await request
      .patch("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ categorySlugs: ["queso", "not-a-real-slug"] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("UNKNOWN_CATEGORY");
  });

  it("[PB4] returns 403 FORBIDDEN when consumer role calls PATCH /producers/me", async () => {
    // Spec: producer-bootstrap scenario "Non-producer role forbidden"
    const sub = "auth0|consumer001";
    const user = makeConsumerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .patch("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ businessName: "Hacked" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("[PB-unauth] returns 401 when no auth header", async () => {
    const res = await request
      .patch("/api/v1/producers/me")
      .send({ businessName: "Test" });

    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// DELETE /api/v1/producers/me
// ===========================================================================

describe("DELETE /api/v1/producers/me — soft-delete with guard", () => {
  it("[PB5] returns 409 PRODUCER_HAS_ACTIVE_ORDERS when non-terminal SubOrder exists", async () => {
    // Spec: producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
    // Scenario: "Delete blocked by non-terminal SubOrder"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const existing = makeProducer();

    mockLoadUser(user);

    // $transaction: findFirst → subOrder.count returns 1 → guard fires
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn(),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(1) },
      };
      return fn(tx);
    });

    const res = await request
      .delete("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCER_HAS_ACTIVE_ORDERS");
  });

  it("[PB6] returns 204 when all SubOrders are terminal", async () => {
    // Spec: producer-bootstrap scenario "Delete allowed when all SubOrders terminal"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const existing = makeProducer();

    mockLoadUser(user);

    // $transaction: findFirst → subOrder.count = 0 → update sets deletedAt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn().mockResolvedValueOnce({ ...existing, deletedAt: new Date() }),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
      };
      return fn(tx);
    });

    const res = await request
      .delete("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(204);
  });

  it("[PB7] returns 204 when producer has no SubOrders", async () => {
    // Spec: producer-bootstrap scenario "Delete allowed when producer has no SubOrders"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const existing = makeProducer();

    mockLoadUser(user);

    // $transaction: findFirst → subOrder.count = 0 → update sets deletedAt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn().mockResolvedValueOnce({ ...existing, deletedAt: new Date() }),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
      };
      return fn(tx);
    });

    const res = await request
      .delete("/api/v1/producers/me")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(204);
  });
});

// ===========================================================================
// GET /api/v1/producers/:id  (public — no auth required)
// ===========================================================================

describe("GET /api/v1/producers/:id — public projection", () => {
  it("[PB8] returns 200 with redacted projection (no nif, no addressLine1)", async () => {
    // Spec: producer-bootstrap §"Public producer projection endpoint"
    // Scenario: "Public projection redacts PII"
    const fullProducer = makeProducer({
      categories: [{ category: { slug: "artesania", name: "Artesanía" } }],
    });

    mockedProducer.findFirst.mockResolvedValueOnce(fullProducer);

    const res = await request.get("/api/v1/producers/prod_001");

    expect(res.status).toBe(200);
    // Public fields present
    expect(res.body.id).toBe("prod_001");
    expect(res.body.businessName).toBe("Old Business");
    expect(res.body.address.city).toBe("Madrid");
    expect(res.body.address.province).toBe("Madrid");
    expect(res.body.address.country).toBe("ES");
    expect(Array.isArray(res.body.categories)).toBe(true);
    // PII fields MUST NOT appear
    expect(res.body.nif).toBeUndefined();
    expect(res.body.userId).toBeUndefined();
    expect(res.body.address.line1).toBeUndefined();
    expect(res.body.address.line2).toBeUndefined();
    expect(res.body.address.postalCode).toBeUndefined();
    // Verify raw NIF string not in body
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("B12345678");
    expect(bodyStr).not.toContain("Calle X 1");
  });

  it("[PB9] returns 404 NOT_FOUND for soft-deleted producer", async () => {
    // Spec: producer-bootstrap §"Public producer projection endpoint"
    // Scenario: "Soft-deleted producer returns 404"
    mockedProducer.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/producers/prod_deleted");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("[PB10] returns 404 NOT_FOUND for unknown producer", async () => {
    // Spec: producer-bootstrap §"Public producer projection endpoint"
    mockedProducer.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/producers/prod_unknown");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
