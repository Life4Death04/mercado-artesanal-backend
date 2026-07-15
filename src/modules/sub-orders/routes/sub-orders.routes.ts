/**
 * Sub-orders routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET    /api/v1/producers/me/sub-orders        — list own SubOrders (producer)
 *   GET    /api/v1/producers/me/sub-orders/:id    — get own SubOrder with lines (producer)
 *   PATCH  /api/v1/producers/me/sub-orders/:id    — state-machine transition (producer)
 *
 * Auth chain (per design API surface table):
 *   authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *
 * Spec references:
 *   order-fulfillment §"Producer read of own SubOrders"
 *   order-fulfillment §"State machine"
 *   design — API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as subOrdersController from "../controllers/sub-orders.controller";

export const subOrdersRouter: Router = Router();

// Producer-scoped guard — same chain as delivery-modes, products, images routes
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// ---------------------------------------------------------------------------
// Collection routes
// ---------------------------------------------------------------------------

subOrdersRouter.get(
  "/producers/me/sub-orders",
  ...producerGuard,
  subOrdersController.listSubOrders,
);

// ---------------------------------------------------------------------------
// Member routes
// ---------------------------------------------------------------------------

subOrdersRouter.get(
  "/producers/me/sub-orders/:id",
  ...producerGuard,
  subOrdersController.getSubOrder,
);

subOrdersRouter.patch(
  "/producers/me/sub-orders/:id",
  ...producerGuard,
  subOrdersController.patchSubOrder,
);
