/**
 * Images controller — thin HTTP layer for presign and confirm endpoints.
 *
 * Validates request bodies with Zod DTOs, extracts producerId from
 * req.user (populated by loadUser Cycle 2 extension), delegates to
 * images.service, and serializes responses.
 *
 * All domain errors are thrown and caught by the central errorMiddleware.
 *
 * Response codes:
 *   POST /producers/me/products/:id/images/presign  → 200 { uploadUrl, s3Key, expiresIn }
 *   POST /producers/me/products/:id/images/confirm  → 201 ProductImage row
 *
 * Spec references:
 *   product-images §"Presign endpoint contract", §"Confirm endpoint contract"
 *   design — API surface table, Controller layer is thin
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { ConfirmBodySchema, PresignBodySchema } from "../dto/images.dto";
import * as imagesService from "../services/images.service";

// ---------------------------------------------------------------------------
// presignImage
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/producers/me/products/:id/images/presign
 *
 * Returns 200 with { uploadUrl, s3Key, expiresIn }.
 * Does NOT insert any DB row.
 *
 * Spec: product-images §"Presign endpoint contract"
 */
export async function presignImage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id: productId } = req.params as { id: string };
    const body = validateBody(PresignBodySchema, req.body);

    const result = await imagesService.presign(req.user.producerId, productId, {
      mimeType: body.mimeType,
      contentLength: body.contentLength,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// confirmImage
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/producers/me/products/:id/images/confirm
 *
 * Returns 201 with the new ProductImage row on success.
 *
 * Spec: product-images §"Confirm endpoint contract"
 */
export async function confirmImage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user?.producerId) throw new UnauthorizedError("Producer not found for this user");

    const { id: productId } = req.params as { id: string };
    const body = validateBody(ConfirmBodySchema, req.body);

    const productImage = await imagesService.confirm(req.user.producerId, productId, {
      s3Key: body.s3Key,
      mimeType: body.mimeType,
      position: body.position,
    });

    res.status(201).json(productImage);
  } catch (err) {
    next(err);
  }
}
