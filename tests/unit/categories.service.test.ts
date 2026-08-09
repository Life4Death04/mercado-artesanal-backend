/**
 * Unit tests — categories.service (WU2 Category Administration, RED phase).
 *
 * Strategy: mock the prisma singleton so no DB is required.
 * Tests exercise the admin write surface added on top of the existing
 * public read-only layer (findAll/findBySlug, untouched by this batch).
 *
 * Scenarios covered (spec: admin-catalog §"Category administration",
 * §"Category lifecycle succeeds", §"Soft-deleted category leaves public
 * taxonomy", §"Generated slug collision"; product-taxonomy §"Public category
 * read endpoints"; design — Decisions "Mutable vs stable category slug" and
 * "Hard delete vs deactivation"):
 *
 * create:
 *   - derives slug "pan-artesano" from name "Pan Artesano" (spec example)
 *   - strips diacritics when deriving the slug (triangulation)
 *   - maps a Prisma P2002 unique violation on slug to CategorySlugConflictError (409)
 *
 * update:
 *   - updates name/description while leaving the stored slug untouched (PATCH cannot change slug)
 *   - throws CategoryNotFoundError when the category does not exist
 *   - PATCH {isActive: true} restores a previously deactivated category
 *
 * deactivate:
 *   - sets isActive=false without deleting the row (reversible soft-delete)
 *   - throws CategoryNotFoundError when the category does not exist
 *
 * findAllAdmin:
 *   - includes inactive categories (unlike the public findAll)
 *   - productCount reflects only active, non-deleted products (filtered _count)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      category: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

import type { Category } from "@prisma/client";
import { prisma } from "@/shared/utils/prisma";
import { CategoryNotFoundError, CategorySlugConflictError } from "@/shared/errors/errors";
import * as categoriesService from "@/modules/categories/services/categories.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCategory = mockedPrisma.category as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat_001",
    slug: "pan-artesano",
    name: "Pan Artesano",
    description: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Minimal shape of a Prisma P2002 unique constraint violation. */
function makeP2002(target: string | string[] = "slug"): Error & { code: string; meta: unknown } {
  const err = new Error("Unique constraint failed") as Error & { code: string; meta: unknown };
  err.code = "P2002";
  err.meta = { target };
  return err;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// create — slug derivation + collision mapping
// ---------------------------------------------------------------------------

describe("categoriesService.create", () => {
  it('derives slug "pan-artesano" from name "Pan Artesano" (spec example)', async () => {
    const created = makeCategory();
    mockedCategory.create.mockResolvedValueOnce(created);

    const result = await categoriesService.create({ name: "Pan Artesano" });

    expect(result.slug).toBe("pan-artesano");
    expect(mockedCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Pan Artesano", slug: "pan-artesano" }),
      }),
    );
  });

  it("strips diacritics when deriving the slug (triangulation)", async () => {
    const created = makeCategory({ name: "Salchichón Ibérico", slug: "salchichon-iberico" });
    mockedCategory.create.mockResolvedValueOnce(created);

    const result = await categoriesService.create({ name: "Salchichón Ibérico" });

    expect(result.slug).toBe("salchichon-iberico");
    expect(mockedCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: "salchichon-iberico" }),
      }),
    );
  });

  it("maps a Prisma P2002 unique violation on slug to CategorySlugConflictError (409)", async () => {
    mockedCategory.create.mockRejectedValueOnce(makeP2002("slug"));

    await expect(categoriesService.create({ name: "Pan Artesano" })).rejects.toThrow(
      CategorySlugConflictError,
    );
  });
});

// ---------------------------------------------------------------------------
// update — name/description editable, slug MUST remain stable
// ---------------------------------------------------------------------------

describe("categoriesService.update", () => {
  it("updates name/description while leaving the stored slug untouched", async () => {
    const existing = makeCategory({ id: "cat_001", slug: "pan-artesano", name: "Pan Artesano" });
    const updated = makeCategory({
      id: "cat_001",
      slug: "pan-artesano",
      name: "Pan Artesano Renombrado",
      description: "Nueva descripción",
    });
    mockedCategory.findFirst.mockResolvedValueOnce(existing);
    mockedCategory.update.mockResolvedValueOnce(updated);

    const result = await categoriesService.update("cat_001", {
      name: "Pan Artesano Renombrado",
      description: "Nueva descripción",
    });

    expect(result.slug).toBe("pan-artesano");
    expect(mockedCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat_001" },
        data: expect.not.objectContaining({ slug: expect.anything() }),
      }),
    );
  });

  it("throws CategoryNotFoundError when the category does not exist", async () => {
    mockedCategory.findFirst.mockResolvedValueOnce(null);

    await expect(
      categoriesService.update("cat_missing", { name: "Nuevo Nombre" }),
    ).rejects.toThrow(CategoryNotFoundError);
    expect(mockedCategory.update).not.toHaveBeenCalled();
  });

  it("PATCH {isActive: true} restores a previously deactivated category (triangulation)", async () => {
    const existing = makeCategory({ id: "cat_001", isActive: false });
    const restored = makeCategory({ id: "cat_001", isActive: true });
    mockedCategory.findFirst.mockResolvedValueOnce(existing);
    mockedCategory.update.mockResolvedValueOnce(restored);

    const result = await categoriesService.update("cat_001", { isActive: true });

    expect(result.isActive).toBe(true);
    expect(mockedCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat_001" },
        data: expect.objectContaining({ isActive: true }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// deactivate — reversible soft-delete (isActive=false), never a hard delete
// ---------------------------------------------------------------------------

describe("categoriesService.deactivate", () => {
  it("sets isActive=false without deleting the row", async () => {
    const existing = makeCategory({ id: "cat_001", isActive: true });
    const deactivated = makeCategory({ id: "cat_001", isActive: false });
    mockedCategory.findFirst.mockResolvedValueOnce(existing);
    mockedCategory.update.mockResolvedValueOnce(deactivated);

    await categoriesService.deactivate("cat_001");

    expect(mockedCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cat_001" },
        data: { isActive: false },
      }),
    );
  });

  it("throws CategoryNotFoundError when the category does not exist", async () => {
    mockedCategory.findFirst.mockResolvedValueOnce(null);

    await expect(categoriesService.deactivate("cat_missing")).rejects.toThrow(
      CategoryNotFoundError,
    );
    expect(mockedCategory.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findAllAdmin — includes inactive rows; productCount is filtered
// ---------------------------------------------------------------------------

describe("categoriesService.findAllAdmin", () => {
  it("includes inactive categories in the admin listing (unlike the public findAll)", async () => {
    const active = makeCategory({ id: "cat_active", isActive: true });
    const inactive = makeCategory({ id: "cat_inactive", isActive: false });
    mockedCategory.findMany.mockResolvedValueOnce([
      { ...active, _count: { products: 3 } },
      { ...inactive, _count: { products: 0 } },
    ]);

    const result = await categoriesService.findAllAdmin();

    expect(result.map((c) => c.id)).toEqual(["cat_active", "cat_inactive"]);
    expect(mockedCategory.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
    );
  });

  it("maps productCount from the active, non-deleted filtered _count (triangulation)", async () => {
    const category = makeCategory({ id: "cat_001" });
    mockedCategory.findMany.mockResolvedValueOnce([{ ...category, _count: { products: 7 } }]);

    const result = await categoriesService.findAllAdmin();

    expect(result[0]?.productCount).toBe(7);
    expect(mockedCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: expect.objectContaining({
            select: expect.objectContaining({
              products: expect.objectContaining({
                where: expect.objectContaining({ isActive: true, deletedAt: null }),
              }),
            }),
          }),
        }),
      }),
    );
  });
});
