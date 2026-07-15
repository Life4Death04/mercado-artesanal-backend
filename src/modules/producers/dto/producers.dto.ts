/**
 * Producers DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Non-editable fields are excluded from the schema entirely — strictObject()
 * ensures their presence causes a 422 VALIDATION_FAILED rather than silent
 * ignore (spec: producer-bootstrap §"NIF edit rejected").
 *
 * Non-editable fields (MUST reject): nif, userId, id, deletedAt, createdAt, updatedAt.
 *
 * Spec references:
 *   producer-bootstrap §"Private profile edit endpoint"
 *   producer-bootstrap scenario "NIF edit rejected"
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Nested address shape for PATCH body
// ---------------------------------------------------------------------------

/**
 * Partial address fields for PATCH /producers/me.
 * All fields optional — omitted fields are not updated.
 * postalCode must match Spanish postal code format when present.
 *
 * Spec: producer-bootstrap §"Private profile edit endpoint" — editable address fields
 */
export const PatchProducerAddressSchema = strictObject({
  line1: z.string().min(1, "line1 must not be empty").optional(),
  line2: z.string().optional(),
  city: z.string().min(1, "city must not be empty").optional(),
  postalCode: z
    .string()
    .regex(/^\d{5}$/, "postalCode must be 5 digits")
    .optional(),
  province: z.string().min(1, "province must not be empty").optional(),
  country: z.string().min(1, "country must not be empty").optional(),
});

// ---------------------------------------------------------------------------
// PATCH /producers/me — request body
// ---------------------------------------------------------------------------

/**
 * Body for PATCH /producers/me.
 *
 * All fields are optional — any combination is valid for partial update.
 * Fields NOT listed here are rejected by strictObject() with VALIDATION_FAILED (422).
 *
 * Forbidden fields (server-generated or immutable): nif, userId, id, deletedAt, createdAt, updatedAt.
 * These MUST NOT appear in the request body — strictObject() ensures rejection.
 *
 * categorySlugs: when present, REPLACES the current M-N set inside a $transaction.
 *
 * Spec: producer-bootstrap §"Private profile edit endpoint"
 */
export const PatchProducerBodySchema = strictObject({
  businessName: z.string().min(1, "businessName must not be empty").optional(),
  description: z.string().min(1, "description must not be empty").optional(),
  address: PatchProducerAddressSchema.optional(),
  categorySlugs: z.array(z.string()).optional(),
});

export type PatchProducerBody = z.infer<typeof PatchProducerBodySchema>;
