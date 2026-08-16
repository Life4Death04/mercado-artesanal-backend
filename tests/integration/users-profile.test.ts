import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

      const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
      req.auth = { payload: payload as never, header: {}, token: "test-token" };
      next();
    },
}));

vi.mock("@/shared/utils/prisma", () => {
  const user = {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  };
  const transactionClient = { user };
  type TransactionCallback = (client: typeof transactionClient) => unknown;

  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn((callback: TransactionCallback) => callback(transactionClient)),
      user,
    },
  };
});

import type { User } from "@prisma/client";
import { createApp } from "@/app";
import { prisma } from "@/shared/utils/prisma";

const mockedUser = vi.mocked(prisma.user);
const app = createApp();
const request = supertest(app);

function authHeader(sub: string): string {
  return Buffer.from(JSON.stringify({ sub })).toString("base64");
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "consumer_001",
    auth0Sub: "auth0|consumer-profile",
    email: "consumer@example.com",
    emailVerified: true,
    firstName: "Ana",
    lastName: "Soler",
    name: "Ana Soler",
    avatar: null,
    role: "CONSUMER",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    deletedAt: null,
    deactivatedAt: null,
    ...overrides,
  };
}

function mockLoadUser(user: User): void {
  mockedUser.findUnique.mockResolvedValueOnce({
    id: user.id,
    role: user.role,
    email: user.email,
    deletedAt: user.deletedAt,
    deactivatedAt: user.deactivatedAt,
    producer: null,
  } as never);
}

function mockUpdatedUser(user: User): void {
  mockedUser.updateMany.mockResolvedValueOnce({ count: 1 });
  mockedUser.findFirst.mockResolvedValueOnce({ ...user, producer: null } as never);
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/users/me", () => {
  it("updates both names, trims input, and returns the canonical MeView", async () => {
    const user = makeUser();
    const updated = makeUser({ firstName: "María", lastName: "López" });
    mockLoadUser(user);
    mockUpdatedUser(updated);

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send({ firstName: "  María ", lastName: " López  " });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: user.id,
      firstName: "María",
      lastName: "López",
      email: user.email,
      emailVerified: true,
      onboardingCompleted: true,
      producer: null,
    });
    expect(mockedUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: user.id, deletedAt: null, deactivatedAt: null },
        data: { firstName: "María", lastName: "López" },
      }),
    );
    expect(mockedUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: user.id, deletedAt: null, deactivatedAt: null },
        include: expect.objectContaining({ producer: expect.any(Object) }),
      }),
    );
  });

  it("supports a partial lastName update", async () => {
    const user = makeUser();
    mockLoadUser(user);
    mockUpdatedUser(makeUser({ lastName: "Vidal" }));

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send({ lastName: " Vidal " });

    expect(response.status).toBe(200);
    expect(mockedUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastName: "Vidal" } }),
    );
  });

  it("returns controlled NOT_FOUND when a lifecycle transition wins the update race", async () => {
    const user = makeUser();
    mockLoadUser(user);
    mockedUser.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send({ firstName: "Ana" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("NOT_FOUND");
    expect(mockedUser.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty object", {}],
    ["an empty value", { firstName: "   " }],
    ["a null value", { lastName: null }],
    ["a non-string value", { firstName: 42 }],
    ["an unknown snake-case field", { last_name: "Soler" }],
    ["a forbidden email field", { email: "other@example.com" }],
    ["a forbidden avatar field", { avatar: "https://example.com/avatar.jpg" }],
    ["a forbidden display name field", { name: "Other Name" }],
    ["a forbidden phone field", { phone: "+34 600 000 000" }],
    ["a forbidden role field", { role: "ADMIN" }],
  ])("rejects %s", async (_label, body) => {
    const user = makeUser();
    mockLoadUser(user);

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(mockedUser.updateMany).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await request.patch("/api/v1/users/me").send({ firstName: "Ana" });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("blocks PENDING_ROLE users through the onboarding gate", async () => {
    const user = makeUser({ role: "PENDING_ROLE" });
    mockLoadUser(user);

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send({ firstName: "Ana" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ONBOARDING_REQUIRED");
    expect(mockedUser.updateMany).not.toHaveBeenCalled();
  });

  it("preserves lifecycle denial for deactivated users", async () => {
    const user = makeUser({ deactivatedAt: new Date("2026-02-01T00:00:00.000Z") });
    mockLoadUser(user);

    const response = await request
      .patch("/api/v1/users/me")
      .set("X-Test-Auth", authHeader(user.auth0Sub))
      .send({ firstName: "Ana" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACCOUNT_INACTIVE");
    expect(mockedUser.updateMany).not.toHaveBeenCalled();
  });
});
