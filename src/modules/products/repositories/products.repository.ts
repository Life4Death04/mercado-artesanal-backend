/**
 * Products repository — narrow Prisma accessor for the Product model.
 *
 * Repository contract (per design §3 + architecture):
 *   - Every producer-scoped read MUST filter `deletedAt: null` AND `producerId`.
 *   - Report reads filter by `moderationStatus: { not: 'REMOVED' }`.
 *   - All mutating operations are composed by the service inside
 *     `prisma.$transaction(async (tx) => { ... })` callback form.
 *   - No business logic lives here — invariant enforcement belongs in
 *     products.service.ts.
 *
 * Spec references:
 *   product-catalog  §"RBAC-scoped ownership", §"Reactive-moderation data layer"
 *   product-reporting §"Report endpoint"
 *   design §3 — repository layer
 */
import type { ModerationStatus, Prisma, Product } from "@prisma/client";

import { prisma } from "@/shared/utils/prisma";

// Minimal type accepted wherever a Prisma transaction client is expected.
export type PrismaTx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find all non-deleted products for a given producer, ordered newest first.
 * Spec: product-catalog §"RBAC-scoped ownership" — reads filter by producerId.
 */
export async function findManyByProducer(
  producerId: string,
  tx?: PrismaTx,
): Promise<Product[]> {
  const client = tx ?? prisma;
  return client.product.findMany({
    where: { producerId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }],
  });
}

/**
 * Find a single non-deleted product owned by the given producer.
 * Returns null when not found or owned by another producer (404-no-leak).
 */
export async function findActiveByIdAndProducer(
  id: string,
  producerId: string,
  tx?: PrismaTx,
): Promise<Product | null> {
  const client = tx ?? prisma;
  return client.product.findFirst({
    where: { id, producerId, deletedAt: null },
  });
}

/**
 * Find a product by id that is NOT removed (for the report endpoint).
 * Returns null when not found or moderationStatus === REMOVED.
 * Spec: product-reporting §"Report on removed product rejected".
 */
export async function findReportable(id: string, tx?: PrismaTx): Promise<Product | null> {
  const client = tx ?? prisma;
  return client.product.findFirst({
    where: { id, moderationStatus: { not: "REMOVED" as ModerationStatus }, deletedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Insert a new product row.
 * The caller (service) sets isActive=true and moderationStatus=OK (publish-on-create).
 */
export async function create(
  data: {
    producerId: string;
    categoryId: string;
    name: string;
    description: string;
    price: number | string;
    stock: number;
    lowStockThreshold?: number;
    ingredients?: string | null;
    allergens?: string[];
    weight?: number | null;
    presentation?: string | null;
    isActive: boolean;
    moderationStatus: ModerationStatus;
  },
  tx?: PrismaTx,
): Promise<Product> {
  const client = tx ?? prisma;
  return client.product.create({ data: { ...data } });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update fields on an existing product row.
 * The caller is responsible for ownership and invariant checks before calling.
 */
export async function update(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    price: number | string;
    stock: number;
    lowStockThreshold: number;
    isActive: boolean;
    ingredients: string | null;
    allergens: string[];
    weight: number | null;
    presentation: string | null;
    deletedAt: Date | null;
    moderationStatus: ModerationStatus;
    reportedAt: Date | null;
    reportReason: string | null;
  }>,
  tx?: PrismaTx,
): Promise<Product> {
  const client = tx ?? prisma;
  return client.product.update({ where: { id }, data });
}
