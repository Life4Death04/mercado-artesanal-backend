/**
 * Users routes — read and update /users/me.
 *
 * Mounted at /api/v1 in src/app.ts, so the effective path is
 * GET/PATCH /api/v1/users/me.
 *
 * Auth chain (design §5):
 *   authenticate → loadUser → onboardingGate → controller
 *
 * No requireRole here. The onboarding gate allows PENDING_ROLE users to GET
 * their profile, but blocks PATCH until onboarding is complete.
 *
 * Spec reference: user-profile §"GET /users/me"
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";

import { getMe, updateMe } from "../controllers/users.controller";

export const usersRouter: Router = Router();

usersRouter.get("/users/me", authenticate, loadUser, onboardingGate, getMe);
usersRouter.patch("/users/me", authenticate, loadUser, onboardingGate, updateMe);
