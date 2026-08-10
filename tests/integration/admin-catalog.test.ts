/**
 * Integration tests — admin catalog endpoints (WU3, admin-catalog-control).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer (same
 * pattern as statistics.test.ts / categories.test.ts) — exercises the full
 * wire contract without touching a live DB.
 *
 * NOTE on scope: public category regression (active-only list, unknown slug
 * 404, sort) is already proven end-to-end by tests/integration/categories.test.ts
 * (CT1–CT6, unchanged, still 7/7 in this batch's full-suite run) — not
 * duplicated here. This file adds [AC-6] as the one RED-required check that
 * mounting adminRouter does not disturb that public route.
 *
 * Spec references:
 *   admin-catalog §"Admin-only catalog surface", §"Moderation queue and
 *   detail", §"Reversible audited moderation", §"Category administration"
 *   design — Data Flow (authenticate → loadUser → onboardingGate → requireRole("ADMIN"))
 */
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/shared/utils/prisma", () => ({
  prisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
    user: { findUnique: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    category: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/shared/utils/prisma";
import { createApp } from "@/app";

const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCategory = mockedPrisma.category as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProduct = mockedPrisma.product as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function mockLoadUser(role: string): void {
  mockedUser.findUnique.mockResolvedValueOnce({
    id: "cuid_user_001",
    role,
    email: "user@example.com",
    producer: null,
  });
}

function makeCategory(overrides: Record<string, unknown> = {}) {
  return {
    id: "cat_001",
    slug: "aceites",
    name: "Aceites",
    description: "Aceites artesanales",
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Wires an ADMIN loadUser mock and returns the ready-to-use auth header. */
function adminAuth(): string {
  const sub = "auth0|admin001";
  mockLoadUser("ADMIN");
  return authHeader({ sub });
}

const app = createApp();
const request = supertest(app);

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// RBAC / wire routing — admin-catalog §"Admin-only catalog surface"
// ===========================================================================

describe("Admin catalog RBAC — /api/v1/admin/*", () => {
  it("[AC-1] ADMIN reaches the moderation queue, filtered to moderationStatus", async () => {
    mockedProduct.findMany.mockResolvedValueOnce([
      { id: "p1", moderationStatus: "REPORTED", producer: { id: "prod_1", businessName: "A" } },
    ]);

    const res = await request
      .get("/api/v1/admin/products?moderationStatus=REPORTED")
      .set("X-Test-Auth", adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockedProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ moderationStatus: "REPORTED" }) }),
    );
  });

  it("[AC-2] missing JWT on /admin/products returns 401", async () => {
    const res = await request.get("/api/v1/admin/products?moderationStatus=REPORTED");
    expect(res.status).toBe(401);
  });

  it("[AC-3] CONSUMER on /admin/products returns 403 FORBIDDEN", async () => {
    const sub = "auth0|consumer001";
    mockLoadUser("CONSUMER");

    const res = await request
      .get("/api/v1/admin/products?moderationStatus=REPORTED")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("[AC-4] PRODUCER on /admin/categories returns 403 FORBIDDEN", async () => {
    const sub = "auth0|producer001";
    mockLoadUser("PRODUCER");

    const res = await request
      .get("/api/v1/admin/categories")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("[AC-5] PENDING_ROLE on /admin/products returns 403", async () => {
    // A DB row with role=PENDING_ROLE (post auth/sync, pre onboarding) hits
    // onboardingGate before requireRole ever runs; /admin/products is NOT in
    // the onboarding allow-list, so onboardingGate rejects with 403
    // ONBOARDING_REQUIRED — a distinct, earlier non-ADMIN rejection than
    // requireRole's FORBIDDEN, but the same observable 403 contract.
    const sub = "auth0|pending001";
    mockLoadUser("PENDING_ROLE");

    const res = await request
      .get("/api/v1/admin/products?moderationStatus=REPORTED")
      .set("X-Test-Auth", authHeader({ sub }));

    expect(res.status).toBe(403);
  });

  it("[AC-6] anonymous GET /categories remains 200 (public route unaffected)", async () => {
    mockedCategory.findMany.mockResolvedValueOnce([makeCategory()]);
    const res = await request.get("/api/v1/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ===========================================================================
// Moderation detail / transitions — admin-catalog §"Moderation queue and
// detail", §"Reversible audited moderation"
// ===========================================================================

describe("Admin moderation — /api/v1/admin/products", () => {
  it("[AC-7] detail projection includes reportReason, audit fields, producer identity", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce({
      id: "p1",
      moderationStatus: "REPORTED",
      reportReason: "spam",
      moderatedBy: null,
      moderatedAt: null,
      moderationReason: null,
      producer: { id: "prod_1", businessName: "Panadería A" },
    });

    const res = await request.get("/api/v1/admin/products/p1").set("X-Test-Auth", adminAuth());

    expect(res.status).toBe(200);
    expect(res.body.reportReason).toBe("spam");
    expect(res.body.producer).toEqual({ id: "prod_1", businessName: "Panadería A" });
  });

  it("[AC-8] unknown product id returns 404 PRODUCT_NOT_FOUND", async () => {
    mockedProduct.findFirst.mockResolvedValueOnce(null);
    const res = await request
      .get("/api/v1/admin/products/unknown")
      .set("X-Test-Auth", adminAuth());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("[AC-9] allowed transition (remove) returns 200 with audit fields persisted", async () => {
    const header = adminAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedPrisma.$transaction.mockImplementationOnce((fn: any) => fn(mockedPrisma));
    mockedProduct.findFirst.mockResolvedValueOnce({ id: "p1", moderationStatus: "REPORTED" });
    mockedProduct.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request
      .patch("/api/v1/admin/products/p1/moderation")
      .set("X-Test-Auth", header)
      .send({ action: "remove", reason: "policy violation" });

    expect(res.status).toBe(200);
    expect(res.body.moderationStatus).toBe("REMOVED");
    expect(res.body.moderatedBy).toBe("cuid_user_001");
  });

  it("[AC-10] unsupported transition returns 409 INVALID_MODERATION_TRANSITION, no write", async () => {
    const header = adminAuth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedPrisma.$transaction.mockImplementationOnce((fn: any) => fn(mockedPrisma));
    // Action table (admin-catalog §"Reversible audited moderation"): "remove"
    // requires the product to currently be REPORTED — here it is OK.
    mockedProduct.findFirst.mockResolvedValueOnce({ id: "p1", moderationStatus: "OK" });

    const res = await request
      .patch("/api/v1/admin/products/p1/moderation")
      .set("X-Test-Auth", header)
      .send({ action: "remove", reason: "policy violation" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_MODERATION_TRANSITION");
    expect(mockedProduct.updateMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Category admin CRUD — admin-catalog §"Category administration"
// ===========================================================================

describe("Admin category CRUD — /api/v1/admin/categories", () => {
  it("[AC-11] list includes inactive rows with productCount", async () => {
    mockedCategory.findMany.mockResolvedValueOnce([
      { ...makeCategory({ isActive: false }), _count: { products: 2 } },
    ]);

    const res = await request.get("/api/v1/admin/categories").set("X-Test-Auth", adminAuth());

    expect(res.status).toBe(200);
    expect(res.body[0].isActive).toBe(false);
    expect(res.body[0].productCount).toBe(2);
  });

  it("[AC-12] create returns 201 with an auto-derived slug", async () => {
    const header = adminAuth();
    mockedCategory.create.mockResolvedValueOnce(
      makeCategory({ id: "cat_new", name: "Pan Artesano", slug: "pan-artesano" }),
    );

    const res = await request
      .post("/api/v1/admin/categories")
      .set("X-Test-Auth", header)
      .send({ name: "Pan Artesano" });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("pan-artesano");
    expect(mockedCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slug: "pan-artesano" }) }),
    );
  });

  it("[AC-13] create collision returns 409 CATEGORY_SLUG_CONFLICT, no category created", async () => {
    const header = adminAuth();
    mockedCategory.create.mockRejectedValueOnce({ code: "P2002" });

    const res = await request
      .post("/api/v1/admin/categories")
      .set("X-Test-Auth", header)
      .send({ name: "Pan Artesano" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CATEGORY_SLUG_CONFLICT");
  });

  it("[AC-14] update never writes slug even when name changes", async () => {
    const header = adminAuth();
    mockedCategory.findFirst.mockResolvedValueOnce(makeCategory({ id: "cat_001" }));
    mockedCategory.update.mockResolvedValueOnce(makeCategory({ name: "Aceites Premium" }));

    const res = await request
      .patch("/api/v1/admin/categories/cat_001")
      .set("X-Test-Auth", header)
      .send({ name: "Aceites Premium" });

    expect(res.status).toBe(200);
    expect(mockedCategory.update.mock.calls[0][0].data).not.toHaveProperty("slug");
  });

  it("[AC-15] update on missing category returns 404 CATEGORY_NOT_FOUND", async () => {
    const header = adminAuth();
    mockedCategory.findFirst.mockResolvedValueOnce(null);

    const res = await request
      .patch("/api/v1/admin/categories/unknown")
      .set("X-Test-Auth", header)
      .send({ name: "X" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("[AC-16] deactivate returns 204 with no body (soft-delete, never hard delete)", async () => {
    const header = adminAuth();
    mockedCategory.findFirst.mockResolvedValueOnce(makeCategory({ id: "cat_001" }));
    mockedCategory.update.mockResolvedValueOnce(makeCategory({ isActive: false }));

    const res = await request
      .delete("/api/v1/admin/categories/cat_001")
      .set("X-Test-Auth", header);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(mockedCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
  });
});
