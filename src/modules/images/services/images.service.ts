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
 *   - confirm: HEAD 404 maps to ImageUploadInvalidError (400) per Decision #2.
 *     The s3Key MUST NOT appear in the error detail (PII-safety invariant).
 *   - confirm: Prisma P2002 on (productId, position) maps to ImageUploadInvalidError (400).
 *     Column names and s3Key MUST NOT appear in the error detail.
 *
 * S3 wrapper: REUSES src/shared/s3/s3-client.ts (Slice 2 infra).
 * No new S3 wrapper is created per design.
 *
 * Spec references:
 *   product-images §"Presign endpoint contract", §"Confirm endpoint contract",
 *                  §"ProductImage entity", §"Test hygiene — mock the SDK"
 *   error-handling §"ImageUploadInvalidError never echoes the s3Key"
 *   design §"S3 image flow", Decision #2 (HEAD 404 → 400)
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
// presign
// ---------------------------------------------------------------------------

/**
 * Generate a presigned PUT URL for direct client-to-S3 upload.
 *
 * Steps:
 *   1. Validate mimeType (allow-list) — throws IMAGE_UPLOAD_INVALID before owner check
 *      to fail-fast on obviously invalid input.
 *   2. Validate contentLength (≤ 5 MB) — same fast-fail before owner check.
 *   3. Owner check: product must exist and belong to producerId.
 *      Cross-producer: ProductNotFoundError (404) — no-leak.
 *   4. Generate an opaque s3Key (no mimeType in the key — opaque by design).
 *   5. Call getPresignedUrl (TTL 300 s).
 *   6. Return { uploadUrl, s3Key, expiresIn: 300 }.
 *   7. NEVER insert any DB row.
 *
 * Note on validation order: spec §"Invalid mimeType rejected before presign" requires
 * the S3 SDK to NOT be called when mime is invalid. We validate mime/size first
 * (steps 1–2), then do the owner check (step 3), then call S3 (step 5).
 * The owner check precedes the S3 call so no presigned URL is issued for
 * cross-producer requests either.
 *
 * Spec: product-images §"Presign endpoint contract"
 * Design: §"S3 image flow"
 */
export async function presign(
  producerId: string,
  productId: string,
  input: PresignInput,
): Promise<PresignResult> {
  // Step 1: validate mimeType — must be in the allow-list
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ImageUploadInvalidError(
      `Unsupported MIME type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }

  // Step 2: validate contentLength — must not exceed 5 MB
  if (input.contentLength > MAX_CONTENT_LENGTH) {
    throw new ImageUploadInvalidError(
      `Content too large. Maximum allowed size is ${MAX_CONTENT_LENGTH} bytes (5 MB)`,
    );
  }

  // Step 3: owner check — product must exist and belong to producerId (no-leak)
  const product = await prisma.product.findFirst({
    where: { id: productId, producerId, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    throw new ProductNotFoundError("Product not found");
  }

  // Step 4: generate an opaque s3Key (UUID-based, no mimeType extension leakage)
  const s3Key = `producers/${producerId}/products/${productId}/img/${randomUUID()}`;

  // Step 5: generate presigned PUT URL (TTL 300 s per spec)
  const uploadUrl = await getPresignedUrl(
    {
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: input.mimeType,
      ContentLength: input.contentLength,
    },
    PRESIGN_TTL_SECS,
  );

  // Step 6: return shape — no DB insert
  return { uploadUrl, s3Key, expiresIn: PRESIGN_TTL_SECS };
}

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

/**
 * Confirm a completed S3 upload: verify the object exists and insert ProductImage.
 *
 * Steps (inside $transaction for atomicity):
 *   1. Owner check: product must exist and belong to producerId.
 *      Cross-producer: ProductNotFoundError (404) — no-leak.
 *   2. S3 HEAD: verify the uploaded object exists in S3.
 *      - NotFound (HTTP 404 or name === 'NotFound') → ImageUploadInvalidError (400).
 *      - The s3Key MUST NOT appear in the error detail (PII-safety per spec).
 *   3. Insert ProductImage row.
 *      - Prisma P2002 on @@unique([productId, position]) → ImageUploadInvalidError (400).
 *      - Column names and s3Key MUST NOT appear in the error detail.
 *   4. Return the new ProductImage.
 *
 * Design Decision #2: S3 HEAD 404 → IMAGE_UPLOAD_INVALID (400), NOT 404.
 * Rationale: the Product resource exists; the client failed the upload precondition.
 * A 404 would mislead the frontend into "product deleted" UX paths.
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
  // Validate mimeType against allow-list (same business-rule as presign).
  // This produces IMAGE_UPLOAD_INVALID (400), not VALIDATION_FAILED (422).
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ImageUploadInvalidError(
      `Unsupported MIME type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`,
    );
  }

  return prisma.$transaction(async (tx) => {
    // Step 1: owner check (same no-leak pattern as products.service)
    const product = await tx.product.findFirst({
      where: { id: productId, producerId, deletedAt: null },
      select: { id: true },
    });
    if (!product) {
      throw new ProductNotFoundError("Product not found");
    }

    // Step 2: S3 HEAD — verify the uploaded object exists
    // Per Decision #2: NotFound → IMAGE_UPLOAD_INVALID (400), never 404.
    // The s3Key MUST NOT appear in the thrown error's detail.
    try {
      await headObject({ Bucket: S3_BUCKET, Key: input.s3Key });
    } catch (err) {
      const isNotFound =
        (err instanceof Error &&
          (err.name === "NotFound" ||
            err.name === "NoSuchKey" ||
            (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ===
              404)) ||
        (typeof err === "object" &&
          err !== null &&
          "$metadata" in err &&
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);

      if (isNotFound) {
        // PII-safety: must NOT include the s3Key in the error detail
        throw new ImageUploadInvalidError(
          "The uploaded object could not be found in storage. Please upload the file before confirming.",
        );
      }
      throw err;
    }

    // Step 3: insert ProductImage row
    // Prisma P2002 on @@unique([productId, position]) → ImageUploadInvalidError (400).
    // Column names and s3Key MUST NOT appear in the error detail.
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
        // PII-safety: must NOT include column names or s3Key in the detail.
        // Deliberately avoids "position" (column name) and s3Key.
        throw new ImageUploadInvalidError(
          "An image already exists at this index for the product. Use a different index.",
        );
      }
      throw err;
    }
  });
}
