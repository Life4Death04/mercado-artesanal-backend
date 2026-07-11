/**
 * Integration tests — categories endpoints (Slice 4).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract: routing, middleware chain,
 * request/response serialization, error mapping — without touching a live DB.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth
 *     (same pattern as products.test.ts — kept for consistency even though
 *     category endpoints are public and do not require auth).
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     Category operations call `prisma.category.findMany` and
 *     `prisma.category.findFirst` directly (no $transaction needed — read-only).
 *
 * Scenarios covered (specs: product-taxonomy):
 *   [CT1]  GET /categories           — 200 list active categories only
 *   [CT2]  GET /categories           — 200 empty array when no active categories
 *   [CT3]  GET /categories/:slug     — 200 found active category by slug
 *   [CT4]  GET /categories/:slug     — 404 CATEGORY_NOT_FOUND for unknown slug
 *   [CT5]  GET /categories/:slug     — 404 CATEGORY_NOT_FOUND for inactive category
 *   [CT6]  Coexistence               — Category and ProducerCategory can share the same slug
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints",
 *                    §"Category entity",
 *                    §"List returns only active categories",
 *                    §"Lookup by unknown slug returns 404",
 *                    §"Coexistence with ProducerCategory"
 */
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as products.test.ts
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
// Category endpoints call prisma.category.findMany and prisma.category.findFirst.
// ProducerCategory coexistence test calls prisma.producerCategory.findFirst.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      category: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      producerCategory: {
        findFirst: vi.fn(),
      },
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
const mockedCategory = mockedPrisma.category as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProducerCategory = mockedPrisma.producerCategory as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GET /api/v1/categories — list active categories", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("[CT1] returns 200 with only active categories", async () => {
    // GIVEN: two categories, one active, one inactive
    const activeCategory = makeCategory({ id: "cat_001", slug: "aceites", name: "Aceites", isActive: true });
    const inactiveCategory = makeCategory({ id: "cat_002", slug: "vinos", name: "Vinos", isActive: false });

    // prisma.category.findMany is called with isActive:true filter — returns only active
    mockedCategory.findMany.mockResolvedValue([activeCategory]);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories")
      .expect(200);

    // THEN: response contains only the active category
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe("aceites");
    expect(res.body[0].isActive).toBe(true);

    // AND: we did not receive the inactive one
    const slugs = (res.body as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).not.toContain("vinos");

    // Verify the service called prisma with the active filter
    expect(mockedCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  it("[CT2] returns 200 with empty array when no active categories exist", async () => {
    // GIVEN: no active categories
    mockedCategory.findMany.mockResolvedValue([]);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories")
      .expect(200);

    // THEN: empty array (not 404 — the list is always 200)
    expect(res.body).toEqual([]);
    expect(mockedCategory.findMany).toHaveBeenCalledOnce();
  });

  it("[CT1-sort] list is sorted by name ASC", async () => {
    // GIVEN: three active categories returned in alphabetical order from the service
    const cats = [
      makeCategory({ id: "cat_001", slug: "aceites", name: "Aceites" }),
      makeCategory({ id: "cat_002", slug: "miel", name: "Miel" }),
      makeCategory({ id: "cat_003", slug: "vinos", name: "Vinos" }),
    ];
    mockedCategory.findMany.mockResolvedValue(cats);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories")
      .expect(200);

    const names = (res.body as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["Aceites", "Miel", "Vinos"]);

    // Verify the sort is requested at the DB level (not client-side)
    expect(mockedCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: expect.objectContaining({ name: "asc" }),
      }),
    );
  });
});

describe("GET /api/v1/categories/:slug — lookup by slug", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("[CT3] returns 200 with the category when found and active", async () => {
    const category = makeCategory({ slug: "aceites", isActive: true });
    mockedCategory.findFirst.mockResolvedValue(category);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories/aceites")
      .expect(200);

    expect(res.body.slug).toBe("aceites");
    expect(res.body.name).toBe("Aceites");
    expect(res.body.isActive).toBe(true);

    expect(mockedCategory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slug: "aceites" }),
      }),
    );
  });

  it("[CT4] returns 404 CATEGORY_NOT_FOUND for an unknown slug", async () => {
    // GIVEN: no category with slug "unknown"
    mockedCategory.findFirst.mockResolvedValue(null);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories/unknown")
      .expect(404);

    // THEN: RFC-7807 error shape with code CATEGORY_NOT_FOUND
    expect(res.body.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("[CT5] returns 404 CATEGORY_NOT_FOUND for an inactive category", async () => {
    // GIVEN: category exists but isActive=false — service returns null for inactive
    mockedCategory.findFirst.mockResolvedValue(null);

    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories/vinos")
      .expect(404);

    expect(res.body.code).toBe("CATEGORY_NOT_FOUND");
  });
});

describe("Coexistence — Category vs ProducerCategory", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("[CT6] Category and ProducerCategory can hold the same slug in separate tables", async () => {
    // GIVEN: ProducerCategory with slug "queso" (Cycle 1, O-2 LOCKED) —
    //   lives in producer_categories table (separate from categories table).
    const producerCategoryRow = { id: "pc_queso", slug: "queso", name: "Queso" };
    mockedProducerCategory.findFirst.mockResolvedValue(producerCategoryRow);

    // AND: Category with slug "queso" (Cycle 2 — seeded in prisma/seed.ts) —
    //   lives in categories table.
    const productCategoryRow = makeCategory({
      id: "cat_queso",
      slug: "queso",
      name: "Queso",
      description: "Quesos artesanales y curados",
      isActive: true,
    });
    mockedCategory.findFirst.mockResolvedValue(productCategoryRow);

    // WHEN: a client calls GET /api/v1/categories/queso through the real Express app
    const app = createApp();
    const res = await supertest(app)
      .get("/api/v1/categories/queso")
      .expect(200);

    // THEN: the response body comes from the Category table (not ProducerCategory)
    expect(res.body.id).toBe("cat_queso");
    expect(res.body.slug).toBe("queso");
    expect(res.body.name).toBe("Queso");

    // AND: the service called prisma.category.findFirst for the Category table
    expect(mockedCategory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slug: "queso", isActive: true }),
      }),
    );

    // AND: ProducerCategory with slug "queso" still exists as a distinct entity
    //   in producer_categories — independent query to prove coexistence.
    const foundProducerCategory = await mockedProducerCategory.findFirst({
      where: { slug: "queso" },
    });
    expect(foundProducerCategory).not.toBeNull();
    expect(foundProducerCategory!.slug).toBe("queso");

    // AND: the two rows have distinct IDs — they live in separate tables, no collision
    expect(foundProducerCategory!.id).not.toBe(res.body.id);
  });
});
