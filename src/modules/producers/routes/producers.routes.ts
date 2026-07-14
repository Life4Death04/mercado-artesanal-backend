/**
 * Producers routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   PATCH  /api/v1/producers/me       — private profile edit (producer)
 *   DELETE /api/v1/producers/me       — soft-delete with guard (producer)
 *   GET    /api/v1/producers/:id      — public projection (no auth)
 *
 * Auth chain per design API surface table:
 *   PATCH + DELETE: authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *   GET /:id: PUBLIC — no auth middleware
 *
 * Mount order note: GET /producers/:id is a PUBLIC route registered BEFORE auth-gated routes
 * in api.router.ts. However, since PATCH and DELETE target /producers/me (a literal path)
 * and GET targets /producers/:id (a param path), there is no route conflict — Express
 * resolves /producers/me before /producers/:id because literal segments take priority.
 *
 * Spec references:
 *   producer-bootstrap §"Private profile edit endpoint"
 *   producer-bootstrap §"Public producer projection endpoint"
 *   producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 *   design — API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as producersController from "../controllers/producers.controller";

export const producersRouter: Router = Router();

// Producer-scoped guard (same chain as delivery-modes and sub-orders routes)
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// ---------------------------------------------------------------------------
// Public route — GET /producers/:id (no auth required)
// ---------------------------------------------------------------------------

producersRouter.get(
  "/producers/:id",
  producersController.getPublicProducer,
);

// ---------------------------------------------------------------------------
// Producer-scoped routes
// ---------------------------------------------------------------------------

producersRouter.patch(
  "/producers/me",
  ...producerGuard,
  producersController.patchProducer,
);

producersRouter.delete(
  "/producers/me",
  ...producerGuard,
  producersController.deleteProducer,
);
