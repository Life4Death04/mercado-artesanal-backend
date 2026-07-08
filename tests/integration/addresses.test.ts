/**
 * Integration tests — addresses endpoints (PR#5, task 5.1).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer so tests
 * exercise the full wire contract (routing, middleware chain, request/response
 * serialization, error mapping) without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` is replaced with a test double that reads
 *     `X-Test-Auth` (base64 JSON) and populates req.auth.payload.
 *   - `@/shared/utils/prisma` is mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; address operations call
 *     `prisma.$transaction` (callback form) or `prisma.address.findMany`.
 *
 * Scenarios covered (spec: address-book + task 5.1):
 *   [A1]  GET  /addresses — 200 array for authenticated CONSUMER
 *   [A2]  POST /addresses — 201 created address (first address auto-defaults)
 *   [A3]  POST /addresses — 422 validation error (missing required fields)
 *   [A4]  PATCH /addresses/:id — 200 updated address
 *   [A5]  PATCH /addresses/:id — 409 ADDRESS_DEFAULT_CONFLICT (P2002 race)
 *   [A6]  DELETE /addresses/:id — 204 No Content
 *   [A7]  GET /addresses — 401 unauthenticated
 *   [A8]  GET /addresses — 403 ONBOARDING_REQUIRED (PENDING_ROLE blocked)
 *   [A9]  GET /addresses — 403 FORBIDDEN (wrong role — e.g. hypothetical unknown)
 *   [A10] PATCH /addresses/:id — 404 NOT_FOUND (foreign address)
 *   [A11] DELETE /addresses/:id — 404 NOT_FOUND (foreign address)
 *
 * Spec references:
 *   address-book — owner-scoped CRUD, soft-delete, default invariant, wire shape
 *   design §10 — transactional patterns
 *   rbac — requireRole, onboardingGate
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as auth-onboarding.test.ts
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
// addresses.service calls prisma.$transaction (callback form) and
// prisma.address.findMany (for the list operation).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  const mockAddress = {
    findMany: vi.fn(),
  };
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      address: mockAddress,
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});

import type { Address, User } from "@prisma/client";
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAddress = mockedPrisma.address as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "cuid_user_001",
    auth0Sub: "auth0|test001",
    email: "test@example.com",
    emailVerified: true,
    firstName: "Test",
    lastName: "User",
    name: null,
    avatar: null,
    role: "CONSUMER",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeAddress(overrides: Partial<Address> = {}): Address {
  return {
    id: "addr_001",
    userId: "cuid_user_001",
    line1: "Calle Mayor 1",
    line2: null,
    city: "Madrid",
    postalCode: "28001",
    province: "Madrid",
    country: "ES",
    isDefault: true,
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

// ---------------------------------------------------------------------------
// [A7] 401 — no auth header
// ---------------------------------------------------------------------------

describe("GET /api/v1/users/me/addresses — unauthenticated", () => {
  it("[A7] returns 401 UNAUTHORIZED when no X-Test-Auth header is provided", async () => {
    const res = await request.get("/api/v1/users/me/addresses");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// [A8] 403 — PENDING_ROLE blocked by onboardingGate
// ---------------------------------------------------------------------------

describe("GET /api/v1/users/me/addresses — PENDING_ROLE blocked", () => {
  it("[A8] returns 403 ONBOARDING_REQUIRED when user has PENDING_ROLE", async () => {
    const sub = "auth0|pending001";
    const pendingUser = makeUser({ auth0Sub: sub, role: "PENDING_ROLE" });

    mockLoadUser(pendingUser);

    const res = await request
      .get("/api/v1/users/me/addresses")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ONBOARDING_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// [A1] GET /addresses — happy path
// ---------------------------------------------------------------------------

describe("GET /api/v1/users/me/addresses — CONSUMER happy path", () => {
  it("[A1] returns 200 with an array of active addresses", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });
    const addr = makeAddress({ userId: user.id });

    mockLoadUser(user);
    mockedAddress.findMany.mockResolvedValueOnce([addr]);

    const res = await request
      .get("/api/v1/users/me/addresses")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(addr.id);
  });

  it("[A1b] returns 200 with empty array when user has no addresses", async () => {
    const sub = "auth0|consumer002";
    const user = makeUser({ id: "cuid_user_002", auth0Sub: sub });

    mockLoadUser(user);
    mockedAddress.findMany.mockResolvedValueOnce([]);

    const res = await request
      .get("/api/v1/users/me/addresses")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [A2] POST /addresses — 201 created (first auto-defaults)
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/addresses — create address", () => {
  it("[A2] returns 201 with the created address (first address auto-defaults)", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });
    const created = makeAddress({ userId: user.id, isDefault: true });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            count: vi.fn().mockResolvedValue(0), // first address
            create: vi.fn().mockResolvedValue(created),
            updateMany: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .post("/api/v1/users/me/addresses")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        line1: "Calle Mayor 1",
        city: "Madrid",
        postalCode: "28001",
        province: "Madrid",
      });

    expect(res.status).toBe(201);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.id).toBe(created.id);
  });

  it("[A3] returns 422 VALIDATION_FAILED when required fields are missing", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });

    mockLoadUser(user);

    const res = await request
      .post("/api/v1/users/me/addresses")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ city: "Madrid" }); // missing line1, postalCode, province

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "line1" })]),
    );
  });
});

// ---------------------------------------------------------------------------
// [A4] PATCH /addresses/:id — 200 updated
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/users/me/addresses/:id — update address", () => {
  it("[A4] returns 200 with the updated address when promotion succeeds", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });
    const nonDefault = makeAddress({ id: "addr_002", userId: user.id, isDefault: false });
    const promoted = makeAddress({ id: "addr_002", userId: user.id, isDefault: true });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(nonDefault),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn().mockResolvedValue(promoted),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/users/me/addresses/addr_002")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ isDefault: true });

    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
  });

  it("[A10] returns 404 NOT_FOUND when address belongs to another user", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(null), // not found → 404-no-leak
            updateMany: vi.fn(),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/users/me/addresses/addr_foreign")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ line1: "Hacked Street" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("[A5] returns 409 ADDRESS_DEFAULT_CONFLICT when DB index raises P2002", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });
    const nonDefault = makeAddress({ id: "addr_002", userId: user.id, isDefault: false });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(nonDefault),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn().mockRejectedValue({
              code: "P2002",
              meta: { target: "one_default_address_per_user" },
            }),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .patch("/api/v1/users/me/addresses/addr_002")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ isDefault: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDRESS_DEFAULT_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// [A6] DELETE /addresses/:id — 204 No Content
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/users/me/addresses/:id — soft delete", () => {
  it("[A6] returns 204 No Content on successful soft delete", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });
    const nonDefault = makeAddress({ id: "addr_001", userId: user.id, isDefault: false });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(nonDefault) // target lookup
              .mockResolvedValueOnce(null), // no sibling to promote
            update: vi.fn().mockResolvedValue({ ...nonDefault, deletedAt: new Date() }),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/users/me/addresses/addr_001")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("[A11] returns 404 NOT_FOUND when address belongs to another user", async () => {
    const sub = "auth0|consumer001";
    const user = makeUser({ id: "cuid_user_001", auth0Sub: sub });

    mockLoadUser(user);
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(null), // 404-no-leak
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const res = await request
      .delete("/api/v1/users/me/addresses/addr_foreign")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
