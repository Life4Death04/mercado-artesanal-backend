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
 *   categoriesRouter     — Cycle 2: GET /categories, GET /categories/:slug (PUBLIC — no auth)
 *   authRouter           — POST /auth/sync
 *   usersRouter          — GET /users/me
 *   onboardingRouter     — POST /users/me/onboarding/consumer|producer
 *   addressesRouter      — GET/POST/PATCH/DELETE /users/me/addresses[/:id]
 *   productsRouter       — Cycle 2: product CRUD + POST /products/:id/report
 *   imagesRouter         — Cycle 2: presign + confirm under /producers/me/products/:id/images/*
 *   deliveryModesRouter  — Cycle 2: producer-scoped CRUD under /producers/me/delivery-modes[/:id]
 *   subOrdersRouter      — Cycle 2: producer-scoped read + state-machine PATCH under /producers/me/sub-orders[/:id]
 *
 * Mount order: public routers (categoriesRouter) are registered BEFORE
 * auth-gated routers so they are reachable without any auth header.
 */
import { Router } from "express";

import { addressesRouter } from "./addresses/routes/addresses.routes";
import { authRouter } from "./auth/routes/auth.routes";
import { categoriesRouter } from "./categories/routes/categories.routes";
import { deliveryModesRouter } from "./delivery-modes/routes/delivery-modes.routes";
import { imagesRouter } from "./images/routes/images.routes";
import { onboardingRouter } from "./onboarding/routes/onboarding.routes";
import { productsRouter } from "./products/routes/products.routes";
import { subOrdersRouter } from "./sub-orders/routes/sub-orders.routes";
import { usersRouter } from "./users/routes/users.routes";

export const apiRouter: Router = Router();

// Public routes — no auth required
apiRouter.use(categoriesRouter);

// Auth-gated routes
apiRouter.use(authRouter);
apiRouter.use(usersRouter);
apiRouter.use(onboardingRouter);
apiRouter.use(addressesRouter);
apiRouter.use(productsRouter);
apiRouter.use(imagesRouter);
apiRouter.use(deliveryModesRouter);
apiRouter.use(subOrdersRouter);
