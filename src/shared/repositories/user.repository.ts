/**
 * User repository — the single shared data-access path for the User model.
 *
 * All three feature modules (auth, users, onboarding) import from this file;
 * no feature module may import from another feature module directly (module
 * boundary rule from design §3).
 *
 * Repository contract:
 *   - Every read MUST filter `deletedAt: null` (J-1).
 *   - findByAuth0Sub / upsertOnSync are the only "create user" paths (P-3).
 *   - updateRole is owned by the onboarding service; auth/sync MUST NOT call it.
 *   - All methods accept an optional Prisma transaction client (tx) so the
 *     onboarding service can compose them inside a $transaction.
 *
 * Spec references:
 *   auth-jwt — first-sync creates with PENDING_ROLE; sub is immutable key
 *   user-profile — re-sync updates ONLY emailVerified (P-3)
 *   user-onboarding — role transition is atomic and owned by onboarding service
 */
import type { Prisma, User } from "@prisma/client";

import { prisma } from "@/shared/utils/prisma";

// Minimal type accepted wherever a Prisma transaction client is expected.
type PrismaTx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find a non-deleted User by their Auth0 subject identifier.
 * Returns null when no row exists (first-sync path).
 */
export async function findByAuth0Sub(sub: string, tx?: PrismaTx): Promise<User | null> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { auth0Sub: sub, deletedAt: null },
  });
}

/**
 * Find a non-deleted User by their internal CUID id.
 * Returns null when the user does not exist or is soft-deleted.
 */
export async function findById(id: string, tx?: PrismaTx): Promise<User | null> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { id, deletedAt: null },
  });
}

/**
 * Find a non-deleted User with their Producer and category links included.
 * Used by GET /users/me to build the full profile shape.
 */
export async function findByIdWithProducer(
  id: string,
  tx?: PrismaTx,
): Promise<
  | (User & {
      producer: Prisma.ProducerGetPayload<{
        include: { categories: { include: { category: true } } };
      }> | null;
    })
  | null
> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { id, deletedAt: null },
    include: {
      producer: {
        where: { deletedAt: null },
        include: {
          categories: {
            include: { category: true },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new User from Auth0 claims (first-sync path only).
 *
 * Sets role = PENDING_ROLE, all name fields null.
 * Callers MUST ensure email is present before calling this (P-3).
 */
export async function create(
  data: {
    auth0Sub: string;
    email: string;
    emailVerified: boolean;
  },
  tx?: PrismaTx,
): Promise<User> {
  const client = tx ?? prisma;
  return client.user.create({
    data: {
      auth0Sub: data.auth0Sub,
      email: data.email,
      emailVerified: data.emailVerified,
      role: "PENDING_ROLE",
      firstName: null,
      lastName: null,
      name: null,
      avatar: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Update — narrow methods; each is responsible for exactly one invariant
// ---------------------------------------------------------------------------

/**
 * Update ONLY emailVerified (re-sync path, P-3 LOCKED).
 *
 * email, role, firstName, lastName, name, avatar MUST NOT be modified here.
 */
export async function updateEmailVerified(
  id: string,
  emailVerified: boolean,
  tx?: PrismaTx,
): Promise<User> {
  const client = tx ?? prisma;
  return client.user.update({
    where: { id },
    data: { emailVerified },
  });
}

/**
 * Update firstName + lastName + role for consumer onboarding.
 * MUST only be called when user.role === PENDING_ROLE (enforced by service).
 */
export async function completeConsumerOnboarding(
  id: string,
  data: { firstName: string; lastName: string },
  tx?: PrismaTx,
): Promise<User> {
  const client = tx ?? prisma;
  return client.user.update({
    where: { id },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      role: "CONSUMER",
    },
  });
}

/**
 * Flip the user's role to PRODUCER after the Producer row has been created.
 * MUST be called inside the same $transaction as Producer creation.
 */
export async function completeProducerOnboarding(id: string, tx?: PrismaTx): Promise<User> {
  const client = tx ?? prisma;
  return client.user.update({
    where: { id },
    data: { role: "PRODUCER" },
  });
}
