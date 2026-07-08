/**
 * Health routes — public, unauthenticated.
 *
 * Mounted at /health in src/app.ts.
 * No auth middleware, no errorMiddleware — these handlers are intentionally isolated.
 *
 * Routes:
 *   GET /health       → liveness (process-alive)
 *   GET /health/ready → readiness (DB probe)
 */
import { Router } from "express";

import { liveness, readiness } from "../controllers/health.controller";

export const healthRouter: Router = Router();

healthRouter.get("/", liveness);
healthRouter.get("/ready", readiness);
