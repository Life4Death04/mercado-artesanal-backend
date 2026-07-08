/**
 * Users routes — GET /users/me.
 *
 * Mounted at /api/v1 in src/app.ts, so the effective path is
 * GET /api/v1/users/me.
 *
 * Auth chain (design §5):
 *   authenticate → loadUser → onboardingGate → controller
 *
 * No requireRole here — /users/me is allow-listed for PENDING_ROLE users
 * (they can read their own profile at any time).
 *
 * Spec reference: user-profile §"GET /users/me"
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";

import { getMe } from "../controllers/users.controller";

export const usersRouter: Router = Router();

usersRouter.get("/users/me", authenticate, loadUser, onboardingGate, getMe);
