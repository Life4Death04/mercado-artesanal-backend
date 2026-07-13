/**
 * Delivery-modes DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Design note on PICKUP validation:
 *   PICKUP type requires pickupLocation. This is enforced at the SERVICE layer
 *   (not here) so the error code is VALIDATION_FAILED (422) thrown by
 *   ValidationFailedError — consistent with how product-images handles its
 *   business-rule validations.
 *
 *   The DTO accepts both PICKUP and SHIPPING_FLAT_RATE types at the schema level;
 *   the PICKUP+no-pickupLocation guard runs in delivery-modes.service.create().
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD", §"PICKUP without pickupLocation rejected"
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * DeliveryModeType enum — exact wire strings from Prisma schema.
 *
 * Uses `z.enum([...])` with the literal values from the Prisma `DeliveryModeType` enum
 * (`prisma/schema.prisma`). No re-encoding, no lowercase transforms, no aliasing.
 *
 * Wire contract (Cycle 3 forward): `PICKUP` and `SHIPPING_FLAT_RATE` MUST remain
 * stable on the wire — Cycle 3 checkout snapshots `DeliveryMode.type` into SubOrder.
 * Any new variant (e.g. `COURIER`) MUST go through a new SDD cycle and amend this schema.
 *
 * Spec: delivery-modes §"Enum literal stability", §"Forward contract for Cycle 3"
 * Design: §"Delivery-modes delete guard" (enum stability context)
 */
export const DeliveryModeTypeSchema = z.enum(["PICKUP", "SHIPPING_FLAT_RATE"]);

// ---------------------------------------------------------------------------
// Create request body
// ---------------------------------------------------------------------------

/**
 * Body for POST /producers/me/delivery-modes.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — create.
 *   - type: DeliveryModeType (PICKUP | SHIPPING_FLAT_RATE)
 *   - cost: number (monetary; converted to Decimal in service)
 *   - coverageZone: optional string
 *   - pickupLocation: optional string (required when type=PICKUP — enforced in service)
 *
 * Forbidden fields (server-generated): id, producerId, isActive, createdAt, updatedAt
 */
export const CreateDeliveryModeBodySchema = strictObject({
  type: DeliveryModeTypeSchema,
  cost: z.number().min(0, "cost must be >= 0"),
  coverageZone: z.string().optional(),
  pickupLocation: z.string().optional(),
});

export type CreateDeliveryModeBody = z.infer<typeof CreateDeliveryModeBodySchema>;

// ---------------------------------------------------------------------------
// Update request body
// ---------------------------------------------------------------------------

/**
 * Body for PATCH /producers/me/delivery-modes/:id.
 *
 * All fields are optional for partial updates.
 * type and cost may be patched; producerId and id are immutable.
 *
 * Forbidden fields: id, producerId, createdAt, updatedAt
 */
export const UpdateDeliveryModeBodySchema = strictObject({
  type: DeliveryModeTypeSchema.optional(),
  cost: z.number().min(0, "cost must be >= 0").optional(),
  coverageZone: z.string().optional(),
  pickupLocation: z.string().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateDeliveryModeBody = z.infer<typeof UpdateDeliveryModeBodySchema>;
