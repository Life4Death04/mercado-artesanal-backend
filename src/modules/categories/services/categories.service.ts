/**
 * Categories service — product-taxonomy public read layer.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as categoriesService from "@/modules/categories/services/categories.service"`.
 *
 * Key invariants:
 *   - Read-only in Cycle 2. No create/update/delete endpoints exist.
 *   - List returns only isActive=true categories, sorted by name ASC.
 *   - findBySlug returns only the active category or throws CategoryNotFoundError.
 *   - No repositories/ layer — service calls prisma.category.* directly per
 *     project convention (ADR-003, architecture/repository-layer-policy).
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints"
 *   product-taxonomy §"Category entity"
 *   design — Decision #5 (Category distinct from ProducerCategory)
 */
import type { Category } from "@prisma/client";

import { CategoryNotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

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
