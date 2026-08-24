/**
 * Account lifecycle — the single source of truth for deriving a User's
 * lifecycle state from its timestamp columns, and for the shared Prisma
 * predicate every commerce/identity read reuses to gate on it.
 *
 * Design Decision "Boolean vs timestamps": `deletedAt`/`deactivatedAt` are
 * timestamps, not booleans — `deriveAccountState` is the ONLY place that
 * interprets their precedence. Deleted always wins over deactivated, and a
 * deletion tombstone MUST NEVER be reversed (account-lifecycle spec
 * §"Derived lifecycle state" — "Deleted state cannot be resurrected").
 *
 * `ACTIVE_USER_WHERE` is the shared Prisma `where` fragment every commerce
 * and identity query composes to filter to ACTIVE users only — the single
 * predicate object referenced by loadUser, user.repository, auth.service,
 * and every producer-owner lifecycle gate in products/producers/cart/orders/
 * payments (design "Centralize predicates and User-row locks").
 *
 * Spec references:
 *   account-lifecycle §"Derived lifecycle state"
 *   account-lifecycle §"Backend-wide lifecycle denial"
 *   account-lifecycle §"Commerce lifecycle consistency"
 *   design — Architecture Decisions, "Boolean vs timestamps"
 */
import type { Prisma } from "@prisma/client";

import { AccountInactiveError, CartItemNotAvailableError } from "@/shared/errors/errors";
import { lockUserRows } from "@/shared/utils/user-row-lock";

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

export type AccountState = "ACTIVE" | "DEACTIVATED" | "DELETED";

/** Minimal shape every caller can supply — a User row projection or full row. */
export interface AccountLifecycleFields {
  deletedAt: Date | null;
  deactivatedAt: Date | null;
}

/**
 * Derives the account lifecycle state from its timestamp columns.
 *
 * Precedence (design Decision "Boolean vs timestamps"): `deletedAt` wins
 * over `deactivatedAt` — a tombstoned account is ALWAYS `DELETED`, even if
 * `deactivatedAt` is also set (e.g. it was deactivated before deletion).
 * This precedence MUST NEVER be reversed by any caller.
 *
 * Spec: account-lifecycle §"Derived lifecycle state"
 */
export function deriveAccountState(user: AccountLifecycleFields): AccountState {
  if (user.deletedAt !== null) {
    return "DELETED";
  }
  if (user.deactivatedAt !== null) {
    return "DEACTIVATED";
  }
  return "ACTIVE";
}

/** True only for `ACTIVE` — the single boolean gate every caller should use. */
export function isAccountActive(user: AccountLifecycleFields): boolean {
  return deriveAccountState(user) === "ACTIVE";
}

// ---------------------------------------------------------------------------
// Shared Prisma predicate
// ---------------------------------------------------------------------------

/**
 * Shared `where` fragment for "this User is ACTIVE" — spread into every
 * commerce/identity query that must gate on the owning User's lifecycle
 * (design "Centralize predicates and User-row locks").
 *
 * Usage: `where: { ...ACTIVE_USER_WHERE, id: userId }` or nested under a
 * relation: `where: { producer: { user: ACTIVE_USER_WHERE } }`.
 */
export const ACTIVE_USER_WHERE: Prisma.UserWhereInput = {
  deletedAt: null,
  deactivatedAt: null,
};

// ---------------------------------------------------------------------------
// Locked commerce owner-lifecycle guard
// ---------------------------------------------------------------------------

type PrismaTx = Prisma.TransactionClient;

/**
 * Locks the complete consumer + producer-owner User set (via `lockUserRows`,
 * deadlock-safe ascending-id order) and asserts every one of them is
 * ACTIVE, inside the CALLER's transaction.
 *
 * This is the shared "locked preflight" primitive checkout call sites
 * compose (design "Post-Stripe snapshot vs locked preflight" — "Compute the
 * fingerprint and upsert immutable PendingCheckout address content while
 * all consumer/producer User locks are held and active"; "createOrderFromPayment
 * locks the same set before availability/order writes"). Checkout therefore
 * either wins first (locks acquired, still active, proceeds) or a concurrent
 * admin lifecycle transition wins (also needs the SAME row lock to write
 * `deactivatedAt`/`deletedAt` — see admin-users.service.ts) and this
 * function observes the now-inactive state and fails closed.
 *
 * @param tx - the caller's transaction (locks are meaningless outside one).
 * @param consumerUserId - the checking-out consumer's own User id.
 * @param producerIds - every distinct Producer id represented in the cart
 *   (this function resolves each to its owning `userId` internally).
 * @throws {AccountInactiveError} when the CONSUMER is not ACTIVE.
 * @throws {CartItemNotAvailableError} when ANY producer owner is not ACTIVE
 *   (mirrors the existing cart/checkout "unavailable item" error family —
 *   a single inactive owner makes their items unavailable, all-or-nothing).
 */
export async function lockAndAssertOwnersActive(
  tx: PrismaTx,
  consumerUserId: string,
  producerIds: string[],
): Promise<void> {
  const uniqueProducerIds = [...new Set(producerIds)];

  const producers =
    uniqueProducerIds.length > 0
      ? await tx.producer.findMany({
          where: { id: { in: uniqueProducerIds } },
          select: { id: true, userId: true },
        })
      : [];
  const ownerUserIds = producers.map((producer) => producer.userId);

  const allUserIds = [consumerUserId, ...ownerUserIds];
  await lockUserRows(tx, allUserIds);

  const users = await tx.user.findMany({
    where: { id: { in: [...new Set(allUserIds)] } },
    select: { id: true, deletedAt: true, deactivatedAt: true },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  const consumer = userById.get(consumerUserId);
  if (!consumer || !isAccountActive(consumer)) {
    throw new AccountInactiveError();
  }

  for (const ownerId of ownerUserIds) {
    const owner = userById.get(ownerId);
    if (!owner || !isAccountActive(owner)) {
      throw new CartItemNotAvailableError("One or more cart items are no longer available");
    }
  }
}
