/**
 * Admin controller — thin HTTP layer for `/admin/*` catalog moderation and
 * category management.
 *
 * Validates request bodies/queries with Zod DTOs, extracts the admin user id
 * from req.user (populated by loadUser; guaranteed present here since every
 * route in this module runs behind requireRole("ADMIN")), and delegates all
 * business rules to the existing products/categories services — this
 * controller adds no new domain logic.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET    /admin/products                       → 200 AdminProductProjection[]
 *   GET    /admin/products/:id                    → 200 AdminProductProjection
 *   PATCH  /admin/products/:id/moderation         → 200 Product
 *   GET    /admin/categories                      → 200 AdminCategoryProjection[]
 *   POST   /admin/categories                      → 201 Category
 *   PATCH  /admin/categories/:id                  → 200 Category
 *   DELETE /admin/categories/:id                  → 204 (no body)
 *
 * Spec references:
 *   admin-catalog §"Moderation queue and detail"
 *   admin-catalog §"Reversible audited moderation"
 *   admin-catalog §"Category administration"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import * as categoriesService from "../../categories/services/categories.service";
import * as productsService from "../../products/services/products.service";
import {
  CreateCategoryBodySchema,
  ModerationBodySchema,
  ModerationQueueQuerySchema,
  UpdateCategoryBodySchema,
} from "../dto/admin.dto";

/**
 * Every handler in this module runs behind requireRole("ADMIN") — req.user
 * is guaranteed non-null there. This guard is defensive-only (mirrors the
 * `!req.user?.producerId` pattern used across other admin/producer
 * controllers) and should never trigger in production.
 */
function requireAdminId(req: Request): string {
  if (!req.user) throw new UnauthorizedError("Admin user not found for this request");
  return req.user.id;
}

// ---------------------------------------------------------------------------
// getModerationQueue
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/products?moderationStatus=<OK|REPORTED|REMOVED>
 *
 * Returns 200 with the queue filtered to the requested moderation status.
 *
 * Spec: admin-catalog §"Reported queue is filtered".
 */
export async function getModerationQueue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { moderationStatus } = validateBody(ModerationQueueQuerySchema, req.query);
    const queue = await productsService.findModerationQueue(moderationStatus);

    res.status(200).json(queue);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getProductDetail
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/products/:id
 *
 * Returns 200 with the admin moderation/detail projection.
 * Returns 404 PRODUCT_NOT_FOUND for missing or soft-deleted products.
 *
 * Spec: admin-catalog §"Moderation queue and detail".
 */
export async function getProductDetail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const product = await productsService.findAdminProductById(id);

    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// moderateProduct
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/admin/products/:id/moderation
 * body { action: "remove" | "dismiss" | "restore", reason: string }
 *
 * Returns 200 with the updated product on an allowed transition.
 * Returns 409 INVALID_MODERATION_TRANSITION when the action does not match
 * the product's current state (action-table rejection or a raced write).
 *
 * Spec: admin-catalog §"Reversible audited moderation".
 */
export async function moderateProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = requireAdminId(req);

    const { id } = req.params as { id: string };
    const { action, reason } = validateBody(ModerationBodySchema, req.body);
    const product = await productsService.moderate(id, adminId, action, reason);

    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// listCategories
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/admin/categories
 *
 * Returns 200 with every category (including inactive rows), each annotated
 * with `productCount` filtered to active, non-deleted products.
 *
 * Spec: admin-catalog §"Category administration".
 */
export async function listCategories(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const categories = await categoriesService.findAllAdmin();

    res.status(200).json(categories);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// createCategory
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/admin/categories
 * body { name: string, description?: string }
 *
 * Returns 201 with the created category. Slug is auto-derived from `name`.
 * Returns 409 CATEGORY_SLUG_CONFLICT when the derived slug collides.
 *
 * Spec: admin-catalog §"Category lifecycle succeeds", §"Generated slug collision".
 */
export async function createCategory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const body = validateBody(CreateCategoryBodySchema, req.body);
    const category = await categoriesService.create(body);

    res.status(201).json(category);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// updateCategory
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/admin/categories/:id
 * body { name?: string, description?: string | null, isActive?: boolean }
 *
 * Returns 200 with the updated category. `slug` is never accepted or
 * regenerated here (design — Decision "Mutable vs stable category slug").
 * Returns 404 CATEGORY_NOT_FOUND for a missing category.
 *
 * Spec: admin-catalog §"Category administration".
 */
export async function updateCategory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const body = validateBody(UpdateCategoryBodySchema, req.body);
    const category = await categoriesService.update(id, body);

    res.status(200).json(category);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// deactivateCategory
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/admin/categories/:id
 *
 * Returns 204 with no body on success. This is a REVERSIBLE
 * soft-deactivation (`isActive=false`), never a hard delete — product
 * references remain unchanged and public reads exclude the category.
 * Returns 404 CATEGORY_NOT_FOUND for a missing category.
 *
 * Spec: admin-catalog §"Soft-deleted category leaves public taxonomy".
 */
export async function deactivateCategory(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    await categoriesService.deactivate(id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
