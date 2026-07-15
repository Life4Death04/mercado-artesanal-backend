/**
 * Statistics controller — thin HTTP layer for producer sales dashboard.
 *
 * Validates query params with Zod DTOs, extracts producerId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * statistics.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET /producers/me/stats/revenue?window=<value>     → 200 { window, totalRevenue, currency, from, to }
 *   GET /producers/me/stats/order-count?window=<value> → 200 { window, count, from, to }
 *   GET /producers/me/stats/low-stock[?limit&offset]   → 200 Product[]
 *
 * Spec references:
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { LowStockQuerySchema, WindowQuerySchema } from "../dto/statistics.dto";
import * as statisticsService from "../services/statistics.service";

// ---------------------------------------------------------------------------
// getRevenue
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/stats/revenue?window=<7d|30d|90d|1y>
 *
 * Returns 200 with revenue aggregate for the window.
 * Returns 422 VALIDATION_FAILED for unknown/missing window value.
 *
 * Spec: sales-stats §"Revenue window endpoint"
 * Spec invariant: totalRevenue MUST be a decimal string
 */
export async function getRevenue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { window } = validateBody(WindowQuerySchema, req.query);
    const result = await statisticsService.getRevenue(req.user.producerId, window);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getOrderCount
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/stats/order-count?window=<7d|30d|90d|1y>
 *
 * Returns 200 with order count for the window (cancelled excluded).
 * Returns 422 VALIDATION_FAILED for unknown/missing window value.
 *
 * Spec: sales-stats §"Order count endpoint"
 * Spec scenario: "Count excludes cancelled"
 */
export async function getOrderCount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { window } = validateBody(WindowQuerySchema, req.query);
    const result = await statisticsService.getOrderCount(req.user.producerId, window);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getLowStock
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/stats/low-stock[?limit&offset]
 *
 * Returns 200 with paginated low-stock alert envelope for the producer.
 *
 * Response body (spec: sales-stats spec.md:69-72):
 *   { items: [{ productId, name, stock, lowStockThreshold }], limit, offset, total }
 *
 * Delegates to statistics.service.getLowStock which in turn delegates to
 * inventory.findLowStock (items) and inventory.findLowStockCount (total).
 *
 * Spec: sales-stats §"Low-stock alerts endpoint"
 * Spec scenario: "Returns products at or below threshold"
 */
export async function getLowStock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const pagination = validateBody(LowStockQuerySchema, req.query);
    // getLowStock now returns { items, limit, offset, total } envelope per spec:69-72
    const envelope = await statisticsService.getLowStock(req.user.producerId, pagination);

    res.status(200).json(envelope);
  } catch (err) {
    next(err);
  }
}
