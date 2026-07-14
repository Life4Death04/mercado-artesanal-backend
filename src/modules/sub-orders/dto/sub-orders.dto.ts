/**
 * Sub-orders DTOs — Zod schemas for request body and query validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Key design decisions:
 *   - PatchSubOrderBodySchema accepts only `status`. `trackingNumber` is
 *     intentionally ABSENT — it is deferred to Cycle 3 (COURIER mode / RF-21).
 *     Any payload containing `trackingNumber` hits the `.strict()` guard and
 *     is rejected with VALIDATION_FAILED (422).
 *
 * Spec references:
 *   order-fulfillment §"State machine"
 *   order-fulfillment §"Tracking number deferred" — trackingNumber MUST NOT be settable in Cycle 2.
 *   order-fulfillment scenario "Attempt to set trackingNumber rejected"
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
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
 * Accepts ONLY `status`. The absence of `trackingNumber` here is deliberate —
 * it is a DEFERRED field per spec order-fulfillment §"Tracking number deferred".
 *
 * Any body containing `trackingNumber` or any other unknown key WILL be
 * rejected by the .strict() guard with VALIDATION_FAILED (422). This is
 * enforced at the DTO level (schema boundary), not the service level.
 *
 * Spec: order-fulfillment §"State machine", §"Tracking number deferred"
 * Spec scenario: "Attempt to set trackingNumber rejected"
 */
export const PatchSubOrderBodySchema = strictObject({
  status: SubOrderStatusSchema,
});

export type PatchSubOrderBody = z.infer<typeof PatchSubOrderBodySchema>;
