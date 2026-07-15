/**
 * Sub-orders controller — thin HTTP layer for producer-scoped read + transition.
 *
 * Validates request bodies/queries with Zod DTOs, extracts producerId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * sub-orders.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET    /producers/me/sub-orders        → 200 SubOrder[] (with orderLines)
 *   GET    /producers/me/sub-orders/:id    → 200 SubOrder (with orderLines)
 *   PATCH  /producers/me/sub-orders/:id    → 200 SubOrder (after transition)
 *
 * Spec references:
 *   order-fulfillment §"Producer read of own SubOrders"
 *   order-fulfillment §"State machine"
 *   order-fulfillment §"Idempotent transitions"
 *   order-fulfillment §"Tracking number deferred"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { ListSubOrdersQuerySchema, PatchSubOrderBodySchema } from "../dto/sub-orders.dto";
import * as subOrdersService from "../services/sub-orders.service";

// ---------------------------------------------------------------------------
// listSubOrders
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/sub-orders
 *
 * Returns 200 with array of own SubOrders (with orderLines).
 * Optional query: status, page, limit.
 */
export async function listSubOrders(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const query = validateBody(ListSubOrdersQuerySchema, req.query);
    const subOrders = await subOrdersService.findAll(req.user.producerId, query);

    res.status(200).json(subOrders);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getSubOrder
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/sub-orders/:id
 *
 * Returns 200 with the requested SubOrder including orderLines.
 * Returns 404 NOT_FOUND for cross-producer or missing IDs.
 */
export async function getSubOrder(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const subOrder = await subOrdersService.findById(req.user.producerId, id);

    res.status(200).json(subOrder);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// patchSubOrder
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/producers/me/sub-orders/:id
 *
 * Transitions SubOrder status via state machine. Returns 200 with updated SubOrder.
 * Returns 404 NOT_FOUND for cross-producer or missing IDs.
 * Returns 409 INVALID_ORDER_TRANSITION for invalid transitions.
 * Returns 422 VALIDATION_FAILED when body contains `trackingNumber` or unknown keys.
 *
 * Spec: order-fulfillment §"Tracking number deferred"
 * Scenario: "Attempt to set trackingNumber rejected"
 */
export async function patchSubOrder(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const body = validateBody(PatchSubOrderBodySchema, req.body);
    const subOrder = await subOrdersService.transition(req.user.producerId, id, body);

    res.status(200).json(subOrder);
  } catch (err) {
    next(err);
  }
}
