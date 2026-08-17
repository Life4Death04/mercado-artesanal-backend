/**
 * Sub-orders DTOs — Zod schemas for request body and query validation.
 *
 * All DTOs use `strictObject()` to enforce the strict DTO policy (rejects
 * unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Key design decisions:
 *   - PatchSubOrderBodySchema accepts `status` and an optional `trackingNumber`.
 *     `trackingNumber` is SHAPE-ONLY here (`z.string().min(1).optional()`, no
 *     trim/normalization, persisted verbatim). The business rules — mandatory
 *     for shipping on `→sent`, rejected for PICKUP, immutable once set, only
 *     accepted on the PATCH that transitions into `sent` — are enforced in
 *     `sub-orders.service.ts` `transition()`, NOT here, because they depend on
 *     `deliveryMode.type` (a DB row) and the currently persisted `trackingNumber`,
 *     neither of which is available at the schema boundary (design Decision #1).
 *
 * Spec references:
 *   order-fulfillment §"State machine"
 *   order-fulfillment §"Tracking number on shipment" (MODIFIED)
 *   order-fulfillment scenario "Shipping sub-order transitions to sent with a valid trackingNumber"
 *   order-fulfillment scenario "PICKUP sub-order rejects trackingNumber"
 *   error-handling §"Zod .strict() policy for unknown keys"
 *   design — Architecture Decision #1 (strictObject project-wide) and #5 (no trim/normalization)
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// SubOrderStatus enum — exact values from Prisma schema (lowercase)
// Spec: order-fulfillment §"SubOrder entity + related tables"
// ---------------------------------------------------------------------------

/**
 * SubOrderStatus enum — matches Prisma's `SubOrderStatus` enum values exactly.
 * Values are lowercase: pending | preparing | sent | delivered | cancelled.
 *
 * Do NOT uppercase — the wire format must match the DB enum literals.
 */
export const SubOrderStatusSchema = z.enum([
  "pending",
  "preparing",
  "sent",
  "delivered",
  "cancelled",
]);

export type SubOrderStatusValue = z.infer<typeof SubOrderStatusSchema>;

// ---------------------------------------------------------------------------
// List query parameters
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /producers/me/sub-orders.
 *
 * Spec: order-fulfillment §"Producer read of own SubOrders"
 *   - status: optional filter by SubOrderStatus
 *   - page: optional pagination (default 1)
 *   - limit: optional page size (default 20, cap 100)
 *
 * Forbidden unknown keys are rejected by strictObject() globally.
 */
export const ListSubOrdersQuerySchema = strictObject({
  status: SubOrderStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListSubOrdersQuery = z.infer<typeof ListSubOrdersQuerySchema>;

// ---------------------------------------------------------------------------
// PATCH request body — state transition only
// ---------------------------------------------------------------------------

/**
 * Body for PATCH /producers/me/sub-orders/:id.
 *
 * Accepts `status` and an optional `trackingNumber`. `trackingNumber` is
 * shape-only here — `.min(1)` blocks an empty string; no trim/normalization
 * (persisted verbatim per design Decision #5). The business rules (mandatory
 * for shipping on `→sent`, rejected for PICKUP, immutable once set, only
 * accepted on the PATCH transitioning into `sent`) are enforced in
 * `sub-orders.service.ts` `transition()` — see design Decision #1.
 *
 * Any other unknown key is still rejected by the .strict() guard with
 * VALIDATION_FAILED (422).
 *
 * Spec: order-fulfillment §"State machine", §"Tracking number on shipment" (MODIFIED)
 */
export const PatchSubOrderBodySchema = strictObject({
  status: SubOrderStatusSchema,
  trackingNumber: z.string().min(1).optional(),
});

export type PatchSubOrderBody = z.infer<typeof PatchSubOrderBodySchema>;

// ---------------------------------------------------------------------------
// Response views — explicit producer-facing SubOrder shape
// ---------------------------------------------------------------------------

/**
 * order-public-numbers Phase 4 (PR 3): producer list/detail/transition
 * responses expose `subOrderNumber` (a raw `SubOrder` column, already wire-
 * visible) and add `order: { orderNumber }` — EXACTLY `orderNumber`, never
 * `order.userId` (design "Interfaces / Contracts": "Producer views add
 * subOrderNumber: number and exactly order: { orderNumber: number };
 * internal order.userId used for notifications is mapped out.").
 *
 * These view interfaces replace the previous raw-Prisma-row passthrough in
 * `sub-orders.service.ts` with an explicit mapped response, matching the
 * `orders.dto.ts` / `orders.service.ts` convention (`OrderSummaryView` +
 * `mapOrderSummaryView`, `SubOrderView` + `mapSubOrderView`).
 *
 * Spec: order-fulfillment §"Producer public reference responses" (ADDED)
 *   scenario "Producer reads public references"
 *   scenario "Transition returns the same contract"
 *   scenario "Cross-producer access leaks nothing"
 */
export interface SubOrderOrderRefView {
  orderNumber: number;
}

export interface SubOrderLineView {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: string;
}

/**
 * Scalar producer SubOrder view, shared by all three producer surfaces.
 * `transition()` returns exactly this shape (it never exposed
 * `orderLines`/`deliveryMode` before this change either); `findAll`/
 * `findById` extend it with `deliveryMode`/`orderLines` via
 * `SubOrderListItemView` below.
 */
export interface SubOrderView {
  id: string;
  orderId: string;
  producerId: string;
  deliveryModeId: string;
  status: SubOrderStatusValue;
  shippingCostSnapshot: string;
  trackingNumber: string | null;
  shipToLine1: string | null;
  shipToLine2: string | null;
  shipToCity: string | null;
  shipToPostalCode: string | null;
  shipToProvince: string | null;
  shipToCountry: string | null;
  subOrderNumber: number;
  createdAt: string;
  updatedAt: string;
  order: SubOrderOrderRefView;
}

/**
 * `findAll`/`findById` list/detail view — adds `deliveryMode.type` (order-
 * fulfillment "Consumer sub-order read exposes tracking and delivery mode",
 * ADDED — "Producer sub-order reads MUST also expose deliveryMode.type") and
 * `orderLines` (unchanged wire fields from before this change).
 */
export interface SubOrderListItemView extends SubOrderView {
  deliveryMode: { type: string };
  orderLines: SubOrderLineView[];
}
