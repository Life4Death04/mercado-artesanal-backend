/**
 * Categories service — product-taxonomy public read layer PLUS the
 * admin-catalog write surface added in WU2 (create/update/deactivate/list).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as categoriesService from "@/modules/categories/services/categories.service"`.
 *
 * Key invariants (public read layer — unchanged since Cycle 2):
 *   - findAll/findBySlug remain public-safe: only isActive=true categories,
 *     sorted by name ASC; findBySlug throws CategoryNotFoundError otherwise.
 *   - No repositories/ layer — service calls prisma.category.* directly per
 *     project convention (ADR-003, architecture/repository-layer-policy).
 *
 * Key invariants (admin write surface — WU2, admin-catalog-control):
 *   - Slug is generated ONLY on create, from `name`, via the shared slugify
 *     helper. PATCH never accepts or derives a new slug — this keeps public
 *     category URLs stable across renames (design — Decision "Mutable vs
 *     stable category slug").
 *   - A slug collision (Prisma P2002 on the unique `slug` column, including
 *     a concurrent create race) maps to CategorySlugConflictError (409); no
 *     row is created.
 *   - Deletion is a REVERSIBLE soft-deactivation (`isActive=false`) — never
 *     a hard delete, even when the category has associated products
 *     (design — Decision "Hard delete vs deactivation"). `update({isActive:
 *     true})` restores it.
 *   - The admin listing (`findAllAdmin`) includes inactive rows (unlike the
 *     public `findAll`) and reports `productCount` filtered to active,
 *     non-deleted products only.
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints"
 *   product-taxonomy §"Category entity"
 *   admin-catalog    §"Category administration", §"Category lifecycle succeeds",
 *                    §"Soft-deleted category leaves public taxonomy",
 *                    §"Generated slug collision"
 *   design — Decision #5 (Category distinct from ProducerCategory),
 *            Decision "Mutable vs stable category slug",
 *            Decision "Hard delete vs deactivation"
 */
import type { Category, Prisma } from "@prisma/client";

import { CategoryNotFoundError, CategorySlugConflictError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";
import { slugify } from "@/shared/utils/slugify";

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

/**
 * List all active product categories, sorted alphabetically by name.
 *
 * Inactive categories are never returned — they are filtered at DB level.
 * Sort is enforced at DB level (orderBy name ASC) so the response is
 * deterministic without in-memory sorting.
 *
 * Spec: product-taxonomy §"Public category read endpoints" — list returns only isActive=true,
 *       sorted by name ASC.
 */
export async function findAll(): Promise<Category[]> {
  return prisma.category.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
}

// ---------------------------------------------------------------------------
// findBySlug
// ---------------------------------------------------------------------------

/**
 * Find a single active category by its slug.
 *
 * Throws CategoryNotFoundError (404) when:
 *   - No category with the given slug exists.
 *   - A category with the slug exists but isActive=false.
 *
 * Both cases map to the same error to avoid information leakage about
 * inactive entries (spec: product-taxonomy §"Lookup by unknown slug returns 404").
 *
 * Design note: `findFirst` (not `findUnique`) is intentional — the compound
 * filter `{ slug, isActive: true }` is not the unique index key (slug alone is).
 * Using `findFirst` with both conditions lets Prisma apply the unique index on
 * slug and filter isActive in the same query, returning null for inactive slugs
 * without a second round-trip.
 *
 * Spec: product-taxonomy §"Public category read endpoints", §"Lookup by unknown slug returns 404"
 */
export async function findBySlug(slug: string): Promise<Category> {
  const category = await prisma.category.findFirst({
    where: { slug, isActive: true },
  });

  if (!category) {
    throw new CategoryNotFoundError("Category not found");
  }

  return category;
}

// ---------------------------------------------------------------------------
// Admin write surface (admin-catalog capability — WU2)
// ---------------------------------------------------------------------------

/** Translate a Prisma P2002 unique constraint violation on the slug column. */
function remapSlugP2002(err: unknown): never {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  ) {
    throw new CategorySlugConflictError(
      "A category with an equivalent slug already exists. Choose a different name.",
    );
  }
  throw err;
}

export interface CreateCategoryInput {
  name: string;
  description?: string | null;
}

export interface UpdateCategoryInput {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

/** Admin category projection with the eligible (active, non-deleted) product count. */
export type AdminCategoryProjection = Category & { productCount: number };

/**
 * Create a new category. Slug is derived from `name` via slugify — it is
 * NEVER accepted as input (design — Decision "Mutable vs stable category
 * slug"). A collision on the unique slug column (including a concurrent
 * create race) throws CategorySlugConflictError (409); no row is created.
 *
 * Spec: admin-catalog §"Category administration", §"Category lifecycle succeeds",
 *       §"Generated slug collision".
 */
export async function create(input: CreateCategoryInput): Promise<Category> {
  const slug = slugify(input.name);
  try {
    return await prisma.category.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        slug,
      },
    });
  } catch (err) {
    return remapSlugP2002(err);
  }
}

/**
 * Partially update a category's `name`, `description`, and/or `isActive`.
 *
 * The `slug` field is NEVER written here — omitting it from the update
 * `data` object is what keeps public category URLs stable across renames
 * (design — Decision "Mutable vs stable category slug"). `isActive: true`
 * is the restore path for a previously deactivated category.
 *
 * Spec: admin-catalog §"Category administration".
 */
export async function update(id: string, patch: UpdateCategoryInput): Promise<Category> {
  const category = await prisma.category.findFirst({ where: { id } });
  if (!category) {
    throw new CategoryNotFoundError("Category not found");
  }

  const data: Prisma.CategoryUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  return prisma.category.update({ where: { id }, data });
}

/**
 * Deactivate a category (reversible soft-delete, `isActive=false`).
 *
 * NEVER a hard delete — required product FKs remain unchanged, and the
 * category can be restored later via `update(id, { isActive: true })`
 * (design — Decision "Hard delete vs deactivation").
 *
 * Spec: admin-catalog §"Soft-deleted category leaves public taxonomy".
 */
export async function deactivate(id: string): Promise<void> {
  const category = await prisma.category.findFirst({ where: { id } });
  if (!category) {
    throw new CategoryNotFoundError("Category not found");
  }

  await prisma.category.update({ where: { id }, data: { isActive: false } });
}

/**
 * List every category (including inactive rows) for the admin surface,
 * each annotated with `productCount` — a Prisma filtered `_count` scoped to
 * active, non-deleted products only (distinct from the public `findAll`,
 * which excludes inactive categories entirely).
 *
 * Spec: admin-catalog §"Category administration" — "Lists MUST count only
 * active, non-deleted products."
 */
export async function findAllAdmin(): Promise<AdminCategoryProjection[]> {
  const categories = await prisma.category.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: {
          products: { where: { isActive: true, deletedAt: null } },
        },
      },
    },
  });

  return categories.map(({ _count, ...category }) => ({
    ...category,
    productCount: _count.products,
  }));
}
