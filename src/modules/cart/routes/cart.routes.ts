/**
 * Cart routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET    /api/v1/carrito
 *   POST   /api/v1/carrito/items
 *   PATCH  /api/v1/carrito/items/:itemId
 *   DELETE /api/v1/carrito/items/:itemId
 *   DELETE /api/v1/carrito
 *
 * Auth chain (design §Data Flow — verified precedent in addresses.routes.ts:33
 * and products.routes.ts:41-46):
 *   authenticate → loadUser → onboardingGate → requireRole(CONSUMER, PRODUCER, ADMIN) → controller
 *
 * Cart is per-user via req.user.id (obs #882 operational rules).
 * Any onboarded user with a completed role may own their own cart.
 * PENDING_ROLE users are blocked by onboardingGate (403 ONBOARDING_REQUIRED).
 * Cart routes are NOT in the onboardingGate allow-list — role selection must complete first.
 *
 * Mount path: /api/v1/carrito (mounted without prefix in api.router.ts)
 *
 * Spec references:
 *   cart §R7 "All endpoints require authenticated, onboarded users with a completed role"
 *   cart §"API Contracts" — middleware chain table
 *   design — guard chain: [authenticate, loadUser, onboardingGate, requireRole("CONSUMER","PRODUCER","ADMIN")]
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as cartController from "../controllers/cart.controller";

export const cartRouter: Router = Router();

// Guard chain — matches addresses.routes.ts:33 and products.routes.ts:41-46 pattern
const cartGuard = [authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER", "ADMIN")];

// ---------------------------------------------------------------------------
// Cart routes
// ---------------------------------------------------------------------------

cartRouter.get("/carrito", ...cartGuard, cartController.getCart);
cartRouter.post("/carrito/items", ...cartGuard, cartController.addItem);
cartRouter.patch("/carrito/items/:itemId", ...cartGuard, cartController.updateItem);
cartRouter.delete("/carrito/items/:itemId", ...cartGuard, cartController.removeItem);
cartRouter.delete("/carrito", ...cartGuard, cartController.clearCart);
