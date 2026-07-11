/**
 * Categories controller — thin HTTP layer for public category read endpoints.
 *
 * No request body validation needed (GET-only, no write surface).
 * The slug is extracted from route params as a plain string.
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET /categories       → 200 array of active categories
 *   GET /categories/:slug → 200 category | 404 CATEGORY_NOT_FOUND
 *
 * Spec references:
 *   product-taxonomy §"Public category read endpoints"
 *   design — API surface table (public, no auth)
 */
import type { NextFunction, Request, Response } from "express";

import * as categoriesService from "../services/categories.service";

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/categories
 * Returns all active product categories sorted by name ASC.
 * Public endpoint — no authentication required.
 */
export async function listCategories(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const categories = await categoriesService.findAll();
    res.status(200).json(categories);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/categories/:slug
 * Returns a single active category by slug.
 * Public endpoint — no authentication required.
 * Throws CategoryNotFoundError (404) for unknown or inactive slugs.
 */
export async function getCategoryBySlug(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { slug } = req.params as { slug: string };
    const category = await categoriesService.findBySlug(slug);
    res.status(200).json(category);
  } catch (err) {
    next(err);
  }
}
