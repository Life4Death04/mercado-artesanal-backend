/**
 * S3 client wrapper — thin facade over @aws-sdk/client-s3.
 *
 * Isolates all AWS SDK imports in one module so tests can mock the entire
 * AWS surface via the global vi.mock in tests/setup.ts without touching
 * individual feature modules.
 *
 * Exports:
 *   - `s3`              — singleton `S3Client` instance (lazy-initialised)
 *   - `getPresignedUrl` — wraps `getSignedUrl` from @aws-sdk/s3-request-presigner
 *   - `headObject`      — sends a HeadObjectCommand; throws if object is missing
 *
 * Configuration:
 *   All values are read from environment variables at startup:
 *     AWS_REGION      (default: "eu-west-1")
 *     AWS_BUCKET_NAME — required at presign/head time (not constructor time)
 *
 * Design reference:
 *   design §"S3 image flow" — presign (PUT TTL 300s) + HEAD confirm
 *   design §Testing Strategy — "S3 mock leakage → real network" prevention
 *   product-images §"Test hygiene — mock the SDK"
 */
import {
  HeadObjectCommand,
  type HeadObjectCommandInput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ---------------------------------------------------------------------------
// Singleton S3Client
// ---------------------------------------------------------------------------

/**
 * Lazily-initialised singleton. Constructed once on first use so the module
 * can be imported (and mocked) without requiring AWS credentials at import time.
 */
let _s3Client: S3Client | undefined;

/**
 * Returns the shared `S3Client` singleton.
 * Reads `AWS_REGION` from the environment (defaults to "eu-west-1").
 */
export function getS3Client(): S3Client {
  if (!_s3Client) {
    _s3Client = new S3Client({
      region: process.env["AWS_REGION"] ?? "eu-west-1",
    });
  }
  return _s3Client;
}

/** Convenience re-export of the singleton for callers that do not need lazy init. */
export const s3 = getS3Client();

// ---------------------------------------------------------------------------
// Presigned PUT URL
// ---------------------------------------------------------------------------

/**
 * Generates a presigned PUT URL for direct client-to-S3 uploads.
 *
 * @param input   - `PutObjectCommandInput` (bucket, key, contentType, etc.)
 * @param ttlSecs - URL validity in seconds. Default: 300 (5 minutes, per spec).
 * @returns       Presigned URL string.
 */
export async function getPresignedUrl(
  input: PutObjectCommandInput,
  ttlSecs = 300,
): Promise<string> {
  const command = new PutObjectCommand(input);
  return getSignedUrl(getS3Client(), command, { expiresIn: ttlSecs });
}

// ---------------------------------------------------------------------------
// HEAD object — confirm upload existence
// ---------------------------------------------------------------------------

/**
 * Sends a `HeadObjectCommand` to verify an object exists in S3.
 *
 * Per design Decision #2: if the object is missing (S3 returns 404 / NoSuchKey),
 * the caller is responsible for mapping the error to `ImageUploadInvalidError` (400).
 * This function re-throws the raw SDK error so the caller (images.service.confirm)
 * can inspect `$metadata.httpStatusCode` or `name === 'NotFound'`.
 *
 * @param input - `HeadObjectCommandInput` (bucket, key).
 */
export async function headObject(input: HeadObjectCommandInput): Promise<void> {
  const command = new HeadObjectCommand(input);
  await getS3Client().send(command);
}
