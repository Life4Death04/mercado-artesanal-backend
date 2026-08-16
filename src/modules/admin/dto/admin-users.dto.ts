/**
 * Admin Users DTOs — Zod request validation + response view mapping for
 * ADMIN-only consumer/producer account discovery and lifecycle
 * administration (admin-user-management WU2-WU4).
 *
 * All DTOs use `strictObject()` per the project-wide strict DTO policy.
 *
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 *   design — Interfaces / Contracts
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// GET /admin/users — strict list query
// ---------------------------------------------------------------------------

/** Actionable roles — the ONLY roles ADMIN discovery ever exposes. */
export const ActionableRoleSchema = z.enum(["CONSUMER", "PRODUCER"]);

/** Derived lifecycle status filter — mirrors `AccountState` (account-lifecycle.ts). */
export const AccountStatusSchema = z.enum(["ACTIVE", "DEACTIVATED", "DELETED"]);

/**
 * Query parameters for GET /admin/users.
 *   page   — integer >= 1, default 1 (fixed page size 8 — not client-settable)
 *   search — optional, case-insensitive substring across email/names/business name
 *   role   — optional CONSUMER|PRODUCER filter
 *   status — optional ACTIVE|DEACTIVATED|DELETED filter
 *
 * Spec: admin-user-management §"Deterministic user discovery".
 */
export const ListUsersQuerySchema = strictObject({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().min(1).optional(),
  role: ActionableRoleSchema.optional(),
  status: AccountStatusSchema.optional(),
});

export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

/** Fixed page size — design "deterministic createdAt DESC, id DESC pagination (limit 8)". */
export const ADMIN_USERS_PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Pagination envelope
// ---------------------------------------------------------------------------

export interface PaginatedUsers<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// UserSummaryView — GET /admin/users list item
// ---------------------------------------------------------------------------

export type AccountStatusValue = "ACTIVE" | "DEACTIVATED" | "DELETED";

export interface UserSummaryView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  role: "CONSUMER" | "PRODUCER";
  status: AccountStatusValue;
  createdAt: string;
  producerId: string | null;
  businessName: string | null;
}

export interface UserSummaryRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  role: "CONSUMER" | "PRODUCER";
  status: AccountStatusValue;
  createdAt: Date;
  producer: { id: string; businessName: string } | null;
}

/** Pure mapper — no I/O. */
export function mapUserSummaryView(row: UserSummaryRow): UserSummaryView {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    producerId: row.producer?.id ?? null,
    businessName: row.producer?.businessName ?? null,
  };
}

// ---------------------------------------------------------------------------
// UserDetailView — GET /admin/users/:id
// ---------------------------------------------------------------------------

export interface UserActivityView {
  /** Consumer: distinct aggregate Order count. Producer: producer-scoped SubOrder count. */
  orderCount: number;
  /** Producer only — non-deleted, active, non-REMOVED products. 0 for CONSUMER. */
  publishedProductCount: number;
  /** Non-terminal (pending|preparing|sent) SubOrder count owned by this account. */
  activeOrderCount: number;
}

export interface UserDetailView extends UserSummaryView {
  emailVerified: boolean;
  avatar: string | null;
  updatedAt: string;
  activity: UserActivityView;
}

export interface UserDetailRow extends UserSummaryRow {
  emailVerified: boolean;
  avatar: string | null;
  updatedAt: Date;
  activity: UserActivityView;
}

/** Pure mapper — no I/O. */
export function mapUserDetailView(row: UserDetailRow): UserDetailView {
  return {
    ...mapUserSummaryView(row),
    emailVerified: row.emailVerified,
    avatar: row.avatar,
    updatedAt: row.updatedAt.toISOString(),
    activity: row.activity,
  };
}
