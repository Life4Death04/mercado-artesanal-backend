/**
 * Categories routes — PUBLIC, anonymous, read-only endpoints for product
 * taxonomy. Mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET /api/v1/categories         — list all active categories
 *   GET /api/v1/categories/:slug   — get a single active category by slug
 *
 * Auth chain: NONE — both endpoints are fully public (no authentication
 * required) and remain unauthenticated after admin-catalog-control
 * (product-taxonomy §"Public category read endpoints", amended: "Both
 * endpoints MUST remain unauthenticated. Authenticated administrators MAY
 * manage categories only through the admin catalog surface.").
 *
 * WRITE SURFACE: ABSENT here BY DESIGN, and it stays absent — this router is
 * PUBLIC-ONLY. Any POST/PATCH/DELETE added to THIS FILE constitutes scope
 * creep and MUST be rejected in review. Category create/update/deactivate
 * ship in `src/modules/admin/` (admin-catalog-control WU3), which composes
 * `categoriesService.{create,update,deactivate,findAllAdmin}` behind the
 * `/admin/*` ADMIN guard — never behind this public router. This router's
 * `findAll`/`findBySlug` delegation is intentionally unchanged by that work.
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints" — public, no auth
 *   admin-catalog    §"Category administration" — admin writes live in /admin/*
 *   design — API surface table; Decision "Mutable vs stable category slug"
 */
import { Router } from "express";

import * as categoriesController from "../controllers/categories.controller";

export const categoriesRouter: Router = Router();

// ---------------------------------------------------------------------------
// Public read routes — NO auth middleware
// ---------------------------------------------------------------------------

categoriesRouter.get("/categories", categoriesController.listCategories);

categoriesRouter.get("/categories/:slug", categoriesController.getCategoryBySlug);
