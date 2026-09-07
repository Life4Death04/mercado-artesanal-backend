import { isIP } from "node:net";

import { z } from "zod";

function commaSeparatedValues(value: string, ctx: z.RefinementCtx): string[] {
  const values = value.split(",").map((entry) => entry.trim());
  if (values.some((entry) => entry.length === 0)) {
    ctx.addIssue({ code: "custom", message: "must be a comma-separated list without empty entries" });
    return z.NEVER;
  }
  return [...new Set(values)];
}

function isValidOrigin(value: string): boolean {
  if (value === "*") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      value.replace(/\/$/, "") === url.origin
    );
  } catch {
    return false;
  }
}

function isValidProxy(value: string): boolean {
  if (value === "loopback") return true;
  const [address, prefix, extra] = value.split("/");
  if (address === undefined) return false;
  const version = isIP(address);
  if (extra !== undefined || version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits > 0 && bits <= (version === 4 ? 32 : 128);
}

function isValidDatabaseHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "");
  return (
    isIP(host) !== 0 ||
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
      host,
    )
  );
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    AUTH0_DOMAIN: z.string().min(1),
    AUTH0_AUDIENCE: z.string().min(1),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    CORS_ORIGIN: z
      .string()
      .default("*")
      .transform(commaSeparatedValues)
      .refine((origins) => origins.every(isValidOrigin), {
        message: "must contain only valid HTTP(S) origins without paths",
      })
      .refine((origins) => origins.length === 1 || !origins.includes("*"), {
        message: "wildcard origin cannot be combined with other origins",
      }),
    TRUST_PROXY: z
      .string()
      .default("loopback")
      .transform(commaSeparatedValues)
      .refine((proxies) => proxies.every(isValidProxy), {
        message: "must contain only loopback, exact IP addresses, or CIDR ranges",
      }),
    S3_PUBLIC_BASE_URL: z.string().url().min(1),
    // Cycle 5 — payments slice (consumer-purchase-flow 3/3). Server-side Stripe
    // secret key used exclusively by src/modules/payments/services/stripe.client.ts
    // to construct the SDK client. Never sent to the browser.
    STRIPE_SECRET_KEY: z.string().min(1),
    // Cycle 5 WU2 — Stripe webhook signing secret ("whsec_..."), used ONLY by
    // payments.service.ts's `verifyWebhookSignature` to verify the raw request
    // body signature on POST /pagos/webhook (design Decision 2, spec R6).
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    // Cycle 5 — notifications Phase 2 (email-provider boundary). Selects the
    // EmailProvider implementation once at module-load time in
    // src/shared/email/email-provider.ts. "console" (default) logs and makes
    // no external call — zero AWS risk. "ses" sends via @aws-sdk/client-ses
    // (src/shared/email/ses-email-provider.ts). An unrecognized value fails
    // boot here (fail-fast), before any provider is constructed.
    EMAIL_PROVIDER: z.enum(["console", "ses"]).default("console"),
    // admin-database-backups — private artifact root (realpath'd, non-public,
    // mode 0700 per design "Storage and Safety") that stores archives,
    // manifests, tombstones, and operation receipts. Absolute path required —
    // a missing or relative value fails boot (design: "boot fails closed").
    BACKUP_ARTIFACT_DIR: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), "must be an absolute path"),
    // Host PostgreSQL Client 16 executables. Absolute paths only — no PATH
    // lookup, shell, or Docker authority (design "Trusted PostgreSQL runtime").
    PG_DUMP_PATH: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), "must be an absolute path"),
    PG_RESTORE_PATH: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), "must be an absolute path"),
    // Deadline (ms) for a single dump/restore child-process step before the
    // runner aborts it and marks the operation FAILED (design "Data Flow").
    BACKUP_OPERATION_TIMEOUT_MS: z.coerce.number().int().positive(),
    BACKUP_DATABASE_HOST_ALLOWLIST: z
      .string()
      .default("")
      .transform((value, ctx) => (value === "" ? [] : commaSeparatedValues(value, ctx)))
      .refine((hosts) => hosts.every(isValidDatabaseHost), {
        message: "must contain only exact hostnames or IP addresses",
      })
      .transform((hosts) => hosts.map((host) => host.replace(/^\[|\]$/g, "").toLowerCase())),
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
    if (v.NODE_ENV === "production") {
      for (const origin of v.CORS_ORIGIN) {
        if (origin === "*" || !origin.startsWith("https://")) {
          ctx.addIssue({
            code: "custom",
            path: ["CORS_ORIGIN"],
            message: "production origins must use explicit HTTPS URLs",
          });
          break;
        }
      }
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
