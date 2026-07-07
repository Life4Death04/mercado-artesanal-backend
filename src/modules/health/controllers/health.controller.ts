/**
 * Health check controllers.
 *
 * These handlers deliberately bypass the standard auth chain and errorMiddleware.
 * They own their response shapes completely so container orchestrators (ECS, k8s)
 * can parse a stable, non-RFC-7807 contract.
 *
 * Liveness  → GET /health       — process-alive signal only, no external I/O
 * Readiness → GET /health/ready — DB reachability probe (SELECT 1 with 500ms timeout)
 *
 * Per health-checks spec:
 *   - Neither endpoint touches Auth0, S3, SES, or any dependency beyond DB (readiness only).
 *   - Both must remain unauthenticated (no middleware in the route chain).
 *   - Liveness always returns 200 if the process can run code.
 *   - Readiness returns 503 on any DB failure (timeout or error).
 */
import type { Request, Response } from "express";

import { logger } from "@/shared/utils/logger";
import { prisma } from "@/shared/utils/prisma";

const DB_PROBE_TIMEOUT_MS = 500;

/**
 * Check DB reachability with a hard 500ms timeout.
 * Returns true on success, false on any error or timeout.
 */
async function dbHealthy(): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("db timeout")), DB_PROBE_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch (err: unknown) {
    logger.warn({ err }, "readiness probe: DB unreachable");
    return false;
  }
}

/**
 * GET /health
 *
 * Returns 200 as long as the process is alive and can serialize JSON.
 * Body: { status: "ok", version: string, uptime: number }
 */
export function liveness(_req: Request, res: Response): void {
  res.status(200).json({
    status: "ok",
    version: process.env["npm_package_version"] ?? "0.0.0",
    uptime: process.uptime(),
  });
}

/**
 * GET /health/ready
 *
 * Returns 200 when the DB is reachable, 503 otherwise.
 * Body on success:  { status: "ok", db: "ok" }
 * Body on failure:  { status: "degraded", db: "unreachable" }
 */
export async function readiness(_req: Request, res: Response): Promise<void> {
  const ok = await dbHealthy();
  if (ok) {
    res.status(200).json({ status: "ok", db: "ok" });
  } else {
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
}
