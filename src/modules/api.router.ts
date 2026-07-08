/**
 * Central /api/v1 router — aggregates all feature module routers.
 *
 * Mounted in src/app.ts at position 7 (design §6):
 *   app.use("/api/v1", apiRouter);
 *
 * The authenticate → loadUser → onboardingGate chain is applied per-route
 * inside each module router (NOT globally here) so the health router
 * (/health) remains completely unauthenticated.
 *
 * Module routers mounted here:
 *   authRouter      — POST /auth/sync
 *   usersRouter     — GET /users/me
 *   onboardingRouter — POST /users/me/onboarding/consumer|producer
 *
 * Future modules (addresses, admin) will be added here in later PRs.
 */
import { Router } from "express";

import { authRouter } from "./auth/routes/auth.routes";
import { onboardingRouter } from "./onboarding/routes/onboarding.routes";
import { usersRouter } from "./users/routes/users.routes";

export const apiRouter: Router = Router();

apiRouter.use(authRouter);
apiRouter.use(usersRouter);
apiRouter.use(onboardingRouter);
