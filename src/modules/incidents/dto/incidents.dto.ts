/**
 * Incidents DTOs — consumer request validation + response view mapping
 * (admin-incidents WU1: Schema and Core Contract).
 *
 * `CreateIncidentSchema` is the strict body for `POST /api/v1/incidencias`:
 * exactly one target sub-order and a non-empty reason. `strictObject()`
 * rejects unknown keys with `VALIDATION_FAILED` (422) — reporter, producer,
 * status, and audit data are never client-settable (spec §"Eligible
 * single-target creation").
 *
 * `mapIncidentSummaryView`/`mapIncidentDetailView` are PURE functions — no
 * I/O, no Prisma calls — kept separate from `incidents.service.ts`
 * deliberately so they are testable with ZERO Prisma mocks (mirrors
 * `orders.dto.ts`'s `mapOrderSummaryView` and `notifications.dto.ts`'s
 * `mapNotificationView`). Callers (WU2 `incidents.service.ts`) pre-compute
 * every field the mapper cannot derive purely — e.g. `subtotal` and
 * `shippingCost`/`lines` come from the SubOrder's OWN historical snapshot
 * columns (`OrderLine.unitPriceSnapshot`, `SubOrder.shippingCostSnapshot`),
 * never a live re-price — the mapper only formats.
 *
 * Snapshot vs. live (design §"Snapshot vs broad joins" + §"Data Flow"):
 *   SNAPSHOT (frozen at purchase time): subtotal, shippingCost, lines.
 *   LIVE (current DB state): fulfillmentStatus, trackingNumber, deliveryModeType.
 * Both views deliberately keep these fields separate to prevent the two
 * classes of data from being confused (RNF-05 audit integrity).
 *
 * PII exclusion (design §"API Contracts", RNF-05): the consumer view never
 * includes reporter identity (it is the requester's own incident), Auth0
 * subjects, provider references, shipping addresses, or S3 keys — only
 * `producerBusinessName` (public business data) is allowlisted from the
 * target side.
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 *   error-handling §"Incident validation errors"
 *   design §"API Contracts" — IncidentSummary / IncidentDetail wire shapes
 *   design §"Architecture Decisions" — Snapshot vs broad joins
 */
import type { DeliveryModeType, IncidentStatus, Prisma } from "@prisma/client";
import { z } from "zod";

import type { SubOrderStatusValue } from "@/modules/sub-orders/dto/sub-orders.dto";
import { nonEmptyString, strictObject } from "@/shared/validation/zod";

type DecimalValue = InstanceType<typeof Prisma.Decimal>;

// ---------------------------------------------------------------------------
// POST /api/v1/incidencias — strict create body
// ---------------------------------------------------------------------------

/**
 * Body schema for reporting an incident.
 *   subOrderId — non-empty string identifying the exactly-one target (required)
 *   reason     — trimmed, 1..2000 chars (required)
 *
 * An unknown field, an empty reason, or a missing subOrderId all fail with
 * `VALIDATION_FAILED` (422) via `strictObject()` / Zod `.min()`/`.max()` —
 * never echoing the rejected value (spec scenario "Create body rejects
 * extra targets or fields"; error-handling scenario "Invalid incident input
 * is value-safe").
 */
export const CreateIncidentSchema = strictObject({
  subOrderId: nonEmptyString,
  reason: z
    .string()
    .trim()
    .min(1, "reason is required")
    .max(2000, "reason must be at most 2000 characters"),
});

export type CreateIncidentBody = z.infer<typeof CreateIncidentSchema>;

// ---------------------------------------------------------------------------
// IncidentSummaryView — frozen by design §"API Contracts"
// ---------------------------------------------------------------------------

/** Target context shared by both the summary and (as a subset) detail view. */
export interface IncidentTargetSummaryView {
  subOrderId: string;
  producerBusinessName: string;
  /** Fixed-decimal string, e.g. "24.00" — frozen order-line snapshot sum. */
  subtotal: string;
  /** LIVE `SubOrder.status` — current fulfillment state, not a snapshot. */
  fulfillmentStatus: SubOrderStatusValue;
}

export interface IncidentSummaryView {
  id: string;
  status: IncidentStatus;
  reportReason: string;
  createdAt: string;
  resolvedAt: string | null;
  target: IncidentTargetSummaryView;
}

/**
 * Internal row shape consumed by `mapIncidentSummaryView`. Every field the
 * mapper cannot derive purely (the target snapshot/live split) is
 * pre-assembled by the caller — mirrors `OrderSummaryRow` in
 * `orders.dto.ts` (status/producerCount pre-computed by `orders.service.ts`).
 */
export interface IncidentTargetSummaryRow {
  subOrderId: string;
  producerBusinessName: string;
  subtotal: DecimalValue;
  fulfillmentStatus: SubOrderStatusValue;
}

export interface IncidentSummaryRow {
  id: string;
  status: IncidentStatus;
  reportReason: string;
  createdAt: Date;
  resolvedAt: Date | null;
  target: IncidentTargetSummaryRow;
}

/**
 * Maps an `IncidentSummaryRow` to the frozen `IncidentSummaryView` wire
 * shape. Pure function — given the same row it always returns the same
 * output.
 *
 * Spec: incident-management §"Owner-scoped consumer views"
 * Design: §"API Contracts" — IncidentSummary
 */
export function mapIncidentSummaryView(row: IncidentSummaryRow): IncidentSummaryView {
  return {
    id: row.id,
    status: row.status,
    reportReason: row.reportReason,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    target: {
      subOrderId: row.target.subOrderId,
      producerBusinessName: row.target.producerBusinessName,
      subtotal: row.target.subtotal.toFixed(2),
      fulfillmentStatus: row.target.fulfillmentStatus,
    },
  };
}

// ---------------------------------------------------------------------------
// IncidentDetailView — extends IncidentSummaryView (design §"API Contracts")
// ---------------------------------------------------------------------------

export interface IncidentResolutionView {
  reason: string;
  resolvedAt: string;
  resolvedById: string;
}

/** One immutable order-line price snapshot, allowlisted for incident detail. */
export interface IncidentLineView {
  productId: string;
  quantity: number;
  /** Fixed-decimal string, e.g. "9.50" — `OrderLine.unitPriceSnapshot`. */
  unitPrice: string;
}

export interface IncidentDetailTargetView extends IncidentTargetSummaryView {
  /** Fixed-decimal string — `SubOrder.shippingCostSnapshot` (frozen). */
  shippingCost: string;
  lines: IncidentLineView[];
  /** LIVE — null until the shipping PATCH sets it (see sub-orders design). */
  trackingNumber: string | null;
  /** LIVE — `DeliveryMode.type` for the sub-order's configured mode. */
  deliveryModeType: DeliveryModeType;
}

export interface IncidentDetailView extends Omit<IncidentSummaryView, "target"> {
  updatedAt: string;
  resolution: IncidentResolutionView | null;
  target: IncidentDetailTargetView;
}

export interface IncidentResolutionRow {
  reason: string;
  resolvedAt: Date;
  resolvedById: string;
}

export interface IncidentLineRow {
  productId: string;
  quantity: number;
  unitPriceSnapshot: DecimalValue;
}

export interface IncidentDetailTargetRow extends IncidentTargetSummaryRow {
  shippingCost: DecimalValue;
  lines: IncidentLineRow[];
  trackingNumber: string | null;
  deliveryModeType: DeliveryModeType;
}

export interface IncidentDetailRow extends Omit<IncidentSummaryRow, "target"> {
  updatedAt: Date;
  resolution: IncidentResolutionRow | null;
  target: IncidentDetailTargetRow;
}

/**
 * Maps an `IncidentDetailRow` to the frozen `IncidentDetailView` wire shape.
 * Pure function — composes `mapIncidentSummaryView` (explicit field reuse,
 * per design "explicit mapping; prevents drift/leaks") and adds the
 * detail-only snapshot (`shippingCost`, `lines`) and live
 * (`trackingNumber`, `deliveryModeType`) fields plus the nullable
 * resolution audit.
 *
 * Spec: incident-management §"Owner-scoped consumer views" (resolved detail
 *   MUST include resolution information)
 * Design: §"API Contracts" — IncidentDetail
 */
export function mapIncidentDetailView(row: IncidentDetailRow): IncidentDetailView {
  const summary = mapIncidentSummaryView(row);

  return {
    ...summary,
    updatedAt: row.updatedAt.toISOString(),
    resolution: row.resolution
      ? {
          reason: row.resolution.reason,
          resolvedAt: row.resolution.resolvedAt.toISOString(),
          resolvedById: row.resolution.resolvedById,
        }
      : null,
    target: {
      ...summary.target,
      shippingCost: row.target.shippingCost.toFixed(2),
      lines: row.target.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPriceSnapshot.toFixed(2),
      })),
      trackingNumber: row.target.trackingNumber,
      deliveryModeType: row.target.deliveryModeType,
    },
  };
}
