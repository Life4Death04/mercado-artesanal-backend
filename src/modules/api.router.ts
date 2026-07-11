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
 *   authRouter       — POST /auth/sync
 *   usersRouter      — GET /users/me
 *   onboardingRouter — POST /users/me/onboarding/consumer|producer
 *   addressesRouter  — GET/POST/PATCH/DELETE /users/me/addresses[/:id]
 *   productsRouter   — Cycle 2: product CRUD + POST /products/:id/report
 */
import { Router } from "express";

import { addressesRouter } from "./addresses/routes/addresses.routes";
import { authRouter } from "./auth/routes/auth.routes";
import { onboardingRouter } from "./onboarding/routes/onboarding.routes";
import { productsRouter } from "./products/routes/products.routes";
import { usersRouter } from "./users/routes/users.routes";

export const apiRouter: Router = Router();

apiRouter.use(authRouter);
apiRouter.use(usersRouter);
apiRouter.use(onboardingRouter);
apiRouter.use(addressesRouter);
apiRouter.use(productsRouter);
