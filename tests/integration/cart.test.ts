/**
 * Integration tests — cart endpoints (cycle-3/cart, PR #1 foundation harness).
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
 *   [C-STUB-1] GET /carrito — 501 NOT_IMPLEMENTED when auth passes (stub handler, PR #1)
 *
 * PR #2/#3 scenarios (GET behavior, POST, PATCH, DELETE handlers) are NOT tested here.
 * This file exists so PR #2/#3 can add tests immediately in the correct location.
 *
 * Spec references:
 *   cart §R7 "All endpoints require authenticated, onboarded users with a completed role"
 *   cart §"Scenario: Missing JWT returns 401"
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
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;

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
});

// ---------------------------------------------------------------------------
// [C-STUB] Auth passes → 501 NOT_IMPLEMENTED (PR #1 stub policy — design suggestion #2)
// These tests prove the middleware chain is fully wired and the router is mounted.
// PR #2 will replace them with real behavior assertions.
// ---------------------------------------------------------------------------

describe("Cart endpoints — 501 stub when auth passes (PR #1 wiring proof)", () => {
  it("[C-STUB-1] GET /api/v1/carrito — 501 when authenticated CONSUMER (stub handler)", async () => {
    const user = makeUser();
    mockLoadUser(user);

    const res = await request
      .get("/api/v1/carrito")
      .set("x-test-auth", authHeader(consumerClaim()));

    expect(res.status).toBe(501);
  });
});
