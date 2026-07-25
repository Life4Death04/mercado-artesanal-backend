/**
 * Integration tests — cart endpoints (cycle-3/cart).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer so tests
 * exercise the full wire contract (routing, middleware chain, request/response
 * serialization, error mapping) without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` is replaced with a test double that reads
 *     `X-Test-Auth` (base64 JSON) and populates req.auth.payload.
 *   - `@/shared/utils/prisma` is mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`.
 *
 * PR #1 Scenarios covered (spec: cart §R7 + middleware chain):
 *   [C-AUTH-1] GET /carrito — 401 when no Authorization header
 *   [C-AUTH-2] POST /carrito/items — 401 when no Authorization header
 *   [C-AUTH-3] PATCH /carrito/items/:itemId — 401 when no Authorization header
 *   [C-AUTH-4] DELETE /carrito/items/:itemId — 401 when no Authorization header
 *   [C-AUTH-5] DELETE /carrito — 401 when no Authorization header
 *   [C-ONBOARD-1] GET /carrito — 403 ONBOARDING_REQUIRED when user is PENDING_ROLE
 *   [C-ONBOARD-2] POST /carrito/items — 403 ONBOARDING_REQUIRED when user is PENDING_ROLE
 *   [C-ONBOARD-3] PATCH /carrito/items/:itemId — 403 ONBOARDING_REQUIRED when user is PENDING_ROLE
 *   [C-ONBOARD-4] DELETE /carrito/items/:itemId — 403 ONBOARDING_REQUIRED when user is PENDING_ROLE
 *   [C-ONBOARD-5] DELETE /carrito — 403 ONBOARDING_REQUIRED when user is PENDING_ROLE
 *
 * PR #2 Scenarios covered (spec §R2 GET, §R1/§R3 POST):
 *   [C-GET-1] GET /carrito — 200 synthetic empty view when no Cart row exists
 *   [C-GET-2] GET /carrito — 200 populated view with computed isAvailable
 *   [C-POST-1] POST /carrito/items — 201 on successful add (new item)
 *   [C-POST-2] POST /carrito/items — 409 PRODUCT_INACTIVE when product is inactive
 *   [C-POST-3] POST /carrito/items — 422 QUANTITY_EXCEEDS_STOCK when quantity > stock
 *   [C-POST-4] POST /carrito/items — 422 VALIDATION_FAILED on malformed body (Zod)
 *
 * PR #3 scenarios (PATCH, DELETE handlers) remain stubs — NOT tested here.
 *
 * Spec references:
 *   cart §R7 "All endpoints require authenticated, onboarded users with a completed role"
 *   cart §"Scenario: Missing JWT returns 401"
 *   cart §"Scenario: Empty cart returns 200 with empty items"
 *   cart §"Scenario: Adding a new product writes the live price into snapshot"
 *   cart §"Scenario: Adding an inactive product is rejected"
 *   cart §"Scenario: Quantity exceeding live stock is rejected"
 *   cart §API Contracts — full middleware chain: authenticate → loadUser → onboardingGate → requireRole
 *   design — Data Flow, guard chain verified against addresses.routes.ts:33 precedent
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — matches the established repo pattern
// (see addresses.test.ts, auth-onboarding.test.ts)
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
//
// loadUser calls prisma.user.findUnique (select projection).
// Cart service stubs do not call prisma yet (PR #2/#3 will extend this mock).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      cart: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      cartItem: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      product: {
        findUnique: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});


import type { User } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// `vi.mocked()` preserves the real Prisma delegate signatures, which are not
// recognized as Mock instances by TS — cast at the delegate level (matches
// tests/unit/producers.service.test.ts / sub-orders.read.service.test.ts).
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCart = mockedPrisma.cart as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProduct = mockedPrisma.product as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedTransaction = mockedPrisma.$transaction as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "cuid_cart_user_001",
    auth0Sub: "auth0|cart-test001",
    email: "cart-test@example.com",
    emailVerified: true,
    firstName: "Cart",
    lastName: "TestUser",
    name: null,
    avatar: null,
    role: "CONSUMER",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Configure prisma.user.findUnique to return a user projection for loadUser.
 * Call BEFORE each test that needs an authenticated user.
 */
function mockLoadUser(user: User | null): void {
  const projection = user ? { id: user.id, role: user.role, email: user.email } : null;
  mockedUser.findUnique.mockResolvedValueOnce(projection);
}

function makeProducer(overrides: Record<string, unknown> = {}) {
  return {
    id: "producer_cart_001",
    userId: "user_producer_cart_001",
    businessName: "Cart Test Producer",
    nif: "B12345674",
    description: "A test producer",
    addressLine1: "Calle Test 1",
    addressLine2: null,
    addressCity: "Madrid",
    addressPostalCode: "28001",
    addressProvince: "Madrid",
    addressCountry: "ES",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_cart_001",
    producerId: "producer_cart_001",
    categoryId: "cat_cart_001",
    name: "Aceite de Oliva",
    description: "Aceite artesanal.",
    price: new Decimal("12.50"),
    stock: 10,
    lowStockThreshold: 5,
    isActive: true,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    reportedAt: null,
    moderationStatus: "OK",
    reportReason: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    producer: makeProducer(),
    ...overrides,
  };
}

function makeCartItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_cart_001",
    cartId: "cart_cart_001",
    productId: "product_cart_001",
    quantity: 2,
    unitPriceSnapshot: new Decimal("12.50"),
    createdAt: new Date("2026-01-02T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    product: makeProduct(),
    ...overrides,
  };
}

function makeCart(overrides: Record<string, unknown> = {}) {
  return {
    id: "cart_cart_001",
    userId: "cuid_cart_user_001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    items: [] as unknown[],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Auth claim builder
// ---------------------------------------------------------------------------

function consumerClaim(sub = "auth0|cart-test001"): Record<string, unknown> {
  return { sub, "https://mercado-artesanal.com/email": "cart-test@example.com" };
}

// ---------------------------------------------------------------------------
// App + request
// ---------------------------------------------------------------------------

const app = createApp();
const request = supertest(app);

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// [C-AUTH] Missing JWT returns 401 on every cart endpoint (spec §R7-S1)
// ---------------------------------------------------------------------------

describe("Cart endpoints — 401 on missing JWT", () => {
  it("[C-AUTH-1] GET /api/v1/carrito — 401 when no Authorization header", async () => {
    const res = await request.get("/api/v1/carrito");
    expect(res.status).toBe(401);
  });

  it("[C-AUTH-2] POST /api/v1/carrito/items — 401 when no Authorization header", async () => {
    const res = await request.post("/api/v1/carrito/items").send({ productId: "abc", quantity: 1 });
    expect(res.status).toBe(401);
  });

  it("[C-AUTH-3] PATCH /api/v1/carrito/items/some-item-id — 401 when no Authorization header", async () => {
    const res = await request
      .patch("/api/v1/carrito/items/some-item-id")
      .send({ quantity: 2 });
    expect(res.status).toBe(401);
  });

  it("[C-AUTH-4] DELETE /api/v1/carrito/items/some-item-id — 401 when no Authorization header", async () => {
    const res = await request.delete("/api/v1/carrito/items/some-item-id");
    expect(res.status).toBe(401);
  });

  it("[C-AUTH-5] DELETE /api/v1/carrito — 401 when no Authorization header", async () => {
    const res = await request.delete("/api/v1/carrito");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// [C-ONBOARD] PENDING_ROLE user blocked with 403 ONBOARDING_REQUIRED (spec §R7)
// ---------------------------------------------------------------------------

describe("Cart endpoints — 403 ONBOARDING_REQUIRED for PENDING_ROLE user", () => {
  it("[C-ONBOARD-1] GET /api/v1/carrito — 403 when user is PENDING_ROLE", async () => {
    const pendingUser = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(pendingUser);

    const res = await request
      .get("/api/v1/carrito")
      .set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
  });

  it("[C-ONBOARD-2] POST /api/v1/carrito/items — 403 when user is PENDING_ROLE", async () => {
    const pendingUser = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(pendingUser);

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "some-product-id", quantity: 1 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
  });

  it("[C-ONBOARD-3] PATCH /api/v1/carrito/items/:itemId — 403 when user is PENDING_ROLE", async () => {
    const pendingUser = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(pendingUser);

    const res = await request
      .patch("/api/v1/carrito/items/some-product-id")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ quantity: 2 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
  });

  it("[C-ONBOARD-4] DELETE /api/v1/carrito/items/:itemId — 403 when user is PENDING_ROLE", async () => {
    const pendingUser = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(pendingUser);

    const res = await request
      .delete("/api/v1/carrito/items/some-product-id")
      .set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
  });

  it("[C-ONBOARD-5] DELETE /api/v1/carrito — 403 when user is PENDING_ROLE", async () => {
    const pendingUser = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(pendingUser);

    const res = await request
      .delete("/api/v1/carrito")
      .set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ONBOARDING_REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
// [C-GET] GET /carrito — real behavior (PR #2)
// ---------------------------------------------------------------------------

describe("GET /api/v1/carrito — real behavior (PR #2)", () => {
  it("[C-GET-1] returns 200 with synthetic empty view when the user has no Cart row", async () => {
    const user = makeUser();
    mockLoadUser(user);
    mockedCart.findUnique.mockResolvedValueOnce(null);

    const res = await request.get("/api/v1/carrito").set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: null,
      userId: user.id,
      items: [],
      createdAt: null,
      updatedAt: null,
    });
  });

  it("[C-GET-2] returns 200 with populated items and computed isAvailable", async () => {
    const user = makeUser();
    mockLoadUser(user);
    const cart = makeCart({ userId: user.id, items: [makeCartItem()] });
    mockedCart.findUnique.mockResolvedValueOnce(cart);

    const res = await request.get("/api/v1/carrito").set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cart_cart_001");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      productId: "product_cart_001",
      quantity: 2,
      unitPriceSnapshot: "12.50",
      isAvailable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// [C-POST] POST /carrito/items — real behavior (PR #2)
// ---------------------------------------------------------------------------

describe("POST /api/v1/carrito/items — real behavior (PR #2)", () => {
  it("[C-POST-1] returns 201 and snapshots the live price on a successful add", async () => {
    const user = makeUser();
    mockLoadUser(user);
    const product = makeProduct({ price: new Decimal("12.50"), stock: 10 });
    mockedProduct.findUnique.mockResolvedValueOnce(product);

    const cartUpsert = vi.fn().mockResolvedValue({ id: "cart_cart_001", userId: user.id });
    const cartItemFindUnique = vi.fn().mockResolvedValue(null);
    const cartItemUpsert = vi
      .fn()
      .mockResolvedValue(makeCartItem({ quantity: 2, unitPriceSnapshot: new Decimal("12.50"), product }));
    mockedTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        cart: { upsert: cartUpsert },
        cartItem: { findUnique: cartItemFindUnique, upsert: cartItemUpsert },
      }),
    );

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "product_cart_001", quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      productId: "product_cart_001",
      quantity: 2,
      unitPriceSnapshot: "12.50",
    });
  });

  it("[C-POST-2] returns 409 PRODUCT_INACTIVE when the product is inactive", async () => {
    const user = makeUser();
    mockLoadUser(user);
    mockedProduct.findUnique.mockResolvedValueOnce(makeProduct({ isActive: false }));

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "product_cart_001", quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({ code: "PRODUCT_INACTIVE" });
  });

  it("[C-POST-3] returns 422 QUANTITY_EXCEEDS_STOCK when quantity exceeds live stock", async () => {
    const user = makeUser();
    mockLoadUser(user);
    mockedProduct.findUnique.mockResolvedValueOnce(makeProduct({ stock: 3, isActive: true }));

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "product_cart_001", quantity: 5 });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "QUANTITY_EXCEEDS_STOCK" });
  });

  it("[C-POST-4] returns 422 VALIDATION_FAILED on malformed body (Zod, quantity < 1)", async () => {
    const user = makeUser();
    mockLoadUser(user);

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "product_cart_001", quantity: 0 });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    // Product lookup must NOT happen — Zod validation runs before service call
    expect(mockedProduct.findUnique).not.toHaveBeenCalled();
  });

  it("[C-POST-5] returns 404 NOT_FOUND when productId does not resolve (unknown, or soft-deleted product/producer)", async () => {
    const user = makeUser();
    mockLoadUser(user);
    // Simulates the real DB query (scoped to deletedAt: null on product + producer)
    // returning no row — covers unknown productId AND soft-deleted product/producer.
    mockedProduct.findUnique.mockResolvedValueOnce(null);

    const res = await request
      .post("/api/v1/carrito/items")
      .set("x-test-auth", authHeader(consumerClaim()))
      .send({ productId: "does-not-exist", quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(mockedTransaction).not.toHaveBeenCalled();
  });
});
