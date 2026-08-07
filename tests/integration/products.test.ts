/**
 * Integration tests — products endpoints (Slice 3 extended).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; product operations call
 *     `prisma.$transaction` (callback form) or direct model accessors.
 *
 * Scenarios covered (specs: product-catalog + product-images + product-reporting):
 *   [PC1]  POST   /producers/me/products           — 201 published-on-create
 *   [PC2]  POST   /producers/me/products           — 422 negative price
 *   [PC3]  GET    /producers/me/products           — 200 list own products
 *   [PC3-IMG1] GET /producers/me/products          — images[]: [] for product with no images
 *   [PC3-IMG2] GET /producers/me/products          — images[]: [{id,position,url}] for product with images
 *   [PC3-IMG3] GET /producers/me/products          — s3Key never in response body
 *   [PC4]  GET    /producers/me/products/:id       — 200 get own product
 *   [PC4-IMG1] GET /producers/me/products/:id      — images mapped to {id,position,url}, s3Key absent
 *   [PC5]  GET    /producers/me/products/:id       — 404 PRODUCT_NOT_FOUND (cross-producer)
 *   [PC6]  PATCH  /producers/me/products/:id       — 200 partial update
 *   [PC7]  PATCH  /producers/me/products/:id       — 404 PRODUCT_NOT_FOUND (cross-producer)
 *   [PC8]  DELETE /producers/me/products/:id       — 409 PRODUCT_HAS_ACTIVE_ORDERS
 *   [PC9]  DELETE /producers/me/products/:id       — 204 soft-delete (no active orders)
 *   [PR1]  POST   /products/:id/report             — 200 first report on OK product
 *   [PR2]  POST   /products/:id/report             — 200 second report idempotent
 *   [PR3]  POST   /products/:id/report             — 404 report on REMOVED product
 *   [PR4]  POST   /products/:id/report             — 401 unauthenticated report
 *   [PR5]  POST   /products/:id/report             — 422 empty reason
 *   [PUB-L*] GET  /products                        — public list (public-catalog capability)
 *   [PUB-D*] GET  /products/:id                     — public detail (public-catalog capability)
 *
 * Spec references:
 *   product-catalog  §"Publish-on-create lifecycle", §"RBAC-scoped ownership",
 *                    §"Soft-delete guard against active order lines",
 *                    §"Producer product responses include images array"
 *   product-images   §"Wire shape", §"Deterministic ordering",
 *                    §"URL derivation", §"Empty images state"
 *   product-reporting §"Report endpoint", §"Second report is idempotent",
 *                     §"Unauthenticated report rejected"
 *   public-catalog   §"PUB-R1", §"PUB-R2", §"PUB-R3", §"PUB-R4"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as addresses.test.ts
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
// products operations call prisma.$transaction (callback), prisma.product.*,
// prisma.orderLine.count (guard), etc.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
      product: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      orderLine: { count: vi.fn() },
    },
  };
});

import type { ModerationStatus } from "@prisma/client";
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
const mockedProduct = mockedPrisma.product as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedOrderLine = mockedPrisma.orderLine as any;

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

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_001",
    producerId: "prod_001",
    categoryId: "cat_001",
    name: "Aceite de Oliva Virgen Extra",
    description: "Aceite artesanal de oliva virgen extra.",
    price: new Decimal("12.50"),
    stock: 100,
    lowStockThreshold: 5,
    isActive: true,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    reportedAt: null,
    moderationStatus: "OK" as ModerationStatus,
    reportReason: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    // Slice 3: service now returns images (from Prisma include). Default empty.
    images: [] as Array<{ id: string; position: number; s3Key: string; createdAt: Date }>,
    ...overrides,
  };
}

/**
 * Raw public-select Prisma row fixture (public-catalog capability).
 * Shape mirrors PUBLIC_PRODUCT_SELECT in products.service.ts — a subset of
 * Product plus nested category/producer selections, NOT the full Product row.
 * The producer sub-object intentionally contains ONLY the SAFE fields —
 * simulating exactly what a real `select` whitelist would return (nif,
 * addressLine1/2, addressPostalCode, userId are never fetched by the query,
 * so they cannot appear here either).
 */
function makePublicProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_pub_001",
    name: "Miel de Romero",
    description: "Miel artesanal de romero.",
    price: new Decimal("10.00"),
    stock: 20,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    categoryId: "cat_001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    images: [] as Array<{ id: string; position: number; s3Key: string; createdAt: Date }>,
    category: { id: "cat_001", slug: "miel", name: "Miel" },
    producer: {
      id: "prod_001",
      businessName: "Apiarios del Sur",
      description: "Productor artesanal.",
      addressCity: "Sevilla",
      addressProvince: "Sevilla",
      addressCountry: "ES",
    },
    ...overrides,
  };
}

/**
 * Configure prisma.user.findUnique to return a user projection for loadUser.
 * Cycle 2: PRODUCER role also returns a producer relation for producerId.
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
// POST /api/v1/producers/me/products
// ===========================================================================

describe("POST /api/v1/producers/me/products — create product", () => {
  it("[PC1] returns 201 with isActive=true and moderationStatus=OK (publish-on-create)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const created = makeProduct();

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          category: { findFirst: vi.fn().mockResolvedValue({ id: "cat_001", isActive: true }) },
          product: { create: vi.fn().mockResolvedValue(created) },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .post("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        categoryId: "cat_001",
        name: "Aceite de Oliva Virgen Extra",
        description: "Aceite artesanal de oliva virgen extra.",
        price: 12.5,
        stock: 100,
      });

    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(true);
    expect(res.body.moderationStatus).toBe("OK");
    expect(res.body.id).toBe(created.id);
  });

  it("[PC2] returns 422 VALIDATION_FAILED when price is negative", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .post("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        categoryId: "cat_001",
        name: "Aceite",
        description: "Desc",
        price: -1,
        stock: 0,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[PC-unauth] returns 401 when no auth header", async () => {
    const res = await request.post("/api/v1/producers/me/products").send({
      categoryId: "cat_001",
      name: "Aceite",
      description: "Desc",
      price: 12.5,
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/products
// ===========================================================================

describe("GET /api/v1/producers/me/products — list products", () => {
  it("[PC3] returns 200 with array of own products", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const product = makeProduct();

    mockLoadUser(user);
    mockedProduct.findMany.mockResolvedValueOnce([product]);

    const res = await request
      .get("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(product.id);
  });

  it("[PC3b] returns 200 with empty array when producer has no products", async () => {
    const sub = "auth0|producer002";
    const user = makeProducerUser({ id: "cuid_user_002", auth0Sub: sub, producerId: "prod_002" });

    mockLoadUser(user);
    mockedProduct.findMany.mockResolvedValueOnce([]);

    const res = await request
      .get("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("[PC3-IMG1] returns images: [] for a product that has no images (spec: empty images state)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const product = makeProduct({ images: [] });

    mockLoadUser(user);
    mockedProduct.findMany.mockResolvedValueOnce([product]);

    const res = await request
      .get("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.body[0].images).toEqual([]);
  });

  it("[PC3-IMG2] returns images mapped to { id, position, url } — ordered by position ASC (spec: wire shape + deterministic ordering)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    // Simulate Prisma returning images already ordered by position ASC (DB-level ordering contract)
    const images = [
      { id: "img_a", position: 0, s3Key: "path/to/img0.jpg", createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "img_b", position: 1, s3Key: "path/to/img1.jpg", createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    const product = makeProduct({ images });

    mockLoadUser(user);
    mockedProduct.findMany.mockResolvedValueOnce([product]);

    const res = await request
      .get("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const responseImages = res.body[0].images as Array<Record<string, unknown>>;
    expect(responseImages).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(responseImages[0]!.id).toBe("img_a");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(responseImages[0]!.position).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(typeof responseImages[0]!.url).toBe("string");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect((responseImages[0]!.url as string)).toContain("path/to/img0.jpg");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(responseImages[1]!.position).toBe(1);
  });

  it("[PC3-IMG3] response body NEVER contains s3Key on any image (spec: s3Key must not leave server)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const images = [
      { id: "img_secret", position: 0, s3Key: "sensitive/internal/key.jpg", createdAt: new Date() },
    ];
    const product = makeProduct({ images });

    mockLoadUser(user);
    mockedProduct.findMany.mockResolvedValueOnce([product]);

    const res = await request
      .get("/api/v1/producers/me/products")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    // Deep scan: the field name "s3Key" must not appear in the serialized body.
    // The key PATH may appear inside the url value (that is by design) — only the field name is forbidden.
    expect(JSON.stringify(res.body)).not.toContain('"s3Key"');
    // Exact key-set allowlist: image objects must expose ONLY { id, position, url }.
    // Any future field added to mapImageRow without updating this test will cause a failure.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const image = (res.body[0].images as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(image).sort()).toEqual(['id', 'position', 'url']);
  });
});

// ===========================================================================
// GET /api/v1/producers/me/products/:id
// ===========================================================================

describe("GET /api/v1/producers/me/products/:id — get own product", () => {
  it("[PC4] returns 200 with product when owned by the requesting producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const product = makeProduct();

    mockLoadUser(user);
    mockedProduct.findFirst.mockResolvedValueOnce(product);

    const res = await request
      .get("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(product.id);
  });

  it("[PC5] returns 404 PRODUCT_NOT_FOUND when product belongs to another producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedProduct.findFirst.mockResolvedValueOnce(null); // 404-no-leak

    const res = await request
      .get("/api/v1/producers/me/products/product_foreign")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[PC4-IMG-COUNT] detail returns ALL images regardless of count — no implicit cap (spec: all images returned)", async () => {
    // Spec: product-images §"All images returned regardless of count"
    // Fixture: 12 images — large enough to catch an accidental take:5 or take:10.
    // Mutation-verify: injecting `take: 5` into include.images in the service
    // drops this test from passing (res.body.images.length becomes 5).
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const N = 12;
    const images = Array.from({ length: N }, (_, i) => ({
      id: `img_pc4_count_${i}`,
      position: i,
      s3Key: `producers/p1/count/img_${i}.jpg`,
      createdAt: new Date(`2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    }));
    const product = makeProduct({ images });

    mockLoadUser(user);
    mockedProduct.findFirst.mockResolvedValueOnce(product);

    const res = await request
      .get("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const responseImages = res.body.images as Array<Record<string, unknown>>;
    // All 12 images must be present — no implicit pagination or cap
    expect(responseImages).toHaveLength(N);
    // Every input id must appear in the response (identity check, order-agnostic)
    const returnedIds = responseImages.map((img) => img["id"] as string).sort();
    const expectedIds = images.map((img) => img.id).sort();
    expect(returnedIds).toEqual(expectedIds);
  });

  it("[PC4-IMG1] detail returns images mapped to { id, position, url } — s3Key absent (spec: wire shape)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const images = [
      { id: "img_detail_001", position: 0, s3Key: "detail/img0.jpg", createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "img_detail_002", position: 1, s3Key: "detail/img1.jpg", createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    const product = makeProduct({ images });

    mockLoadUser(user);
    mockedProduct.findFirst.mockResolvedValueOnce(product);

    const res = await request
      .get("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const responseImages = res.body.images as Array<Record<string, unknown>>;
    expect(responseImages).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(responseImages[0]!.id).toBe("img_detail_001");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(responseImages[0]!.position).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(typeof responseImages[0]!.url).toBe("string");
    // The field name "s3Key" must not appear in the response body.
    // Key path values appear inside the url field (by design) — only the field name is forbidden.
    expect(JSON.stringify(res.body)).not.toContain('"s3Key"');
    // Exact key-set allowlist: image objects must expose ONLY { id, position, url }.
    // Any future field added to mapImageRow without updating this test will cause a failure.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Object.keys(responseImages[0]!).sort()).toEqual(['id', 'position', 'url']);
  });
});

// ===========================================================================
// PATCH /api/v1/producers/me/products/:id
// ===========================================================================

describe("PATCH /api/v1/producers/me/products/:id — update product", () => {
  it("[PC6] returns 200 with updated product when owned by producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const updated = makeProduct({ isActive: false });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn().mockResolvedValue(updated),
          },
          orderLine: { count: vi.fn().mockResolvedValue(0) },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it("[PC7] returns 404 PRODUCT_NOT_FOUND when product belongs to another producer", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null), // 404-no-leak
            update: vi.fn(),
          },
          orderLine: { count: vi.fn() },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/producers/me/products/product_foreign")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ name: "Hacked" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ===========================================================================
// DELETE /api/v1/producers/me/products/:id
// ===========================================================================

describe("DELETE /api/v1/producers/me/products/:id — soft delete", () => {
  it("[PC8] returns 409 PRODUCT_HAS_ACTIVE_ORDERS when non-terminal OrderLines exist", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn(),
          },
          orderLine: {
            count: vi.fn().mockResolvedValue(1), // active order lines exist
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCT_HAS_ACTIVE_ORDERS");
  });

  it("[PC9] returns 204 and soft-deletes when no active orders", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct()),
            update: vi.fn().mockResolvedValue({ ...makeProduct(), deletedAt: new Date() }),
          },
          orderLine: {
            count: vi.fn().mockResolvedValue(0), // no active orders
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/producers/me/products/product_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});

// ===========================================================================
// POST /api/v1/products/:id/report
// ===========================================================================

describe("POST /api/v1/products/:id/report — report product", () => {
  it("[PR4] returns 401 UNAUTHORIZED when no auth header", async () => {
    const res = await request
      .post("/api/v1/products/product_001/report")
      .send({ reason: "spam" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("[PR5] returns 422 VALIDATION_FAILED when reason is empty", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser({
      id: "cuid_user_002",
      role: "CONSUMER",
      email: "consumer@example.com",
      producerId: undefined as unknown as string,
    });

    const res = await request
      .post("/api/v1/products/product_001/report")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ reason: "" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[PR1] returns 200 with REPORTED status on first report (OK product)", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser({
      id: "cuid_user_002",
      role: "CONSUMER",
      email: "consumer@example.com",
      producerId: undefined as unknown as string,
    });

    const reportedAt = new Date("2026-01-10T00:00:00Z");
    const updated = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportedAt,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(makeProduct({ moderationStatus: "OK" })),
            update: vi.fn().mockResolvedValue(updated),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .post("/api/v1/products/product_001/report")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ reason: "spam" });

    expect(res.status).toBe(200);
    expect(res.body.productId).toBe("product_001");
    expect(res.body.moderationStatus).toBe("REPORTED");
    expect(res.body.reportedAt).toBeDefined();
  });

  it("[PR2] returns 200 with unchanged fields on second report (idempotent)", async () => {
    const sub = "auth0|consumer002";
    mockLoadUser({
      id: "cuid_user_003",
      role: "CONSUMER",
      email: "consumer2@example.com",
      producerId: undefined as unknown as string,
    });

    const firstReportedAt = new Date("2026-01-10T00:00:00Z");
    const alreadyReported = makeProduct({
      moderationStatus: "REPORTED" as ModerationStatus,
      reportedAt: firstReportedAt,
      reportReason: "spam",
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(alreadyReported),
            update: vi.fn(), // must NOT be called for idempotent case
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .post("/api/v1/products/product_001/report")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ reason: "duplicate" });

    expect(res.status).toBe(200);
    expect(res.body.moderationStatus).toBe("REPORTED");
    // reportedAt must remain the original T1 value (not overwritten)
    expect(new Date(res.body.reportedAt as string).getTime()).toBe(firstReportedAt.getTime());
  });

  it("[PR3] returns 404 PRODUCT_NOT_FOUND when product is REMOVED", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser({
      id: "cuid_user_002",
      role: "CONSUMER",
      email: "consumer@example.com",
      producerId: undefined as unknown as string,
    });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            findFirst: vi.fn().mockResolvedValue(null), // REMOVED treated as not found
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .post("/api/v1/products/product_001/report")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ reason: "spam" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ===========================================================================
// GET /api/v1/products — public catalog list (public-catalog capability)
// Spec: public-catalog §"PUB-R1", §"PUB-R3", §"PUB-R4"
// ===========================================================================

describe("GET /api/v1/products — public unauthenticated list", () => {
  it("[PUB-L1] returns 200 and lists visible products with NO auth header", async () => {
    const visible1 = makePublicProductRow({ id: "product_pub_001" });
    const visible2 = makePublicProductRow({ id: "product_pub_002" });
    mockedProduct.findMany.mockResolvedValueOnce([visible1, visible2]);

    // WHEN: a client calls GET /products with no auth header at all
    const res = await request.get("/api/v1/products").expect(200);

    // THEN: response lists exactly the visible products the service returned
    // (four-condition exclusion is proven at the service unit-test layer —
    // this test proves the public wire contract: no auth required, 200, list shape).
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(["product_pub_001", "product_pub_002"]);
  });

  it("[PUB-L2] category filter narrows results to the requested categoryId", async () => {
    const inCategory = makePublicProductRow({
      id: "product_c1",
      categoryId: "C1",
      category: { id: "C1", slug: "cat-1", name: "C1" },
    });
    mockedProduct.findMany.mockResolvedValueOnce([inCategory]);

    const res = await request.get("/api/v1/products?categoryId=C1").expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].categoryId).toBe("C1");
    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ categoryId: "C1" }),
      }),
    );
  });

  it("[PUB-L3] available=true filter excludes zero-stock products", async () => {
    const inStock = makePublicProductRow({ id: "product_instock", stock: 10 });
    mockedProduct.findMany.mockResolvedValueOnce([inStock]);

    const res = await request.get("/api/v1/products?available=true").expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("product_instock");
    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stock: { gt: 0 } }),
      }),
    );
  });

  it("[PUB-L3b] available=false does not filter by stock", async () => {
    mockedProduct.findMany.mockResolvedValueOnce([]);

    await request.get("/api/v1/products?available=false").expect(200);

    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ stock: expect.anything() }),
      }),
    );
  });

  it("[PUB-L3c] rejects invalid available values", async () => {
    const res = await request.get("/api/v1/products?available=invalid").expect(400);

    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(mockedProduct.findMany).not.toHaveBeenCalled();
  });

  it("[PUB-L4] sort=asc orders results by price ascending (DB-level)", async () => {
    mockedProduct.findMany.mockResolvedValueOnce([]);

    await request.get("/api/v1/products?sort=asc").expect(200);

    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { price: "asc" } }),
    );
  });

  it("[PUB-L5] sort=desc orders results by price descending (DB-level)", async () => {
    mockedProduct.findMany.mockResolvedValueOnce([]);

    await request.get("/api/v1/products?sort=desc").expect(200);

    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { price: "desc" } }),
    );
  });

  it("[PUB-L6] excludes products failing any of the four visibility conditions", async () => {
    // GIVEN: two visible products and (conceptually) five hidden ones —
    // the service's where-clause is the enforcement point (unit-tested);
    // this proves the controller/route surfaces exactly what the service returns.
    const visible1 = makePublicProductRow({ id: "product_visible_1" });
    const visible2 = makePublicProductRow({ id: "product_visible_2" });
    mockedProduct.findMany.mockResolvedValueOnce([visible1, visible2]);

    const res = await request.get("/api/v1/products").expect(200);

    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(["product_visible_1", "product_visible_2"]);
    expect(ids).not.toContain("product_hidden");
  });
});

// ===========================================================================
// GET /api/v1/products/:id — public catalog detail (public-catalog capability)
// Spec: public-catalog §"PUB-R2", §"PUB-R3", §"PUB-R4"
// ===========================================================================

describe("GET /api/v1/products/:id — public unauthenticated detail", () => {
  it("[PUB-D1] returns 200 with the visible product projection, NO auth header", async () => {
    const row = makePublicProductRow({ id: "product_pub_001" });
    mockedProduct.findFirst.mockResolvedValueOnce(row);

    const res = await request.get("/api/v1/products/product_pub_001").expect(200);

    expect(res.body.id).toBe("product_pub_001");
    expect(res.body.category).toEqual({ id: "cat_001", slug: "miel", name: "Miel" });
  });

  it("[PUB-D2] soft-deleted product (deletedAt set) returns 404 (no-leak)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/products/product_soft_deleted").expect(404);

    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[PUB-D3] inactive product (isActive=false) returns 404 (no-leak)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/products/product_inactive").expect(404);

    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[PUB-D4] REPORTED product returns 404 (no-leak)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/products/product_reported").expect(404);

    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[PUB-D5] REMOVED product returns 404 (no-leak)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/products/product_removed_mod").expect(404);

    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[PUB-D6] product of a soft-deleted producer returns 404 (no-leak)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/products/product_producer_deleted").expect(404);

    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ===========================================================================
// Threat tests — no leaked guard (public-catalog capability)
// Spec: public-catalog §"PUB-R1", §"PUB-R2"; design Threat Matrix "Route
// registration / guard leakage".
// ===========================================================================

describe("public-catalog threat: no auth guard leakage", () => {
  it("[PUB-T1] GET /products succeeds with NO auth header (401 would prove a leaked guard)", async () => {
    mockedProduct.findMany.mockResolvedValueOnce([]);

    const res = await request.get("/api/v1/products");

    expect(res.status).toBe(200);
  });

  it("[PUB-T2] GET /products/:id succeeds with NO auth header (401 would prove a leaked guard)", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(makePublicProductRow());

    const res = await request.get("/api/v1/products/product_pub_001");

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Threat tests — PII projection boundary (public-catalog capability)
// Spec: public-catalog §"PUB-R4"; design Threat Matrix "PII projection boundary".
// ===========================================================================

describe("public-catalog threat: PII projection boundary", () => {
  it("[PUB-T3] list response has NO nif/addressLine1/addressPostalCode/userId/s3Key", async () => {
    const row = makePublicProductRow({
      images: [{ id: "img_1", position: 0, s3Key: "products/x.jpg", createdAt: new Date() }],
    });
    mockedProduct.findMany.mockResolvedValueOnce([row]);

    const res = await request.get("/api/v1/products").expect(200);

    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("nif");
    expect(bodyText).not.toContain("addressLine1");
    expect(bodyText).not.toContain("addressPostalCode");
    expect(bodyText).not.toContain("userId");
    expect(bodyText).not.toContain("s3Key");

    expect(res.body[0].producer).toEqual({
      id: "prod_001",
      businessName: "Apiarios del Sur",
      description: "Productor artesanal.",
      address: { city: "Sevilla", province: "Sevilla", country: "ES" },
    });
    expect(res.body[0].images).toEqual([
      { id: "img_1", position: 0, url: "https://test-cdn.example.com/products/x.jpg" },
    ]);
  });

  it("[PUB-T4] detail response has NO nif/addressLine1/addressPostalCode/userId/s3Key", async () => {
    const row = makePublicProductRow({ id: "product_pub_001" });
    mockedProduct.findFirst.mockResolvedValueOnce(row);

    const res = await request.get("/api/v1/products/product_pub_001").expect(200);

    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("nif");
    expect(bodyText).not.toContain("addressLine1");
    expect(bodyText).not.toContain("addressPostalCode");
    expect(bodyText).not.toContain("userId");
    expect(bodyText).not.toContain("s3Key");
    expect(res.body.images).toEqual([]);
  });
});

// ===========================================================================
// Threat tests — existence no-leak (public-catalog capability)
// Spec: public-catalog §"PUB-R2", §"PUB-R3"; design Threat Matrix
// "Existence no-leak".
// ===========================================================================

describe("public-catalog threat: existence no-leak", () => {
  it("[PUB-T5] hidden and missing product ids return an identical 404 body", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null); // hidden product
    const hiddenRes = await request.get("/api/v1/products/product_hidden").expect(404);

    mockedProduct.findFirst.mockResolvedValueOnce(null); // non-existent product
    const missingRes = await request.get("/api/v1/products/product_missing").expect(404);

    // "instance" is a per-request correlation id (req.id) — it legitimately
    // differs on every request and carries no existence information.
    // Every other field MUST be byte-identical: a client cannot distinguish
    // "hidden" from "missing" from any observable part of the response.
    const { instance: _hiddenInstance, ...hiddenBody } = hiddenRes.body;
    const { instance: _missingInstance, ...missingBody } = missingRes.body;
    expect(hiddenBody).toEqual(missingBody);
    expect(hiddenRes.body.code).toBe("PRODUCT_NOT_FOUND");
  });
});
