/**
 * Express application factory.
 *
 * MUST NOT call app.listen(). The server entry-point (src/server.ts) owns the
 * lifecycle so test harnesses (Supertest) can mount the app in-memory without
 * opening a TCP socket.
 *
 * Middleware composition order (per design §6):
 *   1. helmet          — security headers before anything else
 *   2. cors            — cross-origin rejection at the edge (before body/log I/O)
 *   3. compression     — transparent to routing; applied when response is sent
 *   4. express.json    — body parser before pino-http (body must be parsed for redaction paths)
 *   5. pino-http       — request logger + correlation ID (assigns req.id to every request)
 *   6. /health router  — public, no auth chain; cheap probes bypass everything downstream
 *   7. /api/v1 router  — private (each module router wires authenticate → loadUser → ... → handler)
 *                         STUB in PR#2 — wired in PR#4b
 *   8. notFoundHandler — reaches only unrouted paths
 *   9. errorMiddleware — 4-arg Express error handler; MUST be the LAST middleware
 *                         STUB in PR#2 — real implementation in PR#3
 *
 * @param opts.logger - Optional pino Logger instance injected by test harnesses.
 *   When omitted the app uses the module-level singleton (default runtime path).
 *   This keeps the production code path completely unchanged — `createApp()`
 *   with no arguments works exactly as before.
 */
import crypto from "node:crypto";

import compression from "compression";
import cors from "cors";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import pinoHttp from "pino-http";

import { healthRouter } from "@/modules/health/routes/health.routes";
import { logger as defaultLogger } from "@/shared/utils/logger";

import { env } from "./shared/utils/env";

export interface CreateAppOptions {
  /** Injected pino logger (test harnesses). Defaults to the singleton. */
  logger?: Logger;
}

export function createApp({ logger = defaultLogger }: CreateAppOptions = {}): Express {
  const app = express();

  // 1. Security headers
  app.use(helmet());

  // 2. CORS — reject cross-origin at the edge before body/log I/O
  app.use(cors({ origin: env.CORS_ORIGIN }));

  // 3. Compression — transparent; happens after routing sends the response
  app.use(compression());

  // 4. Body parser — must run before pino-http so req.body is available for redaction
  app.use(express.json({ limit: "10mb" }));

  // 5. HTTP request logger + correlation ID
  //    - Reuses X-Request-Id when provided; generates UUID v4 otherwise.
  //    - Echoes the ID back on X-Request-Id response header.
  //    - Every downstream handler sees req.id (and req.log for child loggers).
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => {
        const incoming = req.headers["x-request-id"];
        return typeof incoming === "string" && incoming.length > 0 ? incoming : crypto.randomUUID();
      },
      customProps: (req) => ({ reqId: req.id }),
      customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
      serializers: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req: (req: any) => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          id: req.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          method: req.method,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          url: req.url,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          headers: req.headers,
        }),
        // Response body intentionally omitted (spec: no bodies in production logs)
      },
    }),
  );

  // Echo correlation ID back to the client on every response.
  // pino-http augments req.id — it may be a string or number; normalise to string.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rawId: unknown = req.id;
    const reqId =
      typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
    res.setHeader("X-Request-Id", reqId);
    next();
  });

  // 6. Public health routes — bypass auth chain
  app.use("/health", healthRouter);

  // 7. Private API routes — stub; wired in PR#4b
  // app.use("/api/v1", apiRouter);

  // 8. 404 fallback — stub; replaced with real notFoundHandler in PR#3
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 404, message: "Not found" });
  });

  // 9. Error handler — stub; replaced with real RFC 7807 errorMiddleware in PR#3
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled error");
    res.status(500).json({ status: 500, message: "Internal server error" });
  });

  return app;
}
