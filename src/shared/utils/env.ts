import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CORS_ORIGIN: z.string().default("*"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validated environment variables.
 * Throws at import time if any required variable is missing or invalid (fail-fast per RNF-12).
 */
export const env: Env = EnvSchema.parse(process.env);
