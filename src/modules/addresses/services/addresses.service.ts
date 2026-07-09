/**
 * Addresses service — enforces address-book invariants (P-4).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via: `import * as addressService from "@/modules/addresses/services/addresses.service"`.
 *
 * Invariant P-4 (LOCKED):
 *   For any user U: count(addresses where userId=U AND deletedAt IS NULL AND isDefault=true)
 *   MUST be 0 (user has zero addresses) or 1 (otherwise). No other state is valid.
 *
 * All multi-row state transitions are wrapped in `prisma.$transaction(async (tx) => { ... })`
 * callback form (NOT the array form) — required by the test mock strategy.
 *
 * DB-level guard: the partial unique index `one_default_address_per_user` is the authoritative
 * race condition guard (R-2). If a concurrent write races past the service-layer checks,
 * Prisma throws P2002 scoped to that index, which is caught and translated to
 * AddressDefaultConflictError (409, retryable). Design §10.
 *
 * Spec references:
 *   address-book — CRUD, soft-delete, default invariant
 *   design §10 — transactional pseudocode (authoritative)
 *   R-2 — one_default_address_per_user partial unique index
 */
import type { Address } from "@prisma/client";

import { AddressDefaultConflictError, InvalidDefaultTransitionError, NotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateAddressInput {
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  province: string;
  country?: string;
  isDefault?: boolean;
}

export interface UpdateAddressInput {
  line1?: string;
  line2?: string | null;
  city?: string;
  postalCode?: string;
  province?: string;
  country?: string;
  isDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Translate a Prisma P2002 unique constraint violation to a typed AppError.
 * Only re-throws as AddressDefaultConflictError when the violated constraint
 * is `one_default_address_per_user`; all other P2002s are re-thrown as-is.
 */
function remapP2002(err: unknown): never {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  ) {
    const meta = (err as { meta?: { modelName?: string; target?: string | string[] } }).meta;
    const target = meta?.target;
    const isDefaultIndexViolation =
      target === "one_default_address_per_user" ||
      (Array.isArray(target) && target.includes("one_default_address_per_user"));

    if (isDefaultIndexViolation) {
      throw new AddressDefaultConflictError(
        "Concurrent update conflict: only one active default address per user is allowed. Please retry.",
      );
    }
  }
  throw err;
}

// ---------------------------------------------------------------------------
// list — GET /api/v1/users/me/addresses
// ---------------------------------------------------------------------------

/**
 * Return all non-deleted addresses for a user, ordered default-first then newest.
 * Spec: address-book §"List addresses".
 */
export async function list(userId: string): Promise<Address[]> {
  return prisma.address.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

// ---------------------------------------------------------------------------
// create — POST /api/v1/users/me/addresses
// ---------------------------------------------------------------------------

/**
 * Create a new address for the given user, enforcing P-4.
 *
 * - If the user has zero non-deleted addresses, force isDefault=true.
 * - If isDefault=true is requested and others exist, demote them first (same tx).
 * - Catches P2002 on the partial unique index and throws AddressDefaultConflictError.
 *
 * Spec: address-book §"Create address". Design §10 POST pseudocode.
 */
export async function create(userId: string, input: CreateAddressInput): Promise<Address> {
  try {
    return await prisma.$transaction(async (tx) => {
      const activeCount = await tx.address.count({ where: { userId, deletedAt: null } });
      const shouldForceDefault = activeCount === 0;
      const targetDefault = shouldForceDefault || input.isDefault === true;

      if (targetDefault && activeCount > 0) {
        await tx.address.updateMany({
          where: { userId, deletedAt: null, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.address.create({
        data: {
          userId,
          line1: input.line1,
          line2: input.line2 ?? null,
          city: input.city,
          postalCode: input.postalCode,
          province: input.province,
          country: input.country ?? "ES",
          isDefault: targetDefault,
        },
      });
    });
  } catch (err) {
    remapP2002(err);
  }
}

// ---------------------------------------------------------------------------
// update — PATCH /api/v1/users/me/addresses/:id
// ---------------------------------------------------------------------------

/**
 * Patch an existing address. Enforces:
 *   - 404-no-leak: address must belong to userId and not be soft-deleted.
 *   - Demotion guard: isDefault=false on the current default → 422 INVALID_DEFAULT_TRANSITION.
 *   - Promotion: isDefault=true demotes the previous default first (same tx).
 *
 * Spec: address-book §"Update address". Design §10 PATCH pseudocode.
 */
export async function update(userId: string, id: string, patch: UpdateAddressInput): Promise<Address> {
  try {
    return await prisma.$transaction(async (tx) => {
      const target = await tx.address.findFirst({ where: { id, userId, deletedAt: null } });
      if (!target) throw new NotFoundError("Address not found");

      if (patch.isDefault === false && target.isDefault) {
        throw new InvalidDefaultTransitionError("Promote another address instead");
      }

      if (patch.isDefault === true && !target.isDefault) {
        await tx.address.updateMany({
          where: { userId, deletedAt: null, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }

      return tx.address.update({ where: { id }, data: patch });
    });
  } catch (err) {
    // Do not remap AppErrors — only remap P2002 constraint violations.
    if (err instanceof NotFoundError || err instanceof InvalidDefaultTransitionError) {
      throw err;
    }
    remapP2002(err);
  }
}

// ---------------------------------------------------------------------------
// softDeleteWithPromotion — DELETE /api/v1/users/me/addresses/:id
// ---------------------------------------------------------------------------

/**
 * Soft-delete an address and auto-promote the most-recently-created sibling
 * if the deleted address was the default (O-1 LOCKED).
 *
 * - 404-no-leak: address must belong to userId and not be already soft-deleted.
 * - Sets deletedAt=now() and isDefault=false on the target.
 * - If the target was default and a sibling exists, promotes the newest (createdAt DESC, id DESC).
 *
 * Spec: address-book §"Delete address (soft) with auto-promotion". Design §10 DELETE pseudocode.
 */
export async function softDeleteWithPromotion(userId: string, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.address.findFirst({ where: { id, userId, deletedAt: null } });
    if (!target) throw new NotFoundError("Address not found");

    await tx.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });

    if (target.isDefault) {
      const promote = await tx.address.findFirst({
        where: { userId, deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (promote) {
        await tx.address.update({ where: { id: promote.id }, data: { isDefault: true } });
      }
    }
  });
}
