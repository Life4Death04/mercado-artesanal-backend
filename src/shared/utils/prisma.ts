/**
 * Prisma client singleton.
 *
 * A single PrismaClient instance is shared across the entire process.
 * Instantiating multiple clients causes connection pool exhaustion under load
 * and breaks the test isolation strategy (each test file uses one connection).
 *
 * Log levels mirror the app LOG_LEVEL: only "error" is enabled in production
 * to avoid leaking query parameters in structured logs. In development, "query"
 * is added so slow queries surface during local work.
 *
 * Callers import `prisma` directly — they never construct PrismaClient themselves.
 */
import { PrismaClient } from "@prisma/client";

import { env } from "./env";

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: env.NODE_ENV === "development" ? ["query", "info", "warn", "error"] : ["error"],
  });
}

// Module-level singleton — safe because Node.js module cache guarantees
// this file is evaluated exactly once per process lifetime.
export const prisma: PrismaClient = createPrismaClient();
