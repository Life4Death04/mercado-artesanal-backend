/**
 * Statistics routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET /api/v1/producers/me/stats/revenue?window=<value>      — revenue aggregate (producer)
 *   GET /api/v1/producers/me/stats/order-count?window=<value>  — order count (producer)
 *   GET /api/v1/producers/me/stats/low-stock[?limit&offset]    — low-stock alerts (producer)
 *
 * Auth chain (per design API surface table):
 *   authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *
 * Spec references:
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint"
 *   design — API surface table
 *
 * Non-goals (MUST NOT be registered here):
 *   - GET /producers/me/stats/top-products (ranking)
 *   - GET /producers/me/stats/cohort (cohort analytics)
 *   - Any time-bucketed series endpoint
 *   Spec: sales-stats §"Non-goals"
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as statisticsController from "../controllers/statistics.controller";

export const statisticsRouter: Router = Router();

// Producer-scoped guard — same chain as sub-orders, producers, images routes
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// ---------------------------------------------------------------------------
// Revenue window endpoint
// ---------------------------------------------------------------------------

statisticsRouter.get(
  "/producers/me/stats/revenue",
  ...producerGuard,
  statisticsController.getRevenue,
);

// ---------------------------------------------------------------------------
// Order count window endpoint
// ---------------------------------------------------------------------------

statisticsRouter.get(
  "/producers/me/stats/order-count",
  ...producerGuard,
  statisticsController.getOrderCount,
);

// ---------------------------------------------------------------------------
// Low-stock alerts endpoint
// ---------------------------------------------------------------------------

statisticsRouter.get(
  "/producers/me/stats/low-stock",
  ...producerGuard,
  statisticsController.getLowStock,
);
