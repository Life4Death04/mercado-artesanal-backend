/**
 * Orders routes — mounted at /api/v1 in src/modules/api.router.ts (WU3).
 *
 * Effective paths:
 *   GET /api/v1/pedidos
 *   GET /api/v1/pedidos/:id
 *
 * Auth chain (design Decision 6 — verified precedent in cart.routes.ts:39):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER, PRODUCER, ADMIN) -> controller
 *
 * Owner is `req.user.id`. Any onboarded user with a completed role may read
 * their own orders. PENDING_ROLE users are blocked by onboardingGate (403
 * ONBOARDING_REQUIRED) — /pedidos is NOT in the onboarding allow-list.
 *
 * Mount path: /api/v1/pedidos (mounted without prefix in api.router.ts)
 *
 * Spec references:
 *   orders §"API Contracts" — middleware chain table
 *   design Decision 6 — guard chain: [authenticate, loadUser, onboardingGate, requireRole("CONSUMER","PRODUCER","ADMIN")]
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as ordersController from "../controllers/orders.controller";

export const ordersRouter: Router = Router();

// Guard chain — matches cart.routes.ts:39 pattern
const ordersGuard = [authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER", "ADMIN")];

// ---------------------------------------------------------------------------
// Orders routes
// ---------------------------------------------------------------------------

ordersRouter.get("/pedidos", ...ordersGuard, ordersController.listOrders);
ordersRouter.get("/pedidos/:id", ...ordersGuard, ordersController.getOrderDetail);
