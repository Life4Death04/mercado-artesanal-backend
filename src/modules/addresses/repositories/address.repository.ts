/**
 * Address repository — narrow Prisma accessor for the Address model.
 *
 * Repository contract (per J-1 + design §10):
 *   - Every read MUST filter `deletedAt: null` explicitly.
 *   - All mutating operations are composed by the service inside a
 *     `prisma.$transaction(async (tx) => { ... })` callback; methods
 *     accept an optional Prisma transaction client so the service can
 *     pass `tx` without breaking the abstraction layer.
 *   - No business logic lives here — invariant enforcement belongs in
 *     addresses.service.ts (design §3, RNF-16).
 *
 * Spec references:
 *   address-book — owner-scoped CRUD, soft-delete reads, default invariant
 *   design §10 — transactional patterns
 *   R-2 — one_default_address_per_user partial unique index
 */
import type { Address, Prisma } from "@prisma/client";

import { prisma } from "@/shared/utils/prisma";

// Minimal type accepted wherever a Prisma transaction client is expected.
type PrismaTx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find all non-deleted addresses for a given user.
 * Ordered by isDefault DESC (default first), then createdAt DESC (newest next).
 * Spec: address-book §"List addresses" — "Default first, then newest".
 */
export async function findManyActive(userId: string, tx?: PrismaTx): Promise<Address[]> {
  const client = tx ?? prisma;
  return client.address.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Find a single non-deleted address that belongs to the given user.
 * Returns null when not found or when it belongs to a different user (404-no-leak).
 */
export async function findActiveByIdAndUser(
  id: string,
  userId: string,
  tx?: PrismaTx,
): Promise<Address | null> {
  const client = tx ?? prisma;
  return client.address.findFirst({
    where: { id, userId, deletedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/**
 * Count non-deleted addresses for a given user.
 * Used by the create service to determine auto-default logic.
 */
export async function countActive(userId: string, tx?: PrismaTx): Promise<number> {
  const client = tx ?? prisma;
  return client.address.count({ where: { userId, deletedAt: null } });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new address row.
 * The caller (service) controls `isDefault`; no auto-defaulting here.
 */
export async function create(
  data: {
    userId: string;
    line1: string;
    line2?: string | null;
    city: string;
    postalCode: string;
    province: string;
    country?: string;
    isDefault: boolean;
  },
  tx?: PrismaTx,
): Promise<Address> {
  const client = tx ?? prisma;
  return client.address.create({ data });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update fields on an existing address row.
 * The caller is responsible for ownership and invariant checks before calling.
 */
export async function update(
  id: string,
  data: Partial<{
    line1: string;
    line2: string | null;
    city: string;
    postalCode: string;
    province: string;
    country: string;
    isDefault: boolean;
    deletedAt: Date | null;
  }>,
  tx?: PrismaTx,
): Promise<Address> {
  const client = tx ?? prisma;
  return client.address.update({ where: { id }, data });
}

/**
 * Demote all currently-default addresses for a user.
 * Used inside transactions before promoting a new default.
 */
export async function demoteDefaults(
  userId: string,
  excludeId?: string,
  tx?: PrismaTx,
): Promise<Prisma.BatchPayload> {
  const client = tx ?? prisma;
  return client.address.updateMany({
    where: {
      userId,
      deletedAt: null,
      isDefault: true,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    data: { isDefault: false },
  });
}

/**
 * Find the most-recently-created non-deleted address for a user, excluding a specific id.
 * Used for auto-promotion after soft-deleting the default address (O-1 rule).
 */
export async function findNewestActive(
  userId: string,
  excludeId: string,
  tx?: PrismaTx,
): Promise<Address | null> {
  const client = tx ?? prisma;
  return client.address.findFirst({
    where: { userId, deletedAt: null, NOT: { id: excludeId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
