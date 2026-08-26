/**
 * User repository — the single shared data-access path for the User model.
 *
 * All three feature modules (auth, users, onboarding) import from this file;
 * no feature module may import from another feature module directly (module
 * boundary rule from design §3).
 *
 * Repository contract:
 *   - Every read MUST filter to ACTIVE users (`ACTIVE_USER_WHERE` — J-1,
 *     extended by admin-user-management to also exclude `deactivatedAt`)
 *     UNLESS the method name says otherwise (e.g. `findByAuth0SubAny`).
 *   - findByAuth0Sub / upsertOnSync are the only "create user" paths (P-3).
 *   - updateRole is owned by the onboarding service; auth/sync MUST NOT call it.
 *   - All methods accept an optional Prisma transaction client (tx) so the
 *     onboarding service can compose them inside a $transaction.
 *
 * Spec references:
 *   auth-jwt — first-sync creates with PENDING_ROLE; sub is immutable key
 *   user-profile — re-sync updates ONLY emailVerified (P-3)
 *   user-onboarding — role transition is atomic and owned by onboarding service
 *   user-profile §"POST /auth/sync — idempotent user upsert" (admin-user-management delta)
 */
import type { Prisma, User } from "@prisma/client";

import { ACTIVE_USER_WHERE } from "@/shared/account-lifecycle";
import { normalizeEmail } from "@/shared/utils/normalize-email";
import { prisma } from "@/shared/utils/prisma";

// Minimal type accepted wherever a Prisma transaction client is expected.
type PrismaTx = Prisma.TransactionClient;

const profileInclude = {
  producer: {
    where: { deletedAt: null },
    include: {
      categories: {
        include: { category: true },
      },
    },
  },
} satisfies Prisma.UserInclude;

type UserWithProducer = Prisma.UserGetPayload<{ include: typeof profileInclude }>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find an ACTIVE (non-deleted, non-deactivated) User by their Auth0 subject
 * identifier. Returns null when no row exists OR the row is not ACTIVE —
 * callers that must distinguish "absent" from "tombstoned/deactivated"
 * (e.g. auth.service's sync flow) MUST use `findByAuth0SubAny` instead.
 */
export async function findByAuth0Sub(sub: string, tx?: PrismaTx): Promise<User | null> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { auth0Sub: sub, ...ACTIVE_USER_WHERE },
  });
}

/**
 * Find a User by Auth0 subject INCLUDING tombstoned and deactivated rows —
 * the ONLY repository read that does not filter on lifecycle state.
 *
 * Used exclusively by `auth.service.syncFromClaims`, which MUST distinguish
 * "no user yet" (first-sync path) from "a lifecycle-inactive match exists"
 * (stable lifecycle denial, never recreated) — the two cases require
 * different responses and neither may be conflated with the other.
 *
 * Spec: user-profile §"POST /auth/sync — idempotent user upsert" —
 * "look up every local User matching req.auth.sub, including tombstones".
 */
export async function findByAuth0SubAny(sub: string, tx?: PrismaTx): Promise<User | null> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { auth0Sub: sub },
  });
}

/**
 * Find an ACTIVE (non-deleted, non-deactivated) User by their internal CUID id.
 * Returns null when the user does not exist, is soft-deleted, or is deactivated.
 */
export async function findById(id: string, tx?: PrismaTx): Promise<User | null> {
  const client = tx ?? prisma;
  return client.user.findFirst({
    where: { id, ...ACTIVE_USER_WHERE },
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
    where: { id, ...ACTIVE_USER_WHERE },
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
      email: normalizeEmail(data.email),
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

/** Update only the editable personal profile fields of an ACTIVE user. */
export async function updateProfile(
  id: string,
  data: { firstName?: string; lastName?: string },
  tx?: PrismaTx,
): Promise<UserWithProducer | null> {
  if (tx) return updateProfileInTransaction(tx, id, data);
  return prisma.$transaction((transaction) => updateProfileInTransaction(transaction, id, data));
}

async function updateProfileInTransaction(
  tx: PrismaTx,
  id: string,
  data: { firstName?: string; lastName?: string },
): Promise<UserWithProducer | null> {
  const { count } = await tx.user.updateMany({
    where: { id, ...ACTIVE_USER_WHERE },
    data,
  });

  if (count === 0) return null;

  return tx.user.findFirst({
    where: { id, ...ACTIVE_USER_WHERE },
    include: profileInclude,
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
 * Update firstName + lastName and flip the user's role to PRODUCER after the Producer row has been created.
 * MUST be called inside the same $transaction as Producer creation.
 */
export async function completeProducerOnboarding(
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
      role: "PRODUCER",
    },
  });
}
