/**
 * Notifications DTOs — response view mapping + neutral-Spanish copy table
 * (Cycle 5 notifications WU3).
 *
 * `NOTIFICATION_COPY` is the sole source of `title`/`body` text for every
 * `NotificationType` — hardcoded neutral Spanish, keyed by type only (design
 * "Recipient emails are resolved inside each tx... Copy is a hardcoded
 * neutral-Spanish table keyed by NotificationType in the dto"). These are
 * the ONLY Spanish string literals in this change (Language Domain
 * Contract exception for user-facing notification copy).
 *
 * `mapNotificationView` is a PURE function — no I/O, no Prisma calls — kept
 * separate from `notifications.service.ts` deliberately so it is testable
 * with ZERO Prisma mocks (strict-tdd "Pure Function Preference"), mirroring
 * `orders.dto.ts`'s `mapOrderSummaryView`.
 *
 * Spec references:
 *   sdd/notifications/spec §"Notification Type Contract"
 *   sdd/notifications/design — "Interfaces / Contracts", File Changes table
 */
import type { Notification, NotificationType, Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// NotificationView — response wire shape
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Prisma.JsonValue | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/**
 * Maps a persisted `Notification` row to the frozen `NotificationView` wire
 * shape. Pure function — given the same row it always returns the same
 * output.
 */
export function mapNotificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data,
    read: row.read,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Neutral-Spanish copy table — keyed by NotificationType, hardcoded
// ---------------------------------------------------------------------------

export interface NotificationCopy {
  title: string;
  body: string;
}

/**
 * Hardcoded neutral-Spanish `title`/`body` per `NotificationType`. No
 * per-recipient variation and no interpolation — one fixed pair per type,
 * used identically for every recipient of that type (design contract:
 * `createNotification` takes no "audience"/role parameter).
 *
 * `INCIDENT_REPORTED`/`INCIDENT_RESOLVED` copy exists for contract
 * completeness only — no code path in this change emits them (spec
 * §"Incident types are contract-only").
 */
export const NOTIFICATION_COPY: Record<NotificationType, NotificationCopy> = {
  PAYMENT_CONFIRMED: {
    title: "Pago confirmado",
    body: "Tu pago se ha confirmado correctamente.",
  },
  ORDER_CREATED: {
    title: "Pedido creado",
    body: "Se ha creado un nuevo pedido.",
  },
  SUBORDER_STATUS_CHANGED: {
    title: "Estado del pedido actualizado",
    body: "El estado de uno de tus pedidos ha cambiado.",
  },
  TRACKING_ASSIGNED: {
    title: "Número de seguimiento asignado",
    body: "Se ha asignado un número de seguimiento a tu envío.",
  },
  INCIDENT_REPORTED: {
    title: "Incidencia reportada",
    body: "Se ha reportado una incidencia en tu pedido.",
  },
  INCIDENT_RESOLVED: {
    title: "Incidencia resuelta",
    body: "La incidencia de tu pedido ha sido resuelta.",
  },
  // admin-user-management WU3 — emitted atomically with a DEACTIVATED ->
  // ACTIVE admin transition (notifications spec "Activation is atomic and
  // unique"); email-provider spec "Activation email follows committed
  // notification".
  ACCOUNT_ACTIVATED: {
    title: "Cuenta reactivada",
    body: "Tu cuenta ha sido reactivada. Ya puedes volver a usar todos los servicios.",
  },
};

// ---------------------------------------------------------------------------
// Audience-aware copy override (Phase 4, maintainer decision
// sdd/notifications/copy-audience-decision) — a SURGICAL override, NOT a
// full audience dimension. ORDER_CREATED fans out to the Consumer owner
// (base copy, unchanged) AND each sub-order Producer (distinct copy — a
// Producer RECEIVES an order, they did not create it). Every other
// NotificationType has exactly one recipient role in this change's scope,
// so it stays on the flat `NOTIFICATION_COPY` table with no override entry.
// ---------------------------------------------------------------------------

/** The only non-default recipient role that ever needs distinct copy. */
export type NotificationAudience = "producer";

/**
 * Sparse override map — ONLY the `(ORDER_CREATED, "producer")` pair exists.
 * Every other `(type, audience)` combination has no entry here and MUST
 * fall back to `NOTIFICATION_COPY` (see `resolveNotificationCopy`).
 */
const AUDIENCE_COPY_OVERRIDES: Partial<
  Record<NotificationType, Partial<Record<NotificationAudience, NotificationCopy>>>
> = {
  ORDER_CREATED: {
    producer: {
      title: "Nuevo pedido recibido",
      body: "Has recibido un nuevo pedido para tus productos.",
    },
  },
};

/**
 * Resolves the `title`/`body` copy for a `(type, audience)` pair. `audience`
 * is OPTIONAL and defaults to the base flat-table copy — only the single
 * `(ORDER_CREATED, "producer")` pair has a distinct override; every other
 * call (including every other type passed with `audience: "producer"`)
 * falls back to `NOTIFICATION_COPY[type]` unchanged.
 *
 * Spec/design: sdd/notifications/copy-audience-decision (maintainer
 * decision #1338) — "Only ORDER_CREATED fans out to two distinct roles...
 * Keep the base table flat and add a surgical override where the domain
 * actually demands it."
 */
export function resolveNotificationCopy(
  type: NotificationType,
  audience?: NotificationAudience,
): NotificationCopy {
  const override = audience ? AUDIENCE_COPY_OVERRIDES[type]?.[audience] : undefined;
  return override ?? NOTIFICATION_COPY[type];
}
