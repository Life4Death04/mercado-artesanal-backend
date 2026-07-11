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
 *
 * All multi-row state transitions run inside `prisma.$transaction(async (tx) => { ... })`
 * callback form (NOT the array form) — required by the test mock strategy.
 *
 * Spec references:
 *   product-catalog  §"Publish-on-create lifecycle", §"RBAC-scoped ownership",
 *                    §"Soft-delete guard against active order lines",
 *                    §"Reactive-moderation data layer"
 *   product-reporting §"Report endpoint", §"Second report is idempotent",
 *                     §"Report on removed product rejected"
 *   design — Decision #8 (producerId from req.user), Decision #3 (idempotent no-op)
 */
import type { ModerationStatus, Product, SubOrderStatus } from "@prisma/client";

import {
  CategoryNotFoundError,
  ProductHasActiveOrdersError,
  ProductNotFoundError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

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
 * Spec: product-catalog §"RBAC-scoped ownership".
 */
export async function findAll(producerId: string): Promise<Product[]> {
  return prisma.product.findMany({
    where: { producerId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }],
  });
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

/**
 * Get a single product owned by the producer.
 * Returns ProductNotFoundError (404) when not owned or soft-deleted (no-leak).
 * Spec: product-catalog §"RBAC-scoped ownership".
 */
export async function findById(producerId: string, id: string): Promise<Product> {
  const product = await prisma.product.findFirst({
    where: { id, producerId, deletedAt: null },
  });
  if (!product) {
    throw new ProductNotFoundError("Product not found");
  }
  return product;
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
