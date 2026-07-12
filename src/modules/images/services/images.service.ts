/**
 * Images service — presign and confirm for product image uploads via S3.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as imagesService from "@/modules/images/services/images.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 *
 * Key invariants:
 *   - presign: validates mimeType/contentLength BEFORE calling S3 (never leaks credentials).
 *   - presign: owner check via prisma.product.findFirst({ where: { id, producerId } });
 *     cross-producer access returns ProductNotFoundError (404) — no-leak pattern.
 *   - presign: does NOT insert any DB row. Only produces a presigned PUT URL + s3Key.
 *   - confirm: runs inside $transaction: HEAD-check S3 → insert ProductImage.
 *   - confirm: HEAD 404/NoSuchKey maps to ImageUploadInvalidError (400) — Decision #2.
 *   - confirm: Prisma P2002 on (productId, position) maps to ImageUploadInvalidError (400).
 *
 * ─── PII-SAFETY AUDIT ──────────────────────────────────────────────────────
 *
 *   The s3Key MUST NEVER appear in any thrown error's `detail` field.
 *   Spec: error-handling §"ImageUploadInvalidError never echoes the s3Key"
 *
 *   Audit checklist (enforced in every ImageUploadInvalidError throw below):
 *     ✗ Do not interpolate `input.s3Key` into the error message.
 *     ✗ Do not include the raw SDK error message (may contain the key path).
 *     ✗ Do not include column names from P2002.meta.target.
 *     ✓ Use generic, human-readable messages only.
 *
 * ─── VALIDATION SPLIT ──────────────────────────────────────────────────────
 *
 *   mimeType and contentLength (for presign) are validated in the SERVICE
 *   (not in the Zod DTO) to produce IMAGE_UPLOAD_INVALID (400), not
 *   VALIDATION_FAILED (422). The DTO enforces structural shape only.
 *
 * S3 wrapper: REUSES src/shared/s3/s3-client.ts (Slice 2 infra).
 * No new S3 wrapper is created per design.
 *
 * Spec references:
 *   product-images §"Presign endpoint contract", §"Confirm endpoint contract",
 *                  §"ProductImage entity", §"Test hygiene — mock the SDK"
 *   error-handling §"ImageUploadInvalidError never echoes the s3Key"
 *   design §"S3 image flow", Decision #2 (HEAD 404 → 400, not 404)
 *   design ADR-003 (no repositories/ layer)
 */
import { randomUUID } from "crypto";

import type { ProductImage } from "@prisma/client";

import { getPresignedUrl, headObject } from "@/shared/s3/s3-client";
import { ImageUploadInvalidError, ProductNotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";
import { ALLOWED_MIME_TYPES, MAX_CONTENT_LENGTH } from "../dto/images.dto";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PresignInput {
  /** Must be one of: image/jpeg | image/png | image/webp */
  mimeType: string;
  /** Maximum 5 MB (5 * 1024 * 1024 bytes). */
  contentLength: number;
}

export interface PresignResult {
  /** Presigned PUT URL (TTL: 300 s per spec). */
  uploadUrl: string;
  /** Opaque S3 key to pass to the confirm endpoint. Must NOT be echoed in errors. */
  s3Key: string;
  /** URL validity in seconds. Always 300. */
  expiresIn: number;
}

export interface ConfirmInput {
  /** Opaque S3 key obtained from the presign response. */
  s3Key: string;
  /** Must be one of: image/jpeg | image/png | image/webp */
  mimeType: string;
  /** Position index. Unique per (productId, position). */
  position: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Presigned PUT URL TTL. Spec: product-images §"Presign endpoint contract". */
const PRESIGN_TTL_SECS = 300;

/** S3 bucket name — read from env. Required at presign/confirm time. */
const S3_BUCKET = process.env["AWS_BUCKET_NAME"] ?? "mercado-artesanal-images";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether an error from the S3 SDK represents a 404 / object-not-found
 * condition. The AWS SDK v3 may surface this as:
 *   - `err.name === 'NotFound'` (HeadObjectCommand on a missing key)
 *   - `err.name === 'NoSuchKey'` (some SDK versions / LocalStack)
 *   - `err.$metadata.httpStatusCode === 404`
 *
 * REFACTOR: Extracted from the inline `catch` block in `confirm()` to make the
 * detection logic testable and auditable in one place.
 *
 * Design Decision #2: callers map this condition to ImageUploadInvalidError (400),
 * never to a 404 response.
 */
function isS3ObjectNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) {
    // Non-Error object with $metadata (some SDK shapes)
    return (
      typeof err === "object" &&
      err !== null &&
      "$metadata" in err &&
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
    );
  }
  return (
    err.name === "NotFound" ||
    err.name === "NoSuchKey" ||
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

// ---------------------------------------------------------------------------
// presign
// ---------------------------------------------------------------------------

/**
 * Generate a presigned PUT URL for direct client-to-S3 upload.
 *
 * Steps:
 *   1. Validate mimeType against allow-list — throws IMAGE_UPLOAD_INVALID (400)
 *      BEFORE any owner check or S3 call. Spec: "Invalid mimeType rejected before presign".
 *   2. Validate contentLength (≤ 5 MB) — same fast-fail before owner check.
 *   3. Owner check: product must exist and belong to producerId.
 *      Cross-producer: ProductNotFoundError (404) — no-leak.
 *   4. Generate an opaque s3Key (UUID-based — no mimeType, no extension, no s3Key in errors).
 *   5. Call getPresignedUrl (TTL 300 s).
 *   6. Return { uploadUrl, s3Key, expiresIn: 300 }.
 *   7. NEVER insert any DB row.
 *
 * PII-safety: the s3Key generated in step 4 is opaque (UUID) and is NOT included
 * in any thrown error. Callers receive the key in the success response only.
 *
 * Spec: product-images §"Presign endpoint contract"
 * Design: §"S3 image flow"
 */
export async function presign(
  producerId: string,
  productId: string,
  input: PresignInput,
): Promise<PresignResult> {
  // Step 1: validate mimeType against allow-list.
  // Throws IMAGE_UPLOAD_INVALID (400) — NOT the Zod VALIDATION_FAILED (422).
  // S3 SDK must NEVER be called with an unsupported MIME type.
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ImageUploadInvalidError(
      `Unsupported MIME type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }

  // Step 2: validate contentLength — must not exceed 5 MB.
  // Throws IMAGE_UPLOAD_INVALID (400); S3 SDK must NOT be called.
  if (input.contentLength > MAX_CONTENT_LENGTH) {
    throw new ImageUploadInvalidError(
      `Content too large. Maximum allowed size is ${MAX_CONTENT_LENGTH} bytes (5 MB)`,
    );
  }

  // Step 3: owner check — product must exist and belong to producerId (no-leak).
  const product = await prisma.product.findFirst({
    where: { id: productId, producerId, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    throw new ProductNotFoundError("Product not found");
  }

  // Step 4: generate an opaque s3Key — UUID-based, no extension, no PII.
  // The key structure encodes producer + product context for S3 organisation
  // but does NOT include the mimeType to keep it opaque and PII-safe.
  const s3Key = `producers/${producerId}/products/${productId}/img/${randomUUID()}`;

  // Step 5: generate presigned PUT URL (TTL 300 s per spec).
  const uploadUrl = await getPresignedUrl(
    {
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: input.mimeType,
      ContentLength: input.contentLength,
    },
    PRESIGN_TTL_SECS,
  );

  // Step 6: return shape — no DB insert ever.
  return { uploadUrl, s3Key, expiresIn: PRESIGN_TTL_SECS };
}

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

/**
 * Confirm a completed S3 upload: verify the object exists and insert ProductImage.
 *
 * Steps (inside $transaction for atomicity):
 *   1. Validate mimeType — IMAGE_UPLOAD_INVALID (400) if not in allow-list.
 *   2. Owner check: product must exist and belong to producerId.
 *      Cross-producer: ProductNotFoundError (404) — no-leak.
 *   3. S3 HEAD: verify the uploaded object exists in S3.
 *      - isS3ObjectNotFound(err) → ImageUploadInvalidError (400).
 *      - The s3Key MUST NOT appear in the error detail.
 *   4. Insert ProductImage row.
 *      - Prisma P2002 on @@unique([productId, position]) → ImageUploadInvalidError (400).
 *      - Column names (product_id, position) and s3Key MUST NOT appear in the detail.
 *   5. Return the new ProductImage.
 *
 * ─── Design Decision #2 ────────────────────────────────────────────────────
 *
 *   S3 HEAD 404 → IMAGE_UPLOAD_INVALID (400), NOT 404.
 *   Rationale: the Product resource exists; the client failed the upload
 *   precondition. A 404 response would mislead the frontend into a
 *   "product deleted" UX path.
 *
 *   Spec: product-images §"Confirm without prior S3 object rejected"
 *   Design: Decision #2 — mapping lives HERE (service), not in the controller.
 *
 * ─── PII-safety contract ───────────────────────────────────────────────────
 *
 *   Both error paths (HEAD 404 and P2002) use generic messages that do NOT
 *   include: the s3Key, column names from P2002.meta.target, SDK error messages,
 *   or any user-supplied data. This is enforced by the audit checklist at the
 *   top of this file.
 *
 * Spec: product-images §"Confirm endpoint contract",
 *       error-handling §"ImageUploadInvalidError never echoes the s3Key"
 * Design: Decision #2, §"S3 image flow"
 */
export async function confirm(
  producerId: string,
  productId: string,
  input: ConfirmInput,
): Promise<ProductImage> {
  // Step 1: validate mimeType against allow-list (same business-rule as presign).
  // Runs OUTSIDE the transaction so we fail-fast before any DB or S3 call.
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ImageUploadInvalidError(
      `Unsupported MIME type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }

  return prisma.$transaction(async (tx) => {
    // Step 2: owner check (same no-leak pattern as products.service).
    const product = await tx.product.findFirst({
      where: { id: productId, producerId, deletedAt: null },
      select: { id: true },
    });
    if (!product) {
      throw new ProductNotFoundError("Product not found");
    }

    // Step 3: S3 HEAD — verify the uploaded object exists in S3.
    //
    // isS3ObjectNotFound() covers all S3 SDK v3 NotFound variants:
    //   - err.name === 'NotFound'    (HeadObjectCommand, standard SDK)
    //   - err.name === 'NoSuchKey'   (some SDK versions / LocalStack)
    //   - err.$metadata.httpStatusCode === 404 (raw HTTP fallback)
    //
    // PII-SAFETY: The generic message below does NOT include `input.s3Key`.
    // The raw SDK error message (which may contain the key path) is discarded.
    try {
      await headObject({ Bucket: S3_BUCKET, Key: input.s3Key });
    } catch (err) {
      if (isS3ObjectNotFound(err)) {
        throw new ImageUploadInvalidError(
          "The uploaded object could not be found in storage. Please upload the file before confirming.",
        );
      }
      throw err;
    }

    // Step 4: insert ProductImage row.
    //
    // Prisma P2002 on @@unique([productId, position]) → IMAGE_UPLOAD_INVALID (400).
    //
    // PII-SAFETY: The generic message below does NOT include:
    //   - `input.s3Key`        (PII-safety per spec)
    //   - column names         (P2002.meta.target contains ["product_id", "position"])
    //   - the Prisma error message (may contain table/column info)
    try {
      return await tx.productImage.create({
        data: {
          productId,
          s3Key: input.s3Key,
          mimeType: input.mimeType,
          position: input.position,
        },
      });
    } catch (err) {
      const isUniqueViolation =
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "P2002";

      if (isUniqueViolation) {
        throw new ImageUploadInvalidError(
          "An image already exists at this index for the product. Use a different index.",
        );
      }
      throw err;
    }
  });
}
