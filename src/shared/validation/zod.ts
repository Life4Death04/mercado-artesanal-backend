/**
 * Shared Zod validation helpers.
 *
 * Contains reusable refinements, regexes, and schema fragments used across
 * feature modules. Keeps validation logic DRY and in one auditable location.
 *
 * Exported schemas / helpers:
 *   - spanishNifSchema        — validates Spanish NIF/CIF simplified format ^[A-Z0-9]{9}$
 *   - spanishPostalCodeSchema — validates Spanish 5-digit postal code ^\d{5}$
 *   - nonEmptyString          — string with min(1) after trim
 *   - validateBody            — validate req.body, throw ValidationFailedError on failure
 *   - strictObject()          — Cycle 2: z.object(shape).strict() — rejects unknown keys
 *   - installGlobalErrorMap() — Cycle 2: install Zod global errorMap for unrecognized_keys
 *
 * Spec references:
 *   producer-bootstrap §"NIF format validated at input"
 *   user-onboarding §"Invalid postal code rejected", §"Invalid NIF format rejected"
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
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

// ---------------------------------------------------------------------------
// Cycle 2 — Strict DTO policy
// ---------------------------------------------------------------------------

/**
 * Creates a Zod object schema with `.strict()` enforced.
 *
 * All Cycle 2 request DTOs (body, query, params) MUST use this helper
 * instead of bare `z.object()` to reject unknown keys with VALIDATION_FAILED (422).
 *
 * Policy: security-by-default against mass-assignment (e.g., forbidden fields
 * like `trackingNumber`, `nif`, `isAdmin`). Auditable and uniform.
 *
 * Usage:
 *   const PatchSubOrderBody = strictObject({ status: z.enum([...]) });
 *
 * Spec reference:
 *   error-handling §"Zod .strict() policy for unknown keys"
 *   Architecture Decision #1 — Permanent from Cycle 2.
 */
export function strictObject<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T, "strict"> {
  return z.object(shape).strict();
}

/**
 * Installs the global Zod errorMap that maps `unrecognized_keys` issues to
 * the stable message format: `"Field '<name>' is not allowed"`.
 *
 * Emits one message per unrecognized key: only the first key is surfaced in
 * the message. Zod groups all unrecognized keys into a single ZodIssue
 * (issue.keys[]), so this errorMap uses issue.keys[0] to keep the error
 * surface predictable and spec-aligned. Callers that need to enumerate all
 * offending keys should inspect issue.keys directly before the errorMap is
 * applied (e.g., in a custom validation pipeline).
 *
 * Per spec: error-handling §"Zod .strict() policy for unknown keys" — one
 * stable, human-readable message per issue is the required contract.
 *
 * Call this ONCE at application bootstrap (src/app.ts or server.ts) BEFORE
 * any request reaches the validation layer. In tests, it is called in
 * tests/setup.ts so every test file shares the same error surface.
 *
 * Idempotent: safe to call multiple times (subsequent calls overwrite with
 * an identical handler, so behavior does not change).
 *
 * Spec reference:
 *   error-handling §"Zod .strict() policy for unknown keys"
 *   error-handling scenario "Unknown key rejected uniformly"
 */
export function installGlobalErrorMap(): void {
  z.setErrorMap((issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      const keys = issue.keys ?? [];
      return {
        message:
          keys.length > 0
            ? `Field '${keys[0]}' is not allowed`
            : "Unrecognized key(s) in object",
      };
    }
    return { message: ctx.defaultError };
  });
}
