/**
 * Images DTOs — Zod schemas for request body validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Forbidden-field protection examples:
 *   PresignBody  — `s3Key`, `producerId`, `productId` (server-generated)
 *   ConfirmBody  — `producerId`, `productId` (from route param), `createdAt`
 *
 * Spec references:
 *   product-images §"Presign endpoint contract" — mimeType + contentLength
 *   product-images §"Confirm endpoint contract" — s3Key + mimeType + position
 *   error-handling §"Zod .strict() policy for unknown keys" (Cycle 2)
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Allowed MIME types (spec invariant — MUST NOT be widened without spec update)
// ---------------------------------------------------------------------------

/** Spec: product-images §"Invariants" — MIME allow-list is jpeg/png/webp only. */
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Zod enum for the MIME allow-list. */
export const MimeTypeEnum = z.enum(ALLOWED_MIME_TYPES);

/** Spec: product-images §"Presign endpoint contract" — contentLength MUST be ≤ 5 MB. */
export const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Presign request body
// ---------------------------------------------------------------------------

/**
 * Body for POST /producers/me/products/:id/images/presign.
 *
 * Spec: product-images §"Presign endpoint contract":
 *   - mimeType: string (validated against allow-list in the SERVICE, not here)
 *   - contentLength: integer > 0 (max enforced in the SERVICE for IMAGE_UPLOAD_INVALID 400)
 *
 * NOTE on validation split:
 *   Zod-level (DTO) validates structural shape (type correctness, required fields).
 *   Business-rule validation (allow-list + 5 MB cap) runs in the SERVICE and throws
 *   ImageUploadInvalidError (400), NOT ValidationFailedError (422). This matches the
 *   spec requirement: "mimeType MUST be one of..." response is 400 IMAGE_UPLOAD_INVALID,
 *   not 422 VALIDATION_FAILED.
 */
export const PresignBodySchema = strictObject({
  mimeType: z.string().min(1, "mimeType must not be empty"),
  contentLength: z
    .number()
    .int("contentLength must be an integer")
    .min(1, "contentLength must be at least 1 byte"),
});

export type PresignBody = z.infer<typeof PresignBodySchema>;

// ---------------------------------------------------------------------------
// Confirm request body
// ---------------------------------------------------------------------------

/**
 * Body for POST /producers/me/products/:id/images/confirm.
 *
 * Spec: product-images §"Confirm endpoint contract":
 *   - s3Key: non-empty opaque string (server-generated in presign response)
 *   - mimeType: string (validated against allow-list in the SERVICE for IMAGE_UPLOAD_INVALID 400)
 *   - position: integer ≥ 0 (default 0 per schema)
 *
 * NOTE: Same validation-split rationale as PresignBodySchema above — mimeType
 * business-rule enforcement lives in the service to produce 400, not 422.
 */
export const ConfirmBodySchema = strictObject({
  s3Key: z.string().min(1, "s3Key must not be empty"),
  mimeType: z.string().min(1, "mimeType must not be empty"),
  position: z.number().int("position must be an integer").min(0, "position must be ≥ 0"),
});

export type ConfirmBody = z.infer<typeof ConfirmBodySchema>;
