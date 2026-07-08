/**
 * Shared Zod validation helpers.
 *
 * Contains reusable refinements, regexes, and schema fragments used across
 * feature modules. Keeps validation logic DRY and in one auditable location.
 *
 * Exported schemas / helpers:
 *   - spanishNifSchema   — validates Spanish NIF/CIF simplified format ^[A-Z0-9]{9}$
 *   - spanishPostalCodeSchema — validates Spanish 5-digit postal code ^\d{5}$
 *   - nonEmptyString     — string with min(1) after trim
 *   - validateBody       — helper to validate req.body against a Zod schema and
 *                          throw ValidationFailedError on failure
 *
 * Spec references:
 *   producer-bootstrap §"NIF format validated at input"
 *   user-onboarding §"Invalid postal code rejected", §"Invalid NIF format rejected"
 */
import { z } from "zod";

import { ValidationFailedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/** Spanish NIF/CIF simplified format: exactly 9 uppercase alphanumeric chars. */
export const SPANISH_NIF_REGEX = /^[A-Z0-9]{9}$/;

/** Spanish postal code: exactly 5 digits. */
export const SPANISH_POSTAL_CODE_REGEX = /^\d{5}$/;

// ---------------------------------------------------------------------------
// Reusable schema building blocks
// ---------------------------------------------------------------------------

/** Non-empty string (min length 1). Trims whitespace before validating. */
export const nonEmptyString = z.string().trim().min(1, "Must not be empty");

/**
 * Spanish NIF/CIF schema.
 * Input is uppercased before the regex check so lowercase input is normalized.
 * Pattern: ^[A-Z0-9]{9}$
 */
export const spanishNifSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    SPANISH_NIF_REGEX,
    "Must match Spanish NIF/CIF format: 9 uppercase alphanumeric characters",
  );

/**
 * Spanish 5-digit postal code schema.
 * Pattern: ^\d{5}$
 */
export const spanishPostalCodeSchema = z
  .string()
  .trim()
  .regex(SPANISH_POSTAL_CODE_REGEX, "Must be a 5-digit Spanish postal code");

// ---------------------------------------------------------------------------
// Zod → ValidationFailedError bridge
// ---------------------------------------------------------------------------

/**
 * Validates data against a Zod schema.
 * Throws ValidationFailedError (422) with structured field errors on failure.
 * Returns the parsed (typed) data on success.
 *
 * Usage inside a controller or service:
 *   const body = validateBody(ConsumerOnboardingSchema, req.body);
 */
export function validateBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new ValidationFailedError(errors);
  }

  return result.data;
}
