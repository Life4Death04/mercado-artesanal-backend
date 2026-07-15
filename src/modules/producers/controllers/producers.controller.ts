/**
 * Producers controller — thin HTTP layer for private profile edit, soft-delete, and public projection.
 *
 * Validates request bodies with Zod DTOs, extracts producerId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * producers.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   PATCH  /producers/me     → 200 updated Producer (redacted response per spec? — returns full row)
 *   DELETE /producers/me     → 204 (no body)
 *   GET    /producers/:id    → 200 PublicProducerProjection (PUBLIC — no auth required)
 *
 * Spec references:
 *   producer-bootstrap §"Private profile edit endpoint"
 *   producer-bootstrap §"Public producer projection endpoint"
 *   producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { PatchProducerBodySchema } from "../dto/producers.dto";
import * as producersService from "../services/producers.service";

// ---------------------------------------------------------------------------
// patchProducer
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/producers/me
 *
 * Returns 200 with the updated Producer.
 * Returns 422 VALIDATION_FAILED when forbidden fields (nif, userId, etc.) are present.
 * Returns 422 UNKNOWN_CATEGORY when categorySlugs contains unknown slugs.
 */
export async function patchProducer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const body = validateBody(PatchProducerBodySchema, req.body);
    const updated = await producersService.patch(req.user.producerId, body);

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// deleteProducer
// ---------------------------------------------------------------------------

/**
 * DELETE /api/v1/producers/me
 *
 * Returns 204 with no body on successful soft-delete.
 * Returns 409 PRODUCER_HAS_ACTIVE_ORDERS when non-terminal SubOrders block the delete.
 */
export async function deleteProducer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    await producersService.softDelete(req.user.producerId);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// getPublicProducer
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/producers/:id  (PUBLIC — no auth required)
 *
 * Returns 200 with a PII-redacted public projection.
 * Returns 404 NOT_FOUND when producer does not exist or is soft-deleted.
 */
export async function getPublicProducer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const projection = await producersService.findPublicById(id);

    res.status(200).json(projection);
  } catch (err) {
    next(err);
  }
}
