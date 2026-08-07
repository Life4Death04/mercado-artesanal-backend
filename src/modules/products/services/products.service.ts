/**
 * Products service — enforces product-catalog and product-reporting invariants.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as productsService from "@/modules/products/services/products.service"`.
 *
 * Key invariants:
 *   - Publish-on-create: isActive=true, moderationStatus=OK (no DRAFT state).
 *   - RBAC scoping: every producer-owned operation filters by producerId.
 *   - 404-no-leak: cross-producer access returns ProductNotFoundError, never FORBIDDEN.
 *   - Soft-delete guard: DELETE and isActive→false blocked when active OrderLines exist.
 *   - Report first-wins: moderationStatus=REPORTED only once; subsequent reports are no-ops.
 *   - Category validation: create rejects unknown/inactive categoryId with CategoryNotFoundError.
 *   - Image mapping: findAll/findById include images ordered at DB level (position ASC, createdAt ASC),
 *     mapped to { id, position, url } — s3Key is NEVER exposed on the wire (Slice 3).
 *
 * All multi-row state transitions run inside `prisma.$transaction(async (tx) => { ... })`
 * callback form (NOT the array form) — required by the test mock strategy.
 *
 * Spec references:
 *   product-catalog  §"Publish-on-create lifecycle", §"RBAC-scoped ownership",
 *                    §"Soft-delete guard against active order lines",
 *                    §"Reactive-moderation data layer",
 *                    §"Producer product responses include images array"
 *   product-images   §"Wire shape", §"Deterministic ordering",
 *                    §"URL derivation", §"Empty images state"
 *   product-reporting §"Report endpoint", §"Second report is idempotent",
 *                     §"Report on removed product rejected"
 *   design — Decision #8 (producerId from req.user), Decision #3 (idempotent no-op),
 *            Decision #3 (DB-level ordering), Decision #4 (service maps, controller thin),
 *            Decision #5 (introduce ProductWithImages)
 */
import type { ModerationStatus, Prisma, Product, SubOrderStatus } from "@prisma/client";

import {
  CategoryNotFoundError,
  ProductHasActiveOrdersError,
  ProductNotFoundError,
} from "@/shared/errors/errors";
import { toImageUrl } from "@/shared/utils/image-url";
import { prisma } from "@/shared/utils/prisma";

import type { ListPublicProductsQuery } from "../dto/products.dto";

// ---------------------------------------------------------------------------
// Response types (Slice 3 — image exposure)
// ---------------------------------------------------------------------------

/**
 * Wire shape for a single exposed product image.
 * s3Key is intentionally absent — URL is derived at service level via toImageUrl.
 * Spec: product-images §"Wire shape".
 */
export interface ProductImageResponse {
  id: string;
  position: number;
  url: string;
}

/**
 * Product enriched with its images array.
 * Returned by findAll and findById after Slice 3.
 * Spec: product-catalog §"Producer product responses include images array".
 */
export type ProductWithImages = Product & { images: ProductImageResponse[] };

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateProductInput {
  categoryId: string;
  name: string;
  description: string;
  price: number;
  stock?: number;
  lowStockThreshold?: number;
  ingredients?: string | null;
  allergens?: string[];
  weight?: number | null;
  presentation?: string | null;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  price?: number;
  stock?: number;
  lowStockThreshold?: number;
  isActive?: boolean;
  ingredients?: string | null;
  allergens?: string[];
  weight?: number | null;
  presentation?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Non-terminal SubOrder statuses that block product deactivation/delete.
 * Spec: product-catalog §"Soft-delete guard against active order lines".
 */
const NON_TERMINAL_SUB_ORDER_STATUSES: SubOrderStatus[] = ["pending", "preparing", "sent"];

/**
 * Map a Prisma image row (with s3Key) to the wire shape (with url).
 * s3Key is dropped — never reaches the response body.
 * Spec: product-images §"Wire shape", §"URL derivation".
 * Design: Decision #4 — explicit construction, never spread.
 */
function mapImageRow(row: { id: string; position: number; s3Key: string }): ProductImageResponse {
  return { id: row.id, position: row.position, url: toImageUrl(row.s3Key) };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new product for the given producer.
 *
 * Rules enforced:
 *   - categoryId must exist and be active → CategoryNotFoundError (404) otherwise.
 *   - isActive=true, moderationStatus=OK (publish-on-create; no DRAFT state).
 *
 * Spec: product-catalog §"Publish-on-create lifecycle" + §"Product entity".
 */
export async function create(producerId: string, input: CreateProductInput): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    // Validate category exists and is active
    const category = await tx.category.findFirst({
      where: { id: input.categoryId, isActive: true },
    });
    if (!category) {
      throw new CategoryNotFoundError("Category not found or inactive");
    }

    return tx.product.create({
      data: {
        producerId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        price: input.price,
        stock: input.stock ?? 0,
        lowStockThreshold: input.lowStockThreshold ?? 5,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens ?? [],
        weight: input.weight ?? null,
        presentation: input.presentation ?? null,
        // Publish-on-create invariants
        isActive: true,
        moderationStatus: "OK" as ModerationStatus,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

/**
 * List all non-deleted products for a producer, ordered newest first.
 * Each product includes its images mapped to { id, position, url } — s3Key not exposed.
 * Images are ordered at DB level by position ASC then createdAt ASC.
 *
 * Spec: product-catalog §"RBAC-scoped ownership",
 *       §"Producer product responses include images array";
 *       product-images §"Deterministic ordering", §"Empty images state".
 * Design: Decision #3 (DB-level ordering), Decision #4 (service maps).
 */
export async function findAll(producerId: string): Promise<ProductWithImages[]> {
  const products = await prisma.product.findMany({
    where: { producerId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }],
    include: {
      images: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, position: true, s3Key: true },
      },
    },
  });

  return products.map((product) => ({
    ...product,
    images: product.images.map(mapImageRow),
  }));
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

/**
 * Get a single product owned by the producer.
 * Includes images mapped to { id, position, url } — s3Key not exposed.
 * Returns ProductNotFoundError (404) when not owned or soft-deleted (no-leak).
 *
 * Spec: product-catalog §"RBAC-scoped ownership",
 *       §"Producer product responses include images array";
 *       product-images §"Deterministic ordering", §"Empty images state".
 * Design: Decision #3 (DB-level ordering), Decision #4 (service maps).
 */
export async function findById(producerId: string, id: string): Promise<ProductWithImages> {
  const product = await prisma.product.findFirst({
    where: { id, producerId, deletedAt: null },
    include: {
      images: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, position: true, s3Key: true },
      },
    },
  });
  if (!product) {
    throw new ProductNotFoundError("Product not found");
  }
  return {
    ...product,
    images: product.images.map(mapImageRow),
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Partially update a product owned by the producer.
 *
 * Guards:
 *   - 404-no-leak on cross-producer or deleted products.
 *   - Blocks isActive→false when active (non-terminal) OrderLines exist.
 *
 * Spec: product-catalog §"RBAC-scoped ownership",
 *       §"Soft-delete guard against active order lines".
 */
export async function update(
  producerId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id, producerId, deletedAt: null },
    });
    if (!product) {
      throw new ProductNotFoundError("Product not found");
    }

    // Guard: isActive→false blocked by active OrderLines
    if (patch.isActive === false) {
      const activeOrderCount = await tx.orderLine.count({
        where: {
          productId: id,
          subOrder: { status: { in: NON_TERMINAL_SUB_ORDER_STATUSES } },
        },
      });
      if (activeOrderCount > 0) {
        throw new ProductHasActiveOrdersError(
          "Cannot deactivate product with active order lines",
        );
      }
    }

    return tx.product.update({ where: { id }, data: patch });
  });
}

// ---------------------------------------------------------------------------
// softDelete
// ---------------------------------------------------------------------------

/**
 * Soft-delete a product owned by the producer.
 *
 * Guards:
 *   - 404-no-leak on cross-producer or already-deleted products.
 *   - Blocked by non-terminal OrderLines → ProductHasActiveOrdersError (409).
 *   - Guard runs inside $transaction (spec invariant).
 *
 * Spec: product-catalog §"Soft-delete guard against active order lines".
 */
export async function softDelete(producerId: string, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id, producerId, deletedAt: null },
    });
    if (!product) {
      throw new ProductNotFoundError("Product not found");
    }

    const activeOrderCount = await tx.orderLine.count({
      where: {
        productId: id,
        subOrder: { status: { in: NON_TERMINAL_SUB_ORDER_STATUSES } },
      },
    });
    if (activeOrderCount > 0) {
      throw new ProductHasActiveOrdersError(
        "Cannot delete product with active order lines",
      );
    }

    await tx.product.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * Record a report against a product (first-report-wins semantics).
 *
 * Rules per spec product-reporting §"Report endpoint":
 *   - Finds product where moderationStatus != REMOVED (REMOVED → ProductNotFoundError 404).
 *   - If moderationStatus === OK: sets REPORTED + reportedAt + reportReason.
 *   - If moderationStatus === REPORTED: idempotent no-op (Decision #3 pattern).
 *   - Returns { productId, moderationStatus, reportedAt } shape via the full Product row.
 *
 * Spec: product-reporting §"Report endpoint", §"Second report is idempotent".
 */
export async function report(
  productId: string,
  reason: string,
): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, moderationStatus: { not: "REMOVED" as ModerationStatus }, deletedAt: null },
    });

    if (!product) {
      throw new ProductNotFoundError("Product not found or has been removed");
    }

    // Idempotent: already REPORTED → no-op, return current row (Decision #3)
    if (product.moderationStatus === "REPORTED") {
      return product;
    }

    // First report: transition OK → REPORTED
    return tx.product.update({
      where: { id: productId },
      data: {
        moderationStatus: "REPORTED" as ModerationStatus,
        reportedAt: new Date(),
        reportReason: reason,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Public catalog projection (public-catalog capability)
// ---------------------------------------------------------------------------

/**
 * Public-safe producer summary — nested address shape mirrors
 * producers.service.ts::PublicProducerProjection. PII fields (nif,
 * addressLine1/2, addressPostalCode, userId) are never selected — defense
 * in depth via the `select` whitelist below.
 */
export interface PublicProducerSummary {
  id: string;
  businessName: string;
  description: string;
  address: {
    city: string;
    province: string;
    country: string;
  };
}

/** Public-safe category summary. */
export interface PublicCategorySummary {
  id: string;
  slug: string;
  name: string;
}

/**
 * Public product projection returned by findAllPublic/findPublicById.
 * Spec: product-catalog... see public-catalog §"PUB-R4 — PII-safe projection shape".
 */
export interface PublicProductProjection {
  id: string;
  name: string;
  description: string;
  price: Product["price"];
  stock: number;
  ingredients: string | null;
  allergens: string[];
  weight: number | null;
  presentation: string | null;
  categoryId: string;
  createdAt: Date;
  images: ProductImageResponse[];
  category: PublicCategorySummary;
  producer: PublicProducerSummary;
}

/**
 * Visibility filter (SECURITY-CRITICAL) shared by findAllPublic and
 * findPublicById. A product is publicly visible ONLY when ALL four
 * conditions hold — dropping any condition is a security defect.
 * Spec: public-catalog §"PUB-R3 — Visibility exclusion filter".
 */
const PUBLIC_PRODUCT_WHERE = {
  deletedAt: null,
  isActive: true,
  moderationStatus: "OK" as ModerationStatus,
  producer: { deletedAt: null },
};

/**
 * Select whitelist for the public catalog projection.
 * `producer.select` is a PII-safety whitelist — NEVER replace with `include`.
 * Mirrors producers.service.ts::findPublicById's defense-in-depth approach.
 * Spec: public-catalog §"PUB-R4 — PII-safe projection shape".
 */
const PUBLIC_PRODUCT_SELECT = {
  id: true,
  name: true,
  description: true,
  price: true,
  stock: true,
  ingredients: true,
  allergens: true,
  weight: true,
  presentation: true,
  categoryId: true,
  createdAt: true,
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true, s3Key: true },
  },
  category: { select: { id: true, slug: true, name: true } },
  producer: {
    select: {
      id: true,
      businessName: true,
      description: true,
      addressCity: true,
      addressProvince: true,
      addressCountry: true,
    },
  },
} satisfies Prisma.ProductSelect;

type PublicProductRow = Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_SELECT }>;

/**
 * Map a raw public-select Prisma row to the wire-safe projection.
 * Reuses mapImageRow (s3Key → url) — single source of truth for image mapping.
 */
function mapPublicProduct(row: PublicProductRow): PublicProductProjection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    stock: row.stock,
    ingredients: row.ingredients,
    allergens: row.allergens,
    weight: row.weight,
    presentation: row.presentation,
    categoryId: row.categoryId,
    createdAt: row.createdAt,
    images: row.images.map(mapImageRow),
    category: row.category,
    producer: {
      id: row.producer.id,
      businessName: row.producer.businessName,
      description: row.producer.description,
      address: {
        city: row.producer.addressCity,
        province: row.producer.addressProvince,
        country: row.producer.addressCountry,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// findAllPublic
// ---------------------------------------------------------------------------

/**
 * List publicly visible products with optional category/availability
 * filters and price sort. No default filter beyond the four-condition
 * visibility gate — category is a filter param only (LOCKED design decision:
 * no active-category gate).
 *
 * Spec: public-catalog §"PUB-R1", §"PUB-R3", §"PUB-R4".
 */
export async function findAllPublic(
  query: ListPublicProductsQuery,
): Promise<PublicProductProjection[]> {
  const where: Prisma.ProductWhereInput = {
    ...PUBLIC_PRODUCT_WHERE,
    ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
    ...(query.available === true && { stock: { gt: 0 } }),
  };

  const orderBy: Prisma.ProductOrderByWithRelationInput =
    query.sort === "asc"
      ? { price: "asc" }
      : query.sort === "desc"
        ? { price: "desc" }
        : { createdAt: "desc" };

  const products = await prisma.product.findMany({
    where,
    orderBy,
    select: PUBLIC_PRODUCT_SELECT,
  });

  return products.map(mapPublicProduct);
}

// ---------------------------------------------------------------------------
// findPublicById
// ---------------------------------------------------------------------------

/**
 * Get a single publicly visible product by id.
 *
 * Hidden (soft-deleted, inactive, REPORTED/REMOVED moderation, or
 * soft-deleted producer) and non-existent ids both resolve to the same
 * ProductNotFoundError (404, no-leak) — identical pattern to
 * producers.service.ts::findPublicById.
 *
 * Spec: public-catalog §"PUB-R2", §"PUB-R3", §"PUB-R4".
 */
export async function findPublicById(id: string): Promise<PublicProductProjection> {
  const product = await prisma.product.findFirst({
    where: { id, ...PUBLIC_PRODUCT_WHERE },
    select: PUBLIC_PRODUCT_SELECT,
  });

  if (!product) {
    throw new ProductNotFoundError("Product not found");
  }

  return mapPublicProduct(product);
}
