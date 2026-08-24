/**
 * Unit tests — loadUser middleware (Cycle 2 extension) (TDD — RED phase)
 *
 * Spec reference:
 *   design §"Middleware / Request typing" (Decision #8)
 *   error-handling §"New Cycle 2 AppError subclasses" (uses extended req.user)
 *
 * Covers:
 *   - PRODUCER role: req.user.producerId is populated from producer.id
 *   - CONSUMER role: req.user.producerId is undefined (not set)
 *   - ADMIN role: req.user.producerId is undefined (not set)
 *   - User not found: req.user = null (existing behavior preserved)
 *   - Missing auth: calls next(UnauthorizedError) (existing behavior preserved)
 *
 * Strategy: mock prisma singleton; loadUser calls prisma.user.findUnique.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing loadUser (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
    },
  };
});

import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/shared/utils/prisma";
import { loadUser } from "@/shared/middleware/loadUser";
import { AccountInactiveError, UnauthorizedError } from "@/shared/errors/errors";

const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReq(sub?: string): Partial<Request> {
  return {
    auth: sub ? { payload: { sub }, header: {}, token: "tok" } : undefined,
  };
}

function buildRes(): Partial<Response> {
  return {};
}

function buildNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// PRODUCER role — producerId attached
// ---------------------------------------------------------------------------

describe("loadUser — PRODUCER role", () => {
  it("attaches req.user.producerId from producer.id when role is PRODUCER", async () => {
    const req = buildReq("auth0|producer1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_001",
      role: "PRODUCER",
      email: "producer@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: { id: "prod_001" },
    });

    await loadUser(req, res, next);

    expect(req.user).toEqual({
      id: "user_001",
      role: "PRODUCER",
      email: "producer@example.com",
      producerId: "prod_001",
    });
    expect(next).toHaveBeenCalledWith(); // called with no error
  });

  it("includes producer in the findUnique select when resolving PRODUCER users", async () => {
    const req = buildReq("auth0|producer2") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_002",
      role: "PRODUCER",
      email: "p2@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: { id: "prod_002" },
    });

    await loadUser(req, res, next);

    // Verify the findUnique call includes `producer: { select: { id: true } }`
    expect(mockedUser["findUnique"]).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          producer: expect.objectContaining({ select: { id: true } }),
        }),
      }),
    );
  });

  it("sets producerId to undefined when PRODUCER has no linked producer row", async () => {
    // Edge: producer record not yet created (unlikely but safe fallback)
    const req = buildReq("auth0|producer3") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_003",
      role: "PRODUCER",
      email: "p3@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });

    await loadUser(req, res, next);

    expect(req.user).toEqual({
      id: "user_003",
      role: "PRODUCER",
      email: "p3@example.com",
      producerId: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Non-PRODUCER roles — producerId NOT attached
// ---------------------------------------------------------------------------

describe("loadUser — non-PRODUCER roles", () => {
  it("does NOT attach producerId for CONSUMER role", async () => {
    const req = buildReq("auth0|consumer1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_010",
      role: "CONSUMER",
      email: "consumer@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });

    await loadUser(req, res, next);

    expect(req.user).toEqual({
      id: "user_010",
      role: "CONSUMER",
      email: "consumer@example.com",
      producerId: undefined,
    });
  });

  it("does NOT attach producerId for ADMIN role", async () => {
    const req = buildReq("auth0|admin1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_020",
      role: "ADMIN",
      email: "admin@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });

    await loadUser(req, res, next);

    expect(req.user).toEqual({
      id: "user_020",
      role: "ADMIN",
      email: "admin@example.com",
      producerId: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Existing behavior preserved — non-regression
// ---------------------------------------------------------------------------

describe("loadUser — existing behavior (non-regression)", () => {
  it("sets req.user = null when user not found in DB", async () => {
    const req = buildReq("auth0|unknown") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce(null);

    await loadUser(req, res, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it("calls next(UnauthorizedError) when req.auth is missing", async () => {
    const req = buildReq(undefined) as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    await loadUser(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect(req.user).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// admin-user-management delta — account lifecycle denial
// Spec: admin-bootstrap §"Soft-deleted users cannot be authorized"
// Spec: account-lifecycle §"Backend-wide lifecycle denial"
// ---------------------------------------------------------------------------

describe("loadUser — account lifecycle denial (admin-user-management)", () => {
  it("sets req.user = null when the matched User is soft-deleted (tombstone)", async () => {
    const req = buildReq("auth0|deleted1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_del_001",
      role: "CONSUMER",
      email: "deleted+user_del_001@tombstone.invalid",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      deactivatedAt: null,
      producer: null,
    });

    await loadUser(req, res, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledWith(); // no error — treated as absent
  });

  it("treats deleted precedence: both timestamps set still resolves to req.user = null (never AccountInactiveError)", async () => {
    const req = buildReq("auth0|deleted2") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_del_002",
      role: "CONSUMER",
      email: "deleted+user_del_002@tombstone.invalid",
      deletedAt: new Date("2026-01-02T00:00:00.000Z"),
      deactivatedAt: new Date("2026-01-01T00:00:00.000Z"),
      producer: null,
    });

    await loadUser(req, res, next);

    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next(AccountInactiveError) when the matched User is deactivated but not deleted", async () => {
    const req = buildReq("auth0|deactivated1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_deact_001",
      role: "PRODUCER",
      email: "producer@example.com",
      deletedAt: null,
      deactivatedAt: new Date("2026-01-01T00:00:00.000Z"),
      producer: { id: "prod_deact_001" },
    });

    await loadUser(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AccountInactiveError));
    const errArg = (next as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AccountInactiveError;
    expect(errArg.status).toBe(403);
    expect(errArg.code).toBe("ACCOUNT_INACTIVE");
    expect(req.user).toBeUndefined();
  });

  it("queries deletedAt and deactivatedAt so lifecycle state can be evaluated", async () => {
    const req = buildReq("auth0|active1") as Request;
    const res = buildRes() as Response;
    const next = buildNext();

    mockedUser["findUnique"].mockResolvedValueOnce({
      id: "user_active_001",
      role: "CONSUMER",
      email: "active@example.com",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });

    await loadUser(req, res, next);

    expect(mockedUser["findUnique"]).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ deletedAt: true, deactivatedAt: true }),
      }),
    );
  });
});
