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
 *                         Wired in PR#4: auth/sync, users/me, onboarding/consumer|producer
 *   8. notFoundHandler — reaches only unrouted paths (PR#3: real RFC 7807 404)
 *   9. errorMiddleware — 4-arg Express error handler; MUST be the LAST middleware
 *                         PR#3: real RFC 7807 serializer replacing the PR#2 stub
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

import { apiRouter } from "@/modules/api.router";
import { healthRouter } from "@/modules/health/routes/health.routes";
import { errorMiddleware } from "@/shared/middleware/errorMiddleware";
import { notFoundHandler } from "@/shared/middleware/notFoundHandler";
import { logger as defaultLogger } from "@/shared/utils/logger";
import { installGlobalErrorMap } from "@/shared/validation/zod";

import { env } from "./shared/utils/env";

// ---------------------------------------------------------------------------
// Cycle 2 permanent policy: install the global Zod error map once at boot.
//
// Maps `unrecognized_keys` issues to "Field '<name>' is not allowed" so that
// every strictObject() DTO rejection produces a uniform, auditable message.
// Called here — BEFORE any router is mounted — so the errorMap is in place
// before the first request can reach a validation layer.
//
// Spec reference: error-handling §"Zod .strict() policy for unknown keys"
// Architecture Decision #1 — Permanent from Cycle 2.
// ---------------------------------------------------------------------------
installGlobalErrorMap();

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

  // 7. Private API routes — auth/sync, users/me, onboarding (wired in PR#4)
  app.use("/api/v1", apiRouter);

  // 8. 404 fallback — catches all unrouted paths; forwards NotFoundError to errorMiddleware
  app.use(notFoundHandler);

  // 9. Error handler — RFC 7807 serializer; MUST be the LAST middleware (4-arg Express signature)
  app.use(errorMiddleware);

  return app;
}
