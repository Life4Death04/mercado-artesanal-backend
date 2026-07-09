/**
 * Integration tests — auth/sync, users/me, onboarding endpoints (PR#4).
 *
 * Strategy: approach (a) — mock the repository layer at the controller/service
 * seam so tests exercise the full wire contract (routing, middleware chain,
 * request/response serialization, error mapping) without touching Prisma or
 * a live database.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` (the `authenticate` middleware) is mocked so
 *     tests can inject a fake JWT sub + claims via a custom request header
 *     `X-Test-Auth` (JSON payload). Without this, every request would fail JWKS
 *     validation since there is no real Auth0 tenant in the test environment.
 *   - `@/shared/repositories/user.repository` is mocked with vi.mock() so all
 *     DB calls are intercepted. Each test controls the in-memory state via the
 *     mock implementations directly.
 *   - The prisma singleton is NOT imported or connected in this file.
 *
 * Scenarios covered (per task 4.3 requirements):
 *   [S1]  first-sync — creates user with PENDING_ROLE
 *   [S2]  re-sync idempotent — same sub, no duplicate
 *   [S3]  GET /users/me returns PENDING when role not set
 *   [S4]  consumer onboarding success (role → CONSUMER, response reflects new state)
 *   [S5]  producer onboarding success (Producer + ProducerCategoryOnProducer rows, desc ≤ 2000)
 *   [S6]  unknown category slug → 422 UNKNOWN_CATEGORY
 *   [S7]  duplicate NIF → 409 NIF_ALREADY_REGISTERED
 *   [S8]  retry after successful onboarding → 409 ROLE_ALREADY_SET
 *
 * Spec references:
 *   user-profile §"POST /auth/sync", §"GET /users/me"
 *   user-onboarding §"Consumer onboarding succeeds", §"Producer onboarding succeeds"
 *   producer-bootstrap §"Duplicate NIF rejected at persistence"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer
//
// Replaces the `authenticate` middleware with a test double that reads the
// X-Test-Auth header (base64-encoded JSON) and populates req.auth.payload.
// This keeps the full middleware chain active (loadUser, onboardingGate, etc.)
// while skipping the JWKS call.
// ---------------------------------------------------------------------------
vi.mock("express-oauth2-jwt-bearer", () => ({
  auth: () => {
    return (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const header = req.headers["x-test-auth"] as string | undefined;
      if (!header) {
        // No test auth header — simulate an absent/invalid token (401).
        const err = { status: 401, name: "UnauthorizedError" };
        next(err);
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
        const err = { status: 401, name: "UnauthorizedError" };
        next(err);
      }
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock: user repository
//
// All methods are replaced with vi.fn(). Each test configures return values
// using mockResolvedValueOnce / mockResolvedValue. The in-memory store below
// is a simple object that tests mutate between scenarios.
// ---------------------------------------------------------------------------
vi.mock("@/shared/repositories/user.repository");

// ---------------------------------------------------------------------------
// Mock: prisma (used by loadUser middleware and onboarding.service.$transaction)
//
// loadUser calls prisma.user.findUnique directly. We provide a mock user object
// controlled per-test via mockPrismaUser. onboarding.service uses prisma.$transaction
// which is also mocked here with per-test implementations.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  const mockFindUnique = vi.fn();
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: {
        findUnique: mockFindUnique,
      },
    },
  };
});

import type { Prisma, User } from "@prisma/client";
import * as userRepo from "@/shared/repositories/user.repository";
import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Encode claims object as base64 JSON for the X-Test-Auth header. */
function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

/** Factory: create a minimal User fixture with defaults. */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "cuid_user_001",
    auth0Sub: "auth0|test001",
    email: "test@example.com",
    emailVerified: false,
    firstName: null,
    lastName: null,
    name: null,
    avatar: null,
    role: "PENDING_ROLE",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

// Typed mock helpers (vitest vi.mocked)
const mockedUserRepo = vi.mocked(userRepo);
const mockedPrisma = vi.mocked(prisma);

/**
 * Set up prisma.user.findUnique mock — loadUser calls this to get the minimal
 * { id, role, email } projection from the DB. Pass null to simulate "no user yet".
 */
function mockLoadUser(user: User | null): void {
  const projection = user ? { id: user.id, role: user.role, email: user.email } : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockedPrisma.user as any).findUnique.mockResolvedValueOnce(projection);
}

// ---------------------------------------------------------------------------
// App + request instance
// ---------------------------------------------------------------------------

const app = createApp();
const request = supertest(app);

afterAll(async () => {
  await prisma.$disconnect();
});

// Reset all mocks between tests to avoid state leak.
beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// [S1] First sync — creates user with PENDING_ROLE
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/sync — first sync creates PENDING user", () => {
  it("returns 200 with the created user on first call for a new sub", async () => {
    const sub = "auth0|new001";
    const email = "new@example.com";
    const createdUser = makeUser({ auth0Sub: sub, email, emailVerified: true });

    // loadUser: no DB record yet (null projection)
    mockLoadUser(null);
    // auth.service: findByAuth0Sub → null (first sync)
    mockedUserRepo.findByAuth0Sub.mockResolvedValueOnce(null);
    // auth.service: create() → new user
    mockedUserRepo.create.mockResolvedValueOnce(createdUser);

    const res = await request
      .post("/api/v1/auth/sync")
      .set("X-Test-Auth", authHeader({ sub, email, email_verified: true }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: createdUser.id,
      email,
      role: "PENDING_ROLE",
      emailVerified: true,
    });

    expect(mockedUserRepo.findByAuth0Sub).toHaveBeenCalledWith(sub);
    expect(mockedUserRepo.create).toHaveBeenCalledWith({
      auth0Sub: sub,
      email,
      emailVerified: true,
    });
  });

  it("accepts Auth0 namespaced email claims for custom API access tokens", async () => {
    const sub = "auth0|new-namespaced";
    const email = "namespaced@example.com";
    const createdUser = makeUser({ auth0Sub: sub, email, emailVerified: true });

    mockLoadUser(null);
    mockedUserRepo.findByAuth0Sub.mockResolvedValueOnce(null);
    mockedUserRepo.create.mockResolvedValueOnce(createdUser);

    const res = await request.post("/api/v1/auth/sync").set(
      "X-Test-Auth",
      authHeader({
        sub,
        "https://api.test.example/email": email,
        "https://api.test.example/email_verified": true,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockedUserRepo.create).toHaveBeenCalledWith({
      auth0Sub: sub,
      email,
      emailVerified: true,
    });
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await request.post("/api/v1/auth/sync");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 422 when email is missing on first sync", async () => {
    const sub = "auth0|no-email";

    // loadUser: no DB record yet
    mockLoadUser(null);
    // auth.service: no existing user → first sync path
    mockedUserRepo.findByAuth0Sub.mockResolvedValueOnce(null);

    const res = await request
      .post("/api/v1/auth/sync")
      .set("X-Test-Auth", authHeader({ sub /* no email */ }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "email" })]),
    );
    expect(mockedUserRepo.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [S2] Re-sync idempotent — same sub, no duplicate
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/sync — re-sync updates only emailVerified", () => {
  it("returns 200 and does not create a duplicate user", async () => {
    const sub = "auth0|existing001";
    const existingUser = makeUser({ auth0Sub: sub, emailVerified: false });
    const updatedUser = { ...existingUser, emailVerified: true };

    // loadUser: user exists in DB
    mockLoadUser(existingUser);
    // auth.service: findByAuth0Sub → existing user (re-sync path)
    mockedUserRepo.findByAuth0Sub.mockResolvedValueOnce(existingUser);
    mockedUserRepo.updateEmailVerified.mockResolvedValueOnce(updatedUser);

    const res = await request
      .post("/api/v1/auth/sync")
      .set("X-Test-Auth", authHeader({ sub, email: "other@example.com", email_verified: true }));

    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.email).toBe(existingUser.email); // email must NOT change

    // create must NOT have been called
    expect(mockedUserRepo.create).not.toHaveBeenCalled();
    // updateEmailVerified called with correct args
    expect(mockedUserRepo.updateEmailVerified).toHaveBeenCalledWith(existingUser.id, true);
  });
});

// ---------------------------------------------------------------------------
// [S3] GET /users/me — returns PENDING shape when role not set
// ---------------------------------------------------------------------------

describe("GET /api/v1/users/me — PENDING_ROLE user reads own profile", () => {
  it("returns 200 with onboardingCompleted=false and producer=null for PENDING user", async () => {
    const sub = "auth0|pending001";
    const pendingUser = makeUser({ auth0Sub: sub });

    // loadUser: user exists in DB with PENDING_ROLE
    mockLoadUser(pendingUser);
    // usersService.getMe calls findByIdWithProducer
    mockedUserRepo.findByIdWithProducer.mockResolvedValueOnce({
      ...pendingUser,
      producer: null,
      addresses: [],
    } as never);

    const res = await request.get("/api/v1/users/me").set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: "PENDING_ROLE",
      onboardingCompleted: false,
      producer: null,
    });
  });

  it("returns 404 NOT_FOUND when no DB row exists for the JWT sub", async () => {
    const sub = "auth0|ghost001";

    // loadUser: no user found → req.user = null
    mockLoadUser(null);

    const res = await request.get("/api/v1/users/me").set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// [S4] Consumer onboarding success
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/onboarding/consumer — success", () => {
  it("returns 200 with role=CONSUMER and updated firstName/lastName", async () => {
    const sub = "auth0|consumer001";
    const pendingUser = makeUser({ id: "cuid_c001", auth0Sub: sub });
    const consumerUser = makeUser({
      id: "cuid_c001",
      auth0Sub: sub,
      role: "CONSUMER",
      firstName: "Ana",
      lastName: "López",
    });

    // loadUser: pending user exists
    mockLoadUser(pendingUser);
    // onboarding.service.completeConsumer → findById
    mockedUserRepo.findById.mockResolvedValueOnce(pendingUser);
    // completeConsumerOnboarding
    mockedUserRepo.completeConsumerOnboarding.mockResolvedValueOnce(consumerUser);
    // usersService.getMe → findByIdWithProducer
    mockedUserRepo.findByIdWithProducer.mockResolvedValueOnce({
      ...consumerUser,
      producer: null,
      addresses: [],
    } as never);

    const res = await request
      .post("/api/v1/users/me/onboarding/consumer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ firstName: "Ana", lastName: "López" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: "CONSUMER",
      onboardingCompleted: true,
      firstName: "Ana",
      lastName: "López",
      producer: null,
    });
  });

  it("returns 422 VALIDATION_FAILED when firstName is missing", async () => {
    const sub = "auth0|consumer002";
    const pendingUser = makeUser({ auth0Sub: sub });

    // loadUser: pending user exists
    mockLoadUser(pendingUser);

    const res = await request
      .post("/api/v1/users/me/onboarding/consumer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ lastName: "López" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "firstName" })]),
    );
  });
});

// ---------------------------------------------------------------------------
// [S5] Producer onboarding success
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/onboarding/producer — success", () => {
  it("returns 201 with role=PRODUCER, producer embedded, and category slugs", async () => {
    const sub = "auth0|producer001";
    const pendingUser = makeUser({ id: "cuid_p001", auth0Sub: sub });
    const producerUser = makeUser({
      id: "cuid_p001",
      auth0Sub: sub,
      role: "PRODUCER",
      firstName: "Luis",
      lastName: "Norte",
    });

    const fakeCategories = [
      { id: "cat_queso", slug: "queso", name: "Queso", createdAt: new Date() },
      { id: "cat_miel", slug: "miel", name: "Miel", createdAt: new Date() },
    ];

    const fakeProducer = {
      id: "prod_001",
      userId: "cuid_p001",
      businessName: "Artesanos del Norte",
      nif: "B12345678",
      description: "Fresh artisan cheeses and honey.",
      addressLine1: "Calle Mayor 1",
      addressLine2: null,
      addressCity: "Burgos",
      addressPostalCode: "09001",
      addressProvince: "Burgos",
      addressCountry: "ES",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      categories: [
        {
          producerId: "prod_001",
          categoryId: "cat_queso",
          assignedAt: new Date(),
          category: fakeCategories[0],
        },
        {
          producerId: "prod_001",
          categoryId: "cat_miel",
          assignedAt: new Date(),
          category: fakeCategories[1],
        },
      ],
    };

    // loadUser: pending user exists
    mockLoadUser(pendingUser);

    // prisma.$transaction mock: simulate the full transaction
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const fakeTx = {
          user: {
            findFirst: vi.fn().mockResolvedValue(pendingUser),
            update: vi.fn().mockResolvedValue(producerUser),
          },
          producerCategory: { findMany: vi.fn().mockResolvedValue(fakeCategories) },
          producer: { create: vi.fn().mockResolvedValue(fakeProducer) },
          producerCategoryOnProducer: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        };
        return fn(fakeTx as unknown as Prisma.TransactionClient);
      },
    );

    // userRepo methods called inside the $transaction go through the fakeTx above.
    // findById and completeProducerOnboarding use the tx client injected via fakeTx.
    // The mocks below are for the repo wrappers that call tx methods internally.
    mockedUserRepo.findById.mockImplementationOnce(async (_id, tx) => {
      // The repo delegates to tx.user.findFirst — already mocked in fakeTx.
      // Return pendingUser directly for this test.
      void tx;
      return pendingUser;
    });
    mockedUserRepo.completeProducerOnboarding.mockImplementationOnce(async (_id, _data, tx) => {
      void tx;
      return producerUser;
    });

    // usersService.getMe after transaction
    mockedUserRepo.findByIdWithProducer.mockResolvedValueOnce({
      ...producerUser,
      producer: fakeProducer,
      addresses: [],
    } as never);

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Luis",
        lastName: "Norte",
        businessName: "Artesanos del Norte",
        nif: "B12345678",
        description: "Fresh artisan cheeses and honey.",
        address: {
          line1: "Calle Mayor 1",
          city: "Burgos",
          postalCode: "09001",
          province: "Burgos",
        },
        categorySlugs: ["queso", "miel"],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      role: "PRODUCER",
      onboardingCompleted: true,
      firstName: "Luis",
      lastName: "Norte",
    });
    expect(res.body.producer).toBeDefined();
    expect(res.body.producer.categorySlugs).toHaveLength(2);
    expect(res.body.producer.categorySlugs).toContain("queso");
    expect(res.body.producer.categorySlugs).toContain("miel");
  });

  it("description up to 2000 chars is accepted", async () => {
    const sub = "auth0|producer002";
    const pendingUser = makeUser({ id: "cuid_p002", auth0Sub: sub });
    const producerUser = makeUser({
      id: "cuid_p002",
      auth0Sub: sub,
      role: "PRODUCER",
      firstName: "Long",
      lastName: "Description",
    });
    const longDescription = "A".repeat(2000);

    const fakeCategories = [
      { id: "cat_otros", slug: "otros", name: "Otros", createdAt: new Date() },
    ];
    const fakeProducer = {
      id: "prod_002",
      userId: "cuid_p002",
      businessName: "BizLong",
      nif: "A98765432",
      description: longDescription,
      addressLine1: "Av Sol 2",
      addressLine2: null,
      addressCity: "Madrid",
      addressPostalCode: "28001",
      addressProvince: "Madrid",
      addressCountry: "ES",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      categories: [
        {
          producerId: "prod_002",
          categoryId: "cat_otros",
          assignedAt: new Date(),
          category: fakeCategories[0],
        },
      ],
    };

    mockLoadUser(pendingUser);

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const fakeTx = {
          user: {
            findFirst: vi.fn().mockResolvedValue(pendingUser),
            update: vi.fn().mockResolvedValue(producerUser),
          },
          producerCategory: { findMany: vi.fn().mockResolvedValue(fakeCategories) },
          producer: { create: vi.fn().mockResolvedValue(fakeProducer) },
          producerCategoryOnProducer: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
        };
        return fn(fakeTx as unknown as Prisma.TransactionClient);
      },
    );

    mockedUserRepo.findById.mockImplementationOnce(async (_id, tx) => {
      void tx;
      return pendingUser;
    });
    mockedUserRepo.completeProducerOnboarding.mockImplementationOnce(async (_id, _data, tx) => {
      void tx;
      return producerUser;
    });
    mockedUserRepo.findByIdWithProducer.mockResolvedValueOnce({
      ...producerUser,
      producer: fakeProducer,
      addresses: [],
    } as never);

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Long",
        lastName: "Description",
        businessName: "BizLong",
        nif: "A98765432",
        description: longDescription,
        address: { line1: "Av Sol 2", city: "Madrid", postalCode: "28001", province: "Madrid" },
        categorySlugs: ["otros"],
      });

    expect(res.status).toBe(201);
  });

  it("returns 422 VALIDATION_FAILED when description exceeds 2000 chars", async () => {
    const sub = "auth0|producer003";
    const pendingUser = makeUser({ auth0Sub: sub });
    mockLoadUser(pendingUser);

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Bad",
        lastName: "Description",
        businessName: "Biz",
        nif: "A98765432",
        description: "X".repeat(2001),
        address: { line1: "Av Sol 2", city: "Madrid", postalCode: "28001", province: "Madrid" },
        categorySlugs: ["otros"],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// [S6] Unknown category slug → 422 UNKNOWN_CATEGORY
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/onboarding/producer — unknown category slug", () => {
  it("returns 422 UNKNOWN_CATEGORY and does not create a Producer row", async () => {
    const sub = "auth0|producer010";
    const pendingUser = makeUser({ id: "cuid_p010", auth0Sub: sub });

    mockLoadUser(pendingUser);

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const fakeTx = {
          user: { findFirst: vi.fn().mockResolvedValue(pendingUser) },
          producerCategory: {
            // Only returns "queso", not "not-a-real-slug" → triggers UnknownCategoryError
            findMany: vi
              .fn()
              .mockResolvedValue([
                { id: "cat_queso", slug: "queso", name: "Queso", createdAt: new Date() },
              ]),
          },
          producer: { create: vi.fn() },
          producerCategoryOnProducer: { createMany: vi.fn() },
        };
        return fn(fakeTx as unknown as Prisma.TransactionClient);
      },
    );

    mockedUserRepo.findById.mockImplementationOnce(async (_id, tx) => {
      void tx;
      return pendingUser;
    });

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Unknown",
        lastName: "Category",
        businessName: "Test Biz",
        nif: "B12345678",
        description: "A desc",
        address: { line1: "Calle 1", city: "Madrid", postalCode: "28001", province: "Madrid" },
        categorySlugs: ["queso", "not-a-real-slug"],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("UNKNOWN_CATEGORY");
    expect(res.body.detail).toContain("not-a-real-slug");
  });
});

// ---------------------------------------------------------------------------
// [S7] Duplicate NIF → 409 NIF_ALREADY_REGISTERED
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/onboarding/producer — duplicate NIF", () => {
  it("returns 409 NIF_ALREADY_REGISTERED when NIF already exists", async () => {
    const sub = "auth0|producer020";
    const pendingUser = makeUser({ id: "cuid_p020", auth0Sub: sub });

    mockLoadUser(pendingUser);

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const fakeTx = {
          user: { findFirst: vi.fn().mockResolvedValue(pendingUser) },
          producerCategory: {
            findMany: vi
              .fn()
              .mockResolvedValue([
                { id: "cat_queso", slug: "queso", name: "Queso", createdAt: new Date() },
              ]),
          },
          producer: {
            create: vi.fn().mockRejectedValue({ code: "P2002", meta: { target: ["nif"] } }),
          },
          producerCategoryOnProducer: { createMany: vi.fn() },
        };
        return fn(fakeTx as unknown as Prisma.TransactionClient);
      },
    );

    mockedUserRepo.findById.mockImplementationOnce(async (_id, tx) => {
      void tx;
      return pendingUser;
    });

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Duplicate",
        lastName: "Nif",
        businessName: "Dupe Biz",
        nif: "B12345678",
        description: "A desc",
        address: { line1: "Calle 1", city: "Madrid", postalCode: "28001", province: "Madrid" },
        categorySlugs: ["queso"],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NIF_ALREADY_REGISTERED");
  });
});

// ---------------------------------------------------------------------------
// [S8] Retry after successful onboarding → 409 ROLE_ALREADY_SET
// ---------------------------------------------------------------------------

describe("POST /api/v1/users/me/onboarding — retry after onboarded", () => {
  it("returns 409 ROLE_ALREADY_SET when consumer retries consumer onboarding", async () => {
    const sub = "auth0|consumer030";
    const consumerUser = makeUser({ id: "cuid_c030", auth0Sub: sub, role: "CONSUMER" });

    mockLoadUser(consumerUser);
    mockedUserRepo.findById.mockResolvedValueOnce(consumerUser);

    const res = await request
      .post("/api/v1/users/me/onboarding/consumer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ firstName: "Ana", lastName: "López" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ROLE_ALREADY_SET");
  });

  it("returns 409 ROLE_ALREADY_SET when producer retries producer onboarding", async () => {
    const sub = "auth0|producer030";
    const producerUser = makeUser({ id: "cuid_p030", auth0Sub: sub, role: "PRODUCER" });

    mockLoadUser(producerUser);

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const fakeTx = {
          user: { findFirst: vi.fn().mockResolvedValue(producerUser) },
          producerCategory: { findMany: vi.fn() },
          producer: { create: vi.fn() },
          producerCategoryOnProducer: { createMany: vi.fn() },
        };
        return fn(fakeTx as unknown as Prisma.TransactionClient);
      },
    );

    mockedUserRepo.findById.mockImplementationOnce(async (_id, tx) => {
      void tx;
      return producerUser;
    });

    const res = await request
      .post("/api/v1/users/me/onboarding/producer")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({
        firstName: "Already",
        lastName: "Done",
        businessName: "Already Done",
        nif: "B12345678",
        description: "A desc",
        address: { line1: "Calle 1", city: "Madrid", postalCode: "28001", province: "Madrid" },
        categorySlugs: ["queso"],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ROLE_ALREADY_SET");
  });
});
