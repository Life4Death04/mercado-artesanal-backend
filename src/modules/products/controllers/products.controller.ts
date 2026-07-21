/**
 * Products controller — thin HTTP layer for product CRUD and reporting.
 *
 * Validates request bodies with Zod DTOs, extracts producerId/userId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * products.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   POST   /producers/me/products        → 201 created product
 *   GET    /producers/me/products        → 200 array (each product includes images[])
 *   GET    /producers/me/products/:id    → 200 product (includes images[])
 *   PATCH  /producers/me/products/:id    → 200 updated product
 *   DELETE /producers/me/products/:id    → 204 No Content
 *   POST   /products/:id/report          → 200 { productId, moderationStatus, reportedAt }
 *
 * Slice 3: listProducts and getProduct now return ProductWithImages shapes
 * (images: ProductImageResponse[]). Controller stays thin — passes service output through.
 *
 * Spec references:
 *   product-catalog  §"Publish-on-create lifecycle", §"RBAC-scoped ownership",
 *                    §"Producer product responses include images array"
 *   product-reporting §"Report endpoint"
 *   design — API surface table, Controller layer is thin, Decision #4
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import {
  CreateProductSchema,
  ReportProductSchema,
  UpdateProductSchema,
} from "../dto/products.dto";
import * as productsService from "../services/products.service";

// ---------------------------------------------------------------------------
// Producer-scoped controllers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/producers/me/products
 * Creates a new product. Published-on-create (isActive=true, moderationStatus=OK).
 * Returns 201 with the created product.
 */
export async function createProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const body = validateBody(CreateProductSchema, req.body);
    const product = await productsService.create(req.user.producerId, body);
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/producers/me/products
 * Returns all non-deleted products for the requesting producer.
 */
export async function listProducts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const products = await productsService.findAll(req.user.producerId);
    res.status(200).json(products);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/producers/me/products/:id
 * Returns a single product owned by the requesting producer.
 * 404 PRODUCT_NOT_FOUND for cross-producer access (no-leak).
 */
export async function getProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const product = await productsService.findById(req.user.producerId, id);
    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/producers/me/products/:id
 * Partially updates a product. Guards isActive→false against active orders.
 * Returns 200 with the updated product.
 */
export async function updateProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const body = validateBody(UpdateProductSchema, req.body);
    const product = await productsService.update(req.user.producerId, id, body);
    res.status(200).json(product);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/producers/me/products/:id
 * Soft-deletes a product. Blocked by non-terminal OrderLines (409).
 * Returns 204 No Content.
 */
export async function deleteProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    await productsService.softDelete(req.user.producerId, id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Authenticated (any role) controllers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/products/:id/report
 * Reports a product. Any authenticated user (consumer, producer, admin).
 * First-report-wins; subsequent reports are idempotent 200.
 * Returns 200 { productId, moderationStatus, reportedAt }.
 */
export async function reportProduct(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError("Authentication required");

    const { id } = req.params as { id: string };
    const body = validateBody(ReportProductSchema, req.body);
    const product = await productsService.report(id, body.reason);

    res.status(200).json({
      productId: product.id,
      moderationStatus: product.moderationStatus,
      reportedAt: product.reportedAt,
    });
  } catch (err) {
    next(err);
  }
}
