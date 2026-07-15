/**
 * Delivery-modes routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   POST   /api/v1/producers/me/delivery-modes        — create (producer)
 *   GET    /api/v1/producers/me/delivery-modes        — list (producer)
 *   GET    /api/v1/producers/me/delivery-modes/:id    — get (producer)
 *   PATCH  /api/v1/producers/me/delivery-modes/:id    — update (producer)
 *   DELETE /api/v1/producers/me/delivery-modes/:id    — hard-delete (producer)
 *
 * Auth chain (per design API surface table):
 *   authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD"
 *   design — API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as deliveryModesController from "../controllers/delivery-modes.controller";

export const deliveryModesRouter: Router = Router();

// Producer-scoped guard (same chain as products and images routes)
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// ---------------------------------------------------------------------------
// Collection routes
// ---------------------------------------------------------------------------

deliveryModesRouter.post(
  "/producers/me/delivery-modes",
  ...producerGuard,
  deliveryModesController.createDeliveryMode,
);

deliveryModesRouter.get(
  "/producers/me/delivery-modes",
  ...producerGuard,
  deliveryModesController.listDeliveryModes,
);

// ---------------------------------------------------------------------------
// Member routes
// ---------------------------------------------------------------------------

deliveryModesRouter.get(
  "/producers/me/delivery-modes/:id",
  ...producerGuard,
  deliveryModesController.getDeliveryMode,
);

deliveryModesRouter.patch(
  "/producers/me/delivery-modes/:id",
  ...producerGuard,
  deliveryModesController.updateDeliveryMode,
);

deliveryModesRouter.delete(
  "/producers/me/delivery-modes/:id",
  ...producerGuard,
  deliveryModesController.deleteDeliveryMode,
);
