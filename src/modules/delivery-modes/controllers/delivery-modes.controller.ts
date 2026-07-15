/**
 * Delivery-modes controller — thin HTTP layer for producer-scoped CRUD.
 *
 * Validates request bodies with Zod DTOs, extracts producerId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * delivery-modes.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   POST   /producers/me/delivery-modes        → 201 DeliveryMode
 *   GET    /producers/me/delivery-modes        → 200 DeliveryMode[]
 *   GET    /producers/me/delivery-modes/:id    → 200 DeliveryMode
 *   PATCH  /producers/me/delivery-modes/:id    → 200 DeliveryMode
 *   DELETE /producers/me/delivery-modes/:id    → 204 (no body)
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import {
  CreateDeliveryModeBodySchema,
  UpdateDeliveryModeBodySchema,
} from "../dto/delivery-modes.dto";
import * as deliveryModesService from "../services/delivery-modes.service";

// ---------------------------------------------------------------------------
// createDeliveryMode
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/producers/me/delivery-modes
 *
 * Returns 201 with the created DeliveryMode.
 */
export async function createDeliveryMode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const body = validateBody(CreateDeliveryModeBodySchema, req.body);
    const dm = await deliveryModesService.create(req.user.producerId, body);

    res.status(201).json(dm);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// listDeliveryModes
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/delivery-modes
 *
 * Returns 200 with array of own delivery modes.
 */
export async function listDeliveryModes(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const dms = await deliveryModesService.findAll(req.user.producerId);

    res.status(200).json(dms);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getDeliveryMode
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/me/delivery-modes/:id
 *
 * Returns 200 with the requested DeliveryMode.
 * Returns 404 DELIVERY_MODE_NOT_FOUND for cross-producer or missing IDs.
 */
export async function getDeliveryMode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const dm = await deliveryModesService.findById(req.user.producerId, id);

    res.status(200).json(dm);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// updateDeliveryMode
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/producers/me/delivery-modes/:id
 *
 * Returns 200 with the updated DeliveryMode.
 * Returns 404 DELIVERY_MODE_NOT_FOUND for cross-producer or missing IDs.
 */
export async function updateDeliveryMode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    const body = validateBody(UpdateDeliveryModeBodySchema, req.body);
    const dm = await deliveryModesService.update(req.user.producerId, id, body);

    res.status(200).json(dm);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// deleteDeliveryMode
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/producers/me/delivery-modes/:id
 *
 * Returns 204 with no body on success.
 * Returns 404 DELIVERY_MODE_NOT_FOUND for cross-producer or missing IDs.
 * Returns 409 PRODUCER_HAS_ACTIVE_ORDERS when active SubOrders block delete.
 */
export async function deleteDeliveryMode(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id } = req.params as { id: string };
    await deliveryModesService.hardDelete(req.user.producerId, id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
