/**
 * Notifications service — generic in-app notification write + owner-scoped
 * read/list/unread-count/mark-read (Cycle 5 notifications WU3).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as notificationsService from "@/modules/notifications/services/notifications.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma delegates
 * directly per ADR-003, mirroring orders.service.ts / sub-orders.service.ts.
 *
 * `createNotification` is the ONLY write path (design "Notification write
 * timing: In-transaction (`tx.notification.create`)") — it takes the
 * CALLER's `tx` (never opens its own `$transaction`) so it free-rides the
 * existing early-return/no-op guards at the payments/orders and sub-orders
 * tx seams (Phases 4-5), giving zero new idempotency logic. It returns a
 * `PendingEmail` describing the fire-after-commit dispatch intent; the
 * CALLER is responsible for invoking `dispatchEmails` from
 * `@/shared/email/email-provider` AFTER its transaction commits (design
 * "Email dispatch timing: Fire-after-commit, best-effort").
 *
 * NOTE on `dispatchEmails`: the generic best-effort dispatcher already
 * exists in `@/shared/email/email-provider.ts` (Phase 2) — this module
 * intentionally does NOT duplicate it. Call sites map `PendingEmail[]` to
 * `EmailMessage[]` (identical shape: `to`/`subject`→n/a/`body` — see
 * `PendingEmail` below, which mirrors `EmailMessage` plus a `subject`
 * field) and call the shared `dispatchEmails` directly.
 *
 * `listMine`/`unreadCount`/`markAsRead` are all read paths scoped to
 * `userId` via the shared `scopeToOwner` predicate (task 3.14 REFACTOR —
 * dedupes the ownership-query construction across all three).
 *
 * Spec references:
 *   sdd/notifications/spec §"Notification Type Contract"
 *   sdd/notifications/spec §"List Own Notifications"
 *   sdd/notifications/spec §"Unread Count"
 *   sdd/notifications/spec §"Mark Notification As Read"
 * Design reference: sdd/notifications/design — "Interfaces / Contracts",
 *   "Architecture Decisions" (notification write timing, dispatch data flow)
 */
import type { Notification, NotificationType, Prisma } from "@prisma/client";

import { NotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type { NotificationAudience, NotificationView } from "../dto/notifications.dto";
import { mapNotificationView, resolveNotificationCopy } from "../dto/notifications.dto";

type PrismaTx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// PendingEmail — fire-after-commit dispatch intent (design contract)
// ---------------------------------------------------------------------------

export interface PendingEmail {
  to: string;
  subject: string;
  body: string;
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  /** Read-only informational payload — never joined, never validated per-type (design). */
  data?: Prisma.InputJsonValue;
  /** Recipient email — resolved by the caller from data already loaded in-tx (design). */
  toEmail: string;
  /**
   * OPTIONAL recipient-role override (Phase 4, maintainer decision
   * sdd/notifications/copy-audience-decision). Defaults to the base
   * `NOTIFICATION_COPY[type]` copy — ONLY `(ORDER_CREATED, "producer")` has
   * a distinct override; every other `(type, audience)` combination falls
   * back to the flat table unchanged. See `resolveNotificationCopy`.
   */
  audience?: NotificationAudience;
}

/** Fixed internal cap for `listMine` — no real pagination (spec "List Own Notifications"). */
const LIST_CAP = 50;

// ---------------------------------------------------------------------------
// Shared ownership predicate — task 3.14 REFACTOR dedup target
// ---------------------------------------------------------------------------

/** Builds the `userId`-scoped `where` predicate shared by every owner-scoped query below. */
function scopeToOwner(userId: string): Prisma.NotificationWhereInput {
  return { userId };
}

// ---------------------------------------------------------------------------
// createNotification — the SOLE write path (in-tx)
// ---------------------------------------------------------------------------

/**
 * Persists a Notification row on the CALLER's `tx` and returns the
 * fire-after-commit `PendingEmail` intent. Copy (`title`/`body`) is
 * resolved via `resolveNotificationCopy(type, audience)` — the hardcoded
 * neutral-Spanish `NOTIFICATION_COPY` table for every `(type, audience)`
 * pair EXCEPT `(ORDER_CREATED, "producer")`, which resolves to the Phase 4
 * producer-audience override (maintainer decision
 * sdd/notifications/copy-audience-decision). `audience` is optional and
 * absent for every other call site.
 *
 * Spec: notifications §"Generic creator persists a notification"
 * Spec: notifications §"Incident types are contract-only" — accepts
 *   INCIDENT_REPORTED/INCIDENT_RESOLVED as valid enum values; no caller in
 *   this change's scope invokes this function with those types.
 */
export async function createNotification(
  tx: PrismaTx,
  input: CreateNotificationInput,
): Promise<PendingEmail> {
  const copy = resolveNotificationCopy(input.type, input.audience);

  await tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: copy.title,
      body: copy.body,
      ...(input.data !== undefined && { data: input.data }),
    },
  });

  return { to: input.toEmail, subject: copy.title, body: copy.body };
}

// ---------------------------------------------------------------------------
// listMine — GET /api/v1/notifications
// ---------------------------------------------------------------------------

/**
 * Owner-scoped list, newest first, capped at `LIST_CAP` (no real pagination).
 *
 * Spec: notifications §"User lists only their own notifications"
 */
export async function listMine(userId: string): Promise<NotificationView[]> {
  const rows = await prisma.notification.findMany({
    where: scopeToOwner(userId),
    orderBy: { createdAt: "desc" },
    take: LIST_CAP,
  });

  return rows.map(mapNotificationView);
}

// ---------------------------------------------------------------------------
// unreadCount — GET /api/v1/notifications/unread-count
// ---------------------------------------------------------------------------

/**
 * Owner-scoped unread count.
 *
 * Spec: notifications §"Count reflects only own unread notifications"
 */
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { ...scopeToOwner(userId), read: false },
  });
}

// ---------------------------------------------------------------------------
// markAsRead — PATCH /api/v1/notifications/:id/read
// ---------------------------------------------------------------------------

/**
 * Marks the caller's own notification as read. Idempotent: an already-read
 * row is returned unchanged WITHOUT issuing an UPDATE (mirrors
 * sub-orders.service.ts `transition()`'s idempotent no-op pattern —
 * `updatedAt`/`readAt` must not change on retries).
 *
 * Ownership is enforced at the QUERY level (`where: { id, userId }`), so an
 * unknown OR non-owned id resolves to the SAME `NotFoundError` (404,
 * no-leak) — mirrors `orders.service.ts` `getOrderDetail`/`cancelOrder`.
 *
 * Spec: notifications §"Owner marks their notification as read"
 * Spec: notifications §"Marking again is idempotent"
 * Spec: notifications §"Cross-user access returns 404"
 */
export async function markAsRead(userId: string, id: string): Promise<NotificationView> {
  const current = await findOwnedOrThrow(userId, id);

  if (current.read) {
    return mapNotificationView(current);
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { read: true, readAt: new Date() },
  });

  return mapNotificationView(updated);
}

/** Ownership guard shared by `markAsRead` — no-leak 404 on unknown/non-owned id. */
async function findOwnedOrThrow(userId: string, id: string): Promise<Notification> {
  const row = await prisma.notification.findFirst({
    where: { ...scopeToOwner(userId), id },
  });

  if (!row) {
    throw new NotFoundError("Notification not found");
  }

  return row;
}
