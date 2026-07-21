import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    AUTH0_DOMAIN: z.string().min(1),
    AUTH0_AUDIENCE: z.string().min(1),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    CORS_ORIGIN: z.string().default("*"),
    S3_PUBLIC_BASE_URL: z.string().url().min(1),
  })
  .superRefine((v, ctx) => {
    // Positive check: fail-closed when NODE_ENV === "production" and URL is not HTTPS.
    // A missing/misspelled NODE_ENV would already fail the z.enum above, so we never
    // reach this branch with an unknown NODE_ENV value.
    if (v.NODE_ENV === "production" && !v.S3_PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["S3_PUBLIC_BASE_URL"],
        message: "HTTPS required when NODE_ENV === 'production'",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate an environment object against the schema.
 *
 * Exported so unit tests can exercise validation logic with arbitrary inputs
 * without relying on the process.env singleton or needing env-var mutation.
 *
 * @throws {ZodError} if the input fails schema validation.
 */
export function parseEnv(input: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.parse(input);

  // Defense-in-depth: warn when a non-production environment uses http://.
  // Allowed by the spec (MinIO / LocalStack on plain HTTP), but surfaced
  // operationally so it is not silently ignored.
  //
  // Using console.warn here to avoid circular import with logger.ts which
  // depends on validated env. This runs at module-load time for the singleton
  // and inside parseEnv for test callers — logger is not yet available at that
  // point in the import chain.
  if (parsed.NODE_ENV !== "production" && parsed.S3_PUBLIC_BASE_URL.startsWith("http://")) {
    console.warn(
      `[env] S3_PUBLIC_BASE_URL uses http:// — allowed only because NODE_ENV is not 'production' (current: ${parsed.NODE_ENV})`,
    );
  }

  return parsed;
}

/**
 * Validated environment variables.
 * Throws at import time if any required variable is missing or invalid (fail-fast per RNF-12).
 */
export const env: Env = parseEnv(process.env);
