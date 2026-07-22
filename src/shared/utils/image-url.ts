import { env } from "./env";

/**
 * Derive the public URL for an S3-stored image from its storage key.
 *
 * Reads `env.S3_PUBLIC_BASE_URL` (the validated singleton populated at boot
 * by the Zod env schema). This function is NOT strictly pure — it depends on
 * module-level env state — but `S3_PUBLIC_BASE_URL` is immutable after boot,
 * so it behaves deterministically in practice.
 *
 * Slash normalization (spec §"URL derivation from s3Key"):
 *   - Strips one trailing `/` from the base URL (if present).
 *   - Strips one leading `/` from `s3Key` (if present).
 *   - Joins with exactly one `/`.
 *
 * Does NOT perform any scheme validation — HTTPS enforcement is the
 * responsibility of the Zod env schema at boot time, not this helper.
 *
 * @param s3Key - The raw storage key from the `ProductImage` row.
 * @returns The full public URL for the image.
 */
export function toImageUrl(s3Key: string): string {
  const base = env.S3_PUBLIC_BASE_URL.replace(/\/$/, "");
  const key = s3Key.replace(/^\//, "");
  return `${base}/${key}`;
}
