/**
 * Admin Users service — ADMIN-only discovery, detail/activity, and guarded
 * lifecycle administration of CONSUMER/PRODUCER accounts
 * (admin-user-management WU2-WU4).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as adminUsersService from "@/modules/admin/services/admin-users.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma delegates
 * directly per ADR-003, mirroring admin-incidents.service.ts.
 *
 * Every mutating export locks the target User row first (`lockUserRows`,
 * design "Lock, then timestamp-constrained updateMany") — this is the SAME
 * row lock `lockAndAssertOwnersActive` (checkout preflight) and other admin
 * transitions take, so a concurrent checkout and a concurrent admin
 * lifecycle transition against the SAME user can never interleave
 * unsafely (account-lifecycle spec §"Commerce lifecycle consistency").
 *
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 *   account-lifecycle §"Derived lifecycle state"
 *   account-lifecycle §"Approved tombstone redaction"
 *   notifications §"Event-to-Recipient Emission Mapping" — Activation
 *   error-handling §"Account lifecycle error contract"
 *   design — Architecture Decisions, Data Flow, Interfaces / Contracts
 */
import type { Prisma, Role, SubOrderStatus } from "@prisma/client";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import type { PendingEmail } from "@/modules/notifications/services/notifications.service";
import { deriveAccountState } from "@/shared/account-lifecycle";
import {
  AccountDeletedError,
  NotFoundError,
  UserHasActiveOrdersError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";
import { lockUserRows } from "@/shared/utils/user-row-lock";

import type {
  ListUsersQuery,
  PaginatedUsers,
  UserActivityView,
  UserDetailRow,
  UserDetailView,
  UserSummaryRow,
  UserSummaryView,
} from "../dto/admin-users.dto";
import { ADMIN_USERS_PAGE_SIZE, mapUserDetailView, mapUserSummaryView } from "../dto/admin-users.dto";

type PrismaTx = Prisma.TransactionClient;
type PrismaClientOrTx = typeof prisma | PrismaTx;

/** The only two roles ADMIN discovery/lifecycle administration ever exposes. */
const ACTIONABLE_ROLES: Role[] = ["CONSUMER", "PRODUCER"];

/** Non-terminal SubOrder statuses — "active order" per every spec reference in this module. */
const ACTIVE_SUB_ORDER_STATUSES: SubOrderStatus[] = ["pending", "preparing", "sent"];

// ---------------------------------------------------------------------------
// Shared row shapes / selects
// ---------------------------------------------------------------------------

interface LifecycleUserRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deactivatedAt: Date | null;
  emailVerified: boolean;
  avatar: string | null;
  producer: { id: string; businessName: string } | null;
}

const USER_LIFECYCLE_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  name: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deactivatedAt: true,
  emailVerified: true,
  avatar: true,
  producer: { select: { id: true, businessName: true } },
} satisfies Prisma.UserSelect;

function toSummaryRow(row: LifecycleUserRow): UserSummaryRow {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    name: row.name,
    role: row.role as "CONSUMER" | "PRODUCER",
    status: deriveAccountState(row),
    createdAt: row.createdAt,
    producer: row.producer,
  };
}

/**
 * Resolves activity counts for the target user (admin-user-management
 * §"User detail and activity definitions"):
 *   - PRODUCER: `orderCount` = producer-scoped SubOrder count;
 *     `publishedProductCount` = non-deleted, active, non-REMOVED products.
 *   - CONSUMER: `orderCount` = distinct aggregate Order count owned by the
 *     user; `publishedProductCount` = 0 (not applicable).
 *   - Both: `activeOrderCount` = non-terminal (pending|preparing|sent)
 *     SubOrder count scoped to the account's own orders.
 */
async function computeActivity(
  client: PrismaClientOrTx,
  user: LifecycleUserRow,
): Promise<UserActivityView> {
  if (user.role === "PRODUCER" && user.producer) {
    const producerId = user.producer.id;
    const [orderCount, publishedProductCount, activeOrderCount] = await Promise.all([
      client.subOrder.count({ where: { producerId } }),
      client.product.count({
        where: { producerId, deletedAt: null, isActive: true, moderationStatus: { not: "REMOVED" } },
      }),
      client.subOrder.count({ where: { producerId, status: { in: ACTIVE_SUB_ORDER_STATUSES } } }),
    ]);
    return { orderCount, publishedProductCount, activeOrderCount };
  }

  const [orderCount, activeOrderCount] = await Promise.all([
    client.order.count({ where: { userId: user.id } }),
    client.subOrder.count({
      where: { order: { userId: user.id }, status: { in: ACTIVE_SUB_ORDER_STATUSES } },
    }),
  ]);
  return { orderCount, publishedProductCount: 0, activeOrderCount };
}

async function buildDetailView(client: PrismaClientOrTx, user: LifecycleUserRow): Promise<UserDetailView> {
  const activity = await computeActivity(client, user);
  const detailRow: UserDetailRow = {
    ...toSummaryRow(user),
    emailVerified: user.emailVerified,
    avatar: user.avatar,
    updatedAt: user.updatedAt,
    activity,
  };
  return mapUserDetailView(detailRow);
}

/** `activeOrderCount` only — the deletion guard doesn't need the full activity view. */
async function countActiveOrders(client: PrismaClientOrTx, user: LifecycleUserRow): Promise<number> {
  if (user.role === "PRODUCER" && user.producer) {
    return client.subOrder.count({
      where: { producerId: user.producer.id, status: { in: ACTIVE_SUB_ORDER_STATUSES } },
    });
  }
  return client.subOrder.count({
    where: { order: { userId: user.id }, status: { in: ACTIVE_SUB_ORDER_STATUSES } },
  });
}

async function findActionableUser(
  client: PrismaClientOrTx,
  id: string,
): Promise<LifecycleUserRow | null> {
  return client.user.findFirst({
    where: { id, role: { in: ACTIONABLE_ROLES } },
    select: USER_LIFECYCLE_SELECT,
  });
}

// ---------------------------------------------------------------------------
// listUsers — GET /admin/users
// ---------------------------------------------------------------------------

/**
 * Deterministic, page-8 ADMIN discovery over CONSUMER/PRODUCER accounts
 * only. `createdAt DESC, id DESC` tie-break keeps repeat pages stable even
 * when multiple accounts share a creation timestamp.
 *
 * Spec: admin-user-management §"Deterministic user discovery".
 */
export async function listUsers(query: ListUsersQuery): Promise<PaginatedUsers<UserSummaryView>> {
  const where: Prisma.UserWhereInput = {
    role: { in: query.role ? [query.role] : ACTIONABLE_ROLES },
  };

  if (query.status === "ACTIVE") {
    where.deletedAt = null;
    where.deactivatedAt = null;
  } else if (query.status === "DEACTIVATED") {
    where.deletedAt = null;
    where.deactivatedAt = { not: null };
  } else if (query.status === "DELETED") {
    where.deletedAt = { not: null };
  }

  if (query.search) {
    const term = query.search;
    where.OR = [
      { email: { contains: term, mode: "insensitive" } },
      { firstName: { contains: term, mode: "insensitive" } },
      { lastName: { contains: term, mode: "insensitive" } },
      { name: { contains: term, mode: "insensitive" } },
      { producer: { businessName: { contains: term, mode: "insensitive" } } },
    ];
  }

  const skip = (query.page - 1) * ADMIN_USERS_PAGE_SIZE;

  const [rows, totalItems] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: ADMIN_USERS_PAGE_SIZE,
      select: USER_LIFECYCLE_SELECT,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    items: rows.map((row) => mapUserSummaryView(toSummaryRow(row))),
    page: query.page,
    pageSize: ADMIN_USERS_PAGE_SIZE,
    totalItems,
    totalPages: Math.ceil(totalItems / ADMIN_USERS_PAGE_SIZE),
  };
}

// ---------------------------------------------------------------------------
// getUserDetail — GET /admin/users/:id
// ---------------------------------------------------------------------------

/**
 * Actionable-user detail + derived lifecycle status + activity summary.
 * Not scoped by lifecycle state — an ADMIN may read a deactivated or
 * deleted (tombstoned) actionable user's detail.
 *
 * Spec: admin-user-management §"User detail and activity definitions".
 */
export async function getUserDetail(id: string): Promise<UserDetailView> {
  const user = await findActionableUser(prisma, id);
  if (!user) {
    throw new NotFoundError("User not found");
  }
  return buildDetailView(prisma, user);
}

// ---------------------------------------------------------------------------
// activateUser — PATCH /admin/users/:id/activate
// ---------------------------------------------------------------------------

export interface UserTransitionResult {
  detail: UserDetailView;
  pendingEmails: PendingEmail[];
}

/**
 * Idempotent DEACTIVATED -> ACTIVE transition. An already-ACTIVE user is a
 * no-op success. A DELETED (tombstoned) target rejects with
 * `AccountDeletedError` (409 ACCOUNT_DELETED) — deletion is irreversible
 * and MUST NEVER be undone via activation.
 *
 * Only the DEACTIVATED -> ACTIVE transition emits exactly one
 * `ACCOUNT_ACTIVATED` notification, committed atomically with the state
 * change (notifications spec "Activation is atomic and unique").
 *
 * Spec: admin-user-management §"Guarded lifecycle actions" — "Repeated
 *   transition is idempotent".
 * Spec: error-handling §"Tombstone activation receives conflict".
 */
export async function activateUser(id: string): Promise<UserTransitionResult> {
  return prisma.$transaction(async (tx) => {
    await lockUserRows(tx, [id]);

    const user = await findActionableUser(tx, id);
    if (!user) {
      throw new NotFoundError("User not found");
    }

    const state = deriveAccountState(user);

    if (state === "DELETED") {
      throw new AccountDeletedError();
    }

    if (state === "ACTIVE") {
      // Idempotent no-op — same-state calls never write or notify.
      return { detail: await buildDetailView(tx, user), pendingEmails: [] };
    }

    // Conditional claim — only a row still DEACTIVATED at write time is
    // claimed; a concurrent winner (another admin request, or a losing
    // race against this same call) is excluded, producing count 0 below.
    const { count } = await tx.user.updateMany({
      where: { id, deletedAt: null, deactivatedAt: { not: null } },
      data: { deactivatedAt: null },
    });

    if (count === 0) {
      // Raced — re-read and resolve as whatever state won (idempotent
      // either way: ACTIVE now, or DELETED if a concurrent deletion won).
      const raced = await findActionableUser(tx, id);
      if (!raced) {
        throw new NotFoundError("User not found");
      }
      if (deriveAccountState(raced) === "DELETED") {
        throw new AccountDeletedError();
      }
      return { detail: await buildDetailView(tx, raced), pendingEmails: [] };
    }

    const pendingEmails: PendingEmail[] = [
      await notificationsService.createNotification(tx, {
        userId: id,
        type: "ACCOUNT_ACTIVATED",
        toEmail: user.email,
      }),
    ];

    const activated = await findActionableUser(tx, id);
    if (!activated) {
      throw new NotFoundError("User not found");
    }

    return { detail: await buildDetailView(tx, activated), pendingEmails };
  });
}

// ---------------------------------------------------------------------------
// deactivateUser — PATCH /admin/users/:id/deactivate
// ---------------------------------------------------------------------------

/**
 * Idempotent ACTIVE -> DEACTIVATED transition. An already-DEACTIVATED user
 * is a no-op success. A DELETED target is also treated as a no-op success —
 * `deriveAccountState` already reports `DELETED` regardless of
 * `deactivatedAt` (deleted precedence), so deactivating a tombstoned
 * account changes nothing observable and needs no distinct conflict.
 *
 * No notification is emitted for deactivation (only activation is a wired
 * notification event per the notifications spec).
 *
 * Spec: admin-user-management §"Guarded lifecycle actions" — "Repeated
 *   transition is idempotent".
 */
export async function deactivateUser(id: string): Promise<UserDetailView> {
  return prisma.$transaction(async (tx) => {
    await lockUserRows(tx, [id]);

    const user = await findActionableUser(tx, id);
    if (!user) {
      throw new NotFoundError("User not found");
    }

    const state = deriveAccountState(user);

    if (state !== "ACTIVE") {
      // Idempotent no-op — DEACTIVATED stays DEACTIVATED, DELETED stays DELETED.
      return buildDetailView(tx, user);
    }

    // Conditional claim — mirrors activateUser's guard. Whether this call
    // wins the claim or loses to a concurrent transition, re-reading and
    // returning the CURRENT row is correct either way (idempotent by
    // construction — no distinct branch needed for count === 0).
    await tx.user.updateMany({
      where: { id, deletedAt: null, deactivatedAt: null },
      data: { deactivatedAt: new Date() },
    });

    const current = await findActionableUser(tx, id);
    if (!current) {
      throw new NotFoundError("User not found");
    }
    return buildDetailView(tx, current);
  });
}

// ---------------------------------------------------------------------------
// deleteUser — DELETE /admin/users/:id
// ---------------------------------------------------------------------------

/**
 * Irreversible tombstone deletion, guarded by an active-order check and
 * followed by approved redaction of the User + every owned Address +
 * every PendingCheckout row (account-lifecycle §"Approved tombstone
 * redaction").
 *
 * Step order (design "Deletion locks the User, checks active orders, then
 * atomically sets deletedAt..."):
 *   1. Lock the target User row.
 *   2. `AccountDeletedError` (409) if already deleted — never re-redact.
 *   3. Active-order guard — `UserHasActiveOrdersError` (409) if any
 *      non-terminal SubOrder is owned (as consumer or producer); no
 *      profile/lifecycle data changes on this path.
 *   4. Atomically: tombstone the User (deletedAt, tombstone email, null
 *      personal fields/avatar, emailVerified=false), redact every owned
 *      Address (non-default, deleted, REDACTED/00000/XX content), and
 *      redact every PendingCheckout row for this user with the SAME
 *      address tombstones (closes the deletion/intent PII-repopulation
 *      race — see payments.service.ts's locked preflight, which takes the
 *      SAME row lock this function does).
 *
 * Internal/Auth0 ids, Producer commercial profile, and SubOrder shipping
 * snapshots/history are NEVER touched — only User/Address/PendingCheckout
 * columns explicitly listed above.
 *
 * Spec: admin-user-management §"Guarded lifecycle actions" — "Active
 *   orders block deletion".
 * Spec: account-lifecycle §"Approved tombstone redaction".
 * Spec: error-handling §"Active order blocks deletion consistently".
 */
export async function deleteUser(id: string): Promise<UserDetailView> {
  return prisma.$transaction(async (tx) => {
    await lockUserRows(tx, [id]);

    const user = await findActionableUser(tx, id);
    if (!user) {
      throw new NotFoundError("User not found");
    }

    if (deriveAccountState(user) === "DELETED") {
      throw new AccountDeletedError();
    }

    const activeOrderCount = await countActiveOrders(tx, user);
    if (activeOrderCount > 0) {
      throw new UserHasActiveOrdersError();
    }

    const tombstoneEmail = `deleted+${id}@tombstone.invalid`;

    await tx.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        email: tombstoneEmail,
        firstName: null,
        lastName: null,
        name: null,
        avatar: null,
        emailVerified: false,
      },
    });

    await tx.address.updateMany({
      where: { userId: id },
      data: {
        isDefault: false,
        deletedAt: new Date(),
        line1: "REDACTED",
        line2: null,
        city: "REDACTED",
        postalCode: "00000",
        province: "REDACTED",
        country: "XX",
      },
    });

    // Every PendingCheckout for the user is sanitized the SAME way — a
    // preflight already waiting on Stripe is therefore closed off from
    // ever binding a providerRef to the ORIGINAL address content (see
    // payments.service.ts createPaymentIntent Step 6c/7b, which locks this
    // SAME User row before reading or writing PendingCheckout content).
    await tx.pendingCheckout.updateMany({
      where: { userId: id },
      data: {
        addressLine1: "REDACTED",
        addressLine2: null,
        addressCity: "REDACTED",
        addressPostalCode: "00000",
        addressProvince: "REDACTED",
        addressCountry: "XX",
      },
    });

    const deleted = await findActionableUser(tx, id);
    if (!deleted) {
      throw new NotFoundError("User not found");
    }
    return buildDetailView(tx, deleted);
  });
}
