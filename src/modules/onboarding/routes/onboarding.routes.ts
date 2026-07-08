/**
 * Onboarding routes.
 *
 * Mounted at /api/v1 in src/app.ts; effective paths are:
 *   POST /api/v1/users/me/onboarding/consumer
 *   POST /api/v1/users/me/onboarding/producer
 *
 * Auth chain (design §5):
 *   authenticate → loadUser → onboardingGate → controller
 *
 * No requireRole here — both paths are in the onboarding allow-list and
 * are only accessible to PENDING_ROLE users (gate enforces this at service level).
 *
 * Spec reference: user-onboarding §"Consumer onboarding endpoint" + §"Producer onboarding endpoint"
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";

import { consumer, producer } from "../controllers/onboarding.controller";

export const onboardingRouter: Router = Router();

onboardingRouter.post(
  "/users/me/onboarding/consumer",
  authenticate,
  loadUser,
  onboardingGate,
  consumer,
);

onboardingRouter.post(
  "/users/me/onboarding/producer",
  authenticate,
  loadUser,
  onboardingGate,
  producer,
);
