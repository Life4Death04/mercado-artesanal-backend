/**
 * Images routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   POST /api/v1/producers/me/products/:id/images/presign  — producer-scoped
 *   POST /api/v1/producers/me/products/:id/images/confirm  — producer-scoped
 *
 * Auth chain (per design API surface table):
 *   authenticate → loadUser → onboardingGate → requireRole('PRODUCER')
 *
 * Spec references:
 *   product-images §"Presign endpoint contract", §"Confirm endpoint contract"
 *   design — API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as imagesController from "../controllers/images.controller";

export const imagesRouter: Router = Router();

// Producer-scoped guard (same chain as products routes)
const producerGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("PRODUCER"),
];

// ---------------------------------------------------------------------------
// Presign route
// ---------------------------------------------------------------------------

imagesRouter.post(
  "/producers/me/products/:id/images/presign",
  ...producerGuard,
  imagesController.presignImage,
);

// ---------------------------------------------------------------------------
// Confirm route
// ---------------------------------------------------------------------------

imagesRouter.post(
  "/producers/me/products/:id/images/confirm",
  ...producerGuard,
  imagesController.confirmImage,
);
