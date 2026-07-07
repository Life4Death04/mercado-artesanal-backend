/**
 * Process entry-point.
 *
 * Load order (matters for fail-fast env validation):
 *   1. env.ts      — Zod parse throws here if any required var is missing/invalid.
 *                    The process exits non-zero before any I/O or middleware wires up.
 *   2. logger.ts   — pino singleton (needs env.LOG_LEVEL and env.NODE_ENV)
 *   3. createApp() — configure Express factory (wires middleware and routes)
 *   4. app.listen  — open TCP socket and log startup
 *
 * Graceful shutdown:
 *   - SIGTERM / SIGINT: close the HTTP server, then disconnect Prisma.
 *   - Prisma disconnect is non-blocking but ensures the connection pool is
 *     released cleanly before the process exits.
 */
import { env } from "@/shared/utils/env";
import { logger } from "@/shared/utils/logger";
import { prisma } from "@/shared/utils/prisma";

import { createApp } from "./app";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown signal received — closing gracefully");
  server.close(() => {
    prisma
      .$disconnect()
      .then(() => {
        logger.info("Server closed and Prisma disconnected");
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, "Error during Prisma disconnect");
        process.exit(1);
      });
  });
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
