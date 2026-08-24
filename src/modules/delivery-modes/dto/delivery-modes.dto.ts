/**
 * Delivery-modes DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Design note on PICKUP validation:
 *   PICKUP requires either legacy pickupLocation or structured pickupStreet. This is enforced at the SERVICE layer
 *   (not here) so the error code is VALIDATION_FAILED (422) thrown by
 *   ValidationFailedError — consistent with how product-images handles its
 *   business-rule validations.
 *
 *   Type-specific invariants run in the delivery-modes service against effective values.
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD", §"PICKUP without pickupLocation rejected"
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import type { DeliveryMode } from "@prisma/client";
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
 * Wire contract: enum literals MUST remain stable on the wire.
 *
 * Spec: delivery-modes §"Enum literal stability", §"Forward contract for Cycle 3"
 * Design: §"Delivery-modes delete guard" (enum stability context)
 */
export const DeliveryModeTypeSchema = z.enum(["PERSONAL_DELIVERY", "PICKUP", "SHIPPING_FLAT_RATE"]);

const coverageZoneSchema = z.string().min(1).max(255);
const carrierCompanySchema = z.string().min(1).max(120);
const notesSchema = z.string().min(1).max(1000);
const pickupLocationSchema = z.string().min(1).max(500);
const pickupLocationNameSchema = z.string().min(1).max(120);
const pickupStreetSchema = z.string().min(1).max(255);
const pickupMunicipalitySchema = z.string().min(1).max(120);
const pickupPostalCodeSchema = z
  .string()
  .regex(/^\d{5}$/, "pickupPostalCode must contain exactly 5 digits");
const pickupOpeningHoursSchema = z.string().min(1).max(500);
const deliveryModeCostSchema = z
  .number()
  .finite("cost must be finite")
  .min(0, "cost must be >= 0")
  .max(99_999_999.99, "cost exceeds Decimal(10,2)")
  .multipleOf(0.01, "cost must have at most 2 decimal places");

// ---------------------------------------------------------------------------
// Create request body
// ---------------------------------------------------------------------------

/**
 * Body for POST /producers/me/delivery-modes.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — create.
 *   - type: DeliveryModeType
 *   - cost: number (monetary; converted to Decimal in service)
 *   - coverageZone: optional string
 *   - pickupLocation: optional string (required when type=PICKUP — enforced in service)
 *
 * Forbidden fields (server-generated): id, producerId, isActive, createdAt, updatedAt
 */
export const CreateDeliveryModeBodySchema = strictObject({
  type: DeliveryModeTypeSchema,
  cost: deliveryModeCostSchema,
  coverageZone: coverageZoneSchema.optional(),
  carrierCompany: carrierCompanySchema.optional(),
  notes: notesSchema.optional(),
  pickupLocation: pickupLocationSchema.optional(),
  pickupLocationName: pickupLocationNameSchema.optional(),
  pickupStreet: pickupStreetSchema.optional(),
  pickupMunicipality: pickupMunicipalitySchema.optional(),
  pickupPostalCode: pickupPostalCodeSchema.optional(),
  pickupOpeningHours: pickupOpeningHoursSchema.optional(),
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
  cost: deliveryModeCostSchema.optional(),
  coverageZone: coverageZoneSchema.nullable().optional(),
  carrierCompany: carrierCompanySchema.nullable().optional(),
  notes: notesSchema.nullable().optional(),
  pickupLocation: pickupLocationSchema.nullable().optional(),
  pickupLocationName: pickupLocationNameSchema.nullable().optional(),
  pickupStreet: pickupStreetSchema.nullable().optional(),
  pickupMunicipality: pickupMunicipalitySchema.nullable().optional(),
  pickupPostalCode: pickupPostalCodeSchema.nullable().optional(),
  pickupOpeningHours: pickupOpeningHoursSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateDeliveryModeBody = z.infer<typeof UpdateDeliveryModeBodySchema>;

// ---------------------------------------------------------------------------
// Consumer checkout read model
// ---------------------------------------------------------------------------

export interface DeliveryModeConsumerView {
  id: string;
  name: string;
  type: "shipping" | "pickup";
  price: string;
}

/** Maps the persisted delivery configuration to the minimal checkout DTO. */
export function mapDeliveryModeConsumerView(
  mode: Pick<DeliveryMode, "id" | "type" | "cost" | "pickupLocationName">,
): DeliveryModeConsumerView {
  const isPickup = mode.type === "PICKUP";
  const name =
    mode.type === "PERSONAL_DELIVERY"
      ? "Personal delivery"
      : mode.type === "SHIPPING_FLAT_RATE"
        ? "Shipping"
        : (mode.pickupLocationName ?? "Pickup");

  return {
    id: mode.id,
    name,
    type: isPickup ? "pickup" : "shipping",
    price: mode.cost.toFixed(2),
  };
}
