/**
 * Payments routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   POST /api/v1/pagos/intent    — auth chain (WU1)
 *   POST /api/v1/pagos/webhook   — UNAUTHENTICATED (WU2)
 *
 * Auth chain (design — verified precedent in cart.routes.ts:39 / orders.routes.ts:35):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER, PRODUCER, ADMIN) -> controller
 *
 * Owner is `req.user.id`. Any onboarded user with a completed role may
 * create a PaymentIntent for their own cart. PENDING_ROLE users are blocked
 * by onboardingGate (403 ONBOARDING_REQUIRED) — /pagos/intent is NOT in the
 * onboarding allow-list.
 *
 * `/pagos/webhook` carries NO middleware from the guard chain above — it is
 * authorized SOLELY by Stripe signature verification over the raw body
 * (design Decision 2, spec R6). Its raw-body parsing is wired at the app
 * level (src/app.ts), not here — this router only wires the path to its
 * unauthenticated controller.
 *
 * Mount path: /api/v1/pagos (mounted without prefix in api.router.ts)
 *
 * Spec references:
 *   payments §"API Contracts" — middleware chain table
 *   design — guard chain: [authenticate, loadUser, onboardingGate, requireRole("CONSUMER","PRODUCER","ADMIN")]
 *   design Decision 2 — raw body for webhook vs global express.json
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as paymentsController from "../controllers/payments.controller";

export const paymentsRouter: Router = Router();

// Guard chain — matches cart.routes.ts:39 / orders.routes.ts:39 pattern
const paymentsGuard = [authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER", "ADMIN")];

// ---------------------------------------------------------------------------
// Payments routes — WU1
// ---------------------------------------------------------------------------

paymentsRouter.post("/pagos/intent", ...paymentsGuard, paymentsController.createIntent);
paymentsRouter.get("/pagos/delivery-modes", ...paymentsGuard, paymentsController.getDeliveryModes);

// ---------------------------------------------------------------------------
// Payments routes — WU2 (unauthenticated — see file header)
// ---------------------------------------------------------------------------

paymentsRouter.post("/pagos/webhook", paymentsController.handleWebhook);
