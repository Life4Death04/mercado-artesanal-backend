/**
 * Public products routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET /api/v1/products       — public list (public-catalog capability)
 *   GET /api/v1/products/:id   — public detail (public-catalog capability)
 *
 * Auth chain: NONE. This file imports NO middleware — physical isolation
 * from products.routes.ts (which defines producerGuard/authenticatedGuard)
 * eliminates copy-paste leakage of a guard onto a public route. It is
 * impossible to attach a guard here without importing one first.
 *
 * Mount order: registered in the public block of api.router.ts, BEFORE
 * auth-gated routers (including productsRouter itself). There is no route
 * collision with productsRouter: that router only mounts
 * `/producers/me/products*` and `/products/:id/report`.
 *
 * Spec references:
 *   public-catalog §"PUB-R1 — Public product list"
 *   public-catalog §"PUB-R2 — Public product detail"
 *   design — Architecture Decisions: "Route file" (dedicated public router,
 *            zero-guard, mounted in public block)
 */
import { Router } from "express";

import * as productsController from "../controllers/products.controller";

export const publicProductsRouter: Router = Router();

// ---------------------------------------------------------------------------
// Public read routes — NO auth middleware
// ---------------------------------------------------------------------------

publicProductsRouter.get("/products", productsController.listPublicProducts);

publicProductsRouter.get("/products/:id", productsController.getPublicProduct);
