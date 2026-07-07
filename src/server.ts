/**
 * Process entry-point.
 *
 * Load order (matters for fail-fast env validation):
 *   1. env.ts — Zod parse throws here if any required var is missing/invalid.
 *      The process exits non-zero before any I/O or middleware wires up.
 *   2. createApp() — configure Express factory.
 *   3. app.listen() — open TCP socket and log startup.
 *
 * Database connection (Prisma) is established lazily on first query in PR#2.
 * Explicit connect + graceful shutdown added in PR#2.
 */
import { env } from "@/shared/utils/env";

import { createApp } from "./app";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[server] listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown stubs — full implementation in PR#2 after Prisma singleton is wired.
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received — shutting down");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("[server] SIGINT received — shutting down");
  server.close(() => process.exit(0));
});
