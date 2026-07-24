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
 *   producersRouter      — Cycle 2: PATCH /producers/me, DELETE /producers/me (producer);
 *                          GET /producers/:id (PUBLIC — no auth)
 *   authRouter           — POST /auth/sync
 *   usersRouter          — GET /users/me
 *   onboardingRouter     — POST /users/me/onboarding/consumer|producer
 *   addressesRouter      — GET/POST/PATCH/DELETE /users/me/addresses[/:id]
 *   productsRouter       — Cycle 2: product CRUD + POST /products/:id/report
 *   imagesRouter         — Cycle 2: presign + confirm under /producers/me/products/:id/images/*
 *   deliveryModesRouter  — Cycle 2: producer-scoped CRUD under /producers/me/delivery-modes[/:id]
 *   subOrdersRouter      — Cycle 2: producer-scoped read + state-machine PATCH under /producers/me/sub-orders[/:id]
 *   statisticsRouter     — Cycle 2: GET /producers/me/stats/{revenue,order-count,low-stock} (producer)
 *   cartRouter           — Cycle 3: consumer cart CRUD under /carrito (cart-foundation PR #1)
 *
 * Mount order: public routers (categoriesRouter, producersRouter GET /:id) are registered
 * BEFORE auth-gated routers so they are reachable without any auth header.
 * Note on producersRouter: it registers both public (GET /producers/:id) and producer-scoped
 * (PATCH /producers/me, DELETE /producers/me) routes. Express resolves /producers/me before
 * /producers/:id because literal segments take priority over param segments.
 */
import { Router } from "express";

import { addressesRouter } from "./addresses/routes/addresses.routes";
import { authRouter } from "./auth/routes/auth.routes";
import { cartRouter } from "./cart/routes/cart.routes";
import { categoriesRouter } from "./categories/routes/categories.routes";
import { deliveryModesRouter } from "./delivery-modes/routes/delivery-modes.routes";
import { imagesRouter } from "./images/routes/images.routes";
import { onboardingRouter } from "./onboarding/routes/onboarding.routes";
import { producersRouter } from "./producers/routes/producers.routes";
import { productsRouter } from "./products/routes/products.routes";
import { statisticsRouter } from "./statistics/routes/statistics.routes";
import { subOrdersRouter } from "./sub-orders/routes/sub-orders.routes";
import { usersRouter } from "./users/routes/users.routes";

export const apiRouter: Router = Router();

// Public routes — no auth required
// producersRouter is registered here because GET /producers/:id is public;
// the PATCH and DELETE /producers/me routes inside it carry their own producerGuard.
apiRouter.use(categoriesRouter);
apiRouter.use(producersRouter);

// Auth-gated routes
apiRouter.use(authRouter);
apiRouter.use(usersRouter);
apiRouter.use(onboardingRouter);
apiRouter.use(addressesRouter);
apiRouter.use(productsRouter);
apiRouter.use(imagesRouter);
apiRouter.use(deliveryModesRouter);
apiRouter.use(subOrdersRouter);
apiRouter.use(statisticsRouter);
apiRouter.use(cartRouter);
