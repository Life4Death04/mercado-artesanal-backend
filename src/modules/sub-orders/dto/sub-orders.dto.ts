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
