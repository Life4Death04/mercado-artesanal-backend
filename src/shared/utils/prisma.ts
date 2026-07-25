/**
 * Prisma client singleton.
 *
 * A single PrismaClient instance is shared across the entire process.
 * Instantiating multiple clients causes connection pool exhaustion under load
 * and breaks the test isolation strategy (each test file uses one connection).
 *
 * Log levels mirror the app LOG_LEVEL: only "error" is auto-printed to stdout
 * in production to avoid leaking query parameters in structured logs. In
 * development, "query"/"info"/"warn" are also printed so slow queries surface
 * during local work.
 *
 * "query"/"info"/"warn" are always configured with `emit: "event"` (never
 * auto-printed outside development) so integration tests can subscribe via
 * `prisma.$on("query", ...)` for query-count assertions (NFR-1, cart design
 * D4) WITHOUT enabling any additional stdout logging in production — nothing
 * subscribes to these events unless a test opts in explicitly.
 *
 * Callers import `prisma` directly — they never construct PrismaClient themselves.
 */
import { PrismaClient } from "@prisma/client";

import { env } from "./env";

function createPrismaClient() {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "info" },
      { emit: "event", level: "warn" },
      { emit: "stdout", level: "error" },
    ],
  });

  if (env.NODE_ENV === "development") {
    client.$on("query", (e) => {
      console.log(`${e.query} -- params: ${e.params} -- ${e.duration}ms`);
    });
    client.$on("info", (e) => {
      console.log(e.message);
    });
    client.$on("warn", (e) => {
      console.log(e.message);
    });
  }

  return client;
}

// Module-level singleton — safe because Node.js module cache guarantees
// this file is evaluated exactly once per process lifetime.
export const prisma = createPrismaClient();
