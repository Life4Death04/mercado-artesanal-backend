/**
 * Address routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET    /api/v1/users/me/addresses
 *   POST   /api/v1/users/me/addresses
 *   PATCH  /api/v1/users/me/addresses/:id
 *   DELETE /api/v1/users/me/addresses/:id
 *
 * Auth chain (design §5 — all four operations require the same chain):
 *   authenticate → loadUser → onboardingGate → requireRole(CONSUMER, PRODUCER, ADMIN) → controller
 *
 * PENDING_ROLE is blocked by onboardingGate: address routes are NOT in the
 * allow-list, so PENDING_ROLE users receive 403 ONBOARDING_REQUIRED without
 * any allow-list change needed (exploration confirmed).
 *
 * Spec references:
 *   address-book — role guard: CONSUMER | PRODUCER | ADMIN
 *   rbac — requireRole factory, onboardingGate
 *   design §5 HTTP surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as addressesController from "../controllers/addresses.controller";

export const addressesRouter: Router = Router();

const addressGuard = [authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER", "ADMIN")];

addressesRouter.get("/users/me/addresses", ...addressGuard, addressesController.list);
addressesRouter.post("/users/me/addresses", ...addressGuard, addressesController.create);
addressesRouter.patch("/users/me/addresses/:id", ...addressGuard, addressesController.update);
addressesRouter.delete("/users/me/addresses/:id", ...addressGuard, addressesController.softDelete);
