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
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 *   account-lifecycle §"Derived lifecycle state"
 *   design — Architecture Decisions, Data Flow, Interfaces / Contracts
 */
import type { Prisma, Role, SubOrderStatus } from "@prisma/client";

import { deriveAccountState } from "@/shared/account-lifecycle";
import {
  NotFoundError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

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
