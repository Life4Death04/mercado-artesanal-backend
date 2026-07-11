/**
 * Categories routes — public read-only endpoints for product taxonomy.
 * Mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET /api/v1/categories         — list all active categories
 *   GET /api/v1/categories/:slug   — get a single active category by slug
 *
 * Auth chain: NONE — both endpoints are fully public (no authentication required).
 *
 * WRITE SURFACE: ABSENT by design. Any POST/PATCH/DELETE on /categories
 * constitutes scope creep per spec product-taxonomy §"Invariants" and MUST be
 * rejected in review. Admin write endpoints belong to a future admin-environment cycle.
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints" — public, no auth
 *   product-taxonomy §"Invariants" — read-only in Cycle 2
 *   design — API surface table
 */
import { Router } from "express";

import * as categoriesController from "../controllers/categories.controller";

export const categoriesRouter: Router = Router();

// ---------------------------------------------------------------------------
// Public read routes — NO auth middleware
// ---------------------------------------------------------------------------

categoriesRouter.get("/categories", categoriesController.listCategories);

categoriesRouter.get("/categories/:slug", categoriesController.getCategoryBySlug);
