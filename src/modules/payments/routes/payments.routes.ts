/**
 * Payments routes — mounted at /api/v1 in src/modules/api.router.ts (WU1).
 *
 * Effective paths:
 *   POST /api/v1/pagos/intent
 *
 * WU2 will add the UNAUTHENTICATED `POST /pagos/webhook` route in this same
 * file (design D2 — raw-body wiring, signature-verified, no auth chain).
 * That route does NOT exist yet — do not assume it is reachable from WU1.
 *
 * Auth chain (design — verified precedent in cart.routes.ts:39 / orders.routes.ts:35):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER, PRODUCER, ADMIN) -> controller
 *
 * Owner is `req.user.id`. Any onboarded user with a completed role may
 * create a PaymentIntent for their own cart. PENDING_ROLE users are blocked
 * by onboardingGate (403 ONBOARDING_REQUIRED) — /pagos/intent is NOT in the
 * onboarding allow-list.
 *
 * Mount path: /api/v1/pagos (mounted without prefix in api.router.ts)
 *
 * Spec references:
 *   payments §"API Contracts" — middleware chain table
 *   design — guard chain: [authenticate, loadUser, onboardingGate, requireRole("CONSUMER","PRODUCER","ADMIN")]
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as paymentsController from "../controllers/payments.controller";

export const paymentsRouter: Router = Router();

// Guard chain — matches cart.routes.ts:39 / orders.routes.ts:35 pattern
const paymentsGuard = [authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER", "ADMIN")];

// ---------------------------------------------------------------------------
// Payments routes — WU1
// ---------------------------------------------------------------------------

paymentsRouter.post("/pagos/intent", ...paymentsGuard, paymentsController.createIntent);
