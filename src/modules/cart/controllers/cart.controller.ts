/**
 * Cart controller — thin HTTP layer for cart management.
 *
 * Validates request bodies with Zod, extracts req.user.id, delegates to
 * cart.service, and serializes responses. All domain errors are thrown
 * and caught by the central errorMiddleware (RFC 7807).
 *
 * PR #2 implements: getCart, addItem (real behavior).
 * PR #3 implements: updateItem, removeItem, clearCart (real behavior).
 *
 * Response codes:
 *   GET  /carrito               → 200 CartReadView                  (PR #2)
 *   POST /carrito/items         → 201 CartItemView                  (PR #2)
 *   PATCH /carrito/items/:id    → 200 CartItemView                  (PR #3)
 *   DELETE /carrito/items/:id   → 204 No Content                    (PR #3)
 *   DELETE /carrito             → 200 CartReadView (empty items)     (PR #3)
 *
 * Auth chain (design Data Flow, verified against addresses.routes.ts:33):
 *   authenticate → loadUser → onboardingGate → requireRole(CONSUMER|PRODUCER|ADMIN) → controller
 *
 * The auth chain guarantees req.user is populated before any handler runs;
 * a missing user would surface as 401/403 upstream, so handlers do not
 * re-check it (matches judgment-day fix in PR #1 — see cart.service.ts header).
 *
 * Spec references:
 *   cart §R1–R8 — full requirement set
 *   cart §"API Contracts" — endpoint table, request DTOs, response shapes
 *   design — "File Changes" table, D1 (error taxonomy invariant), D5 (Zod 422)
 */
import type { NextFunction, Request, Response } from "express";

import { validateBody } from "@/shared/validation/zod";

import { AddItemSchema, UpdateItemSchema } from "../dto/cart.dto";
import * as cartService from "../services/cart.service";

/**
 * GET /api/v1/carrito
 * Returns cart + items + computed isAvailable for the authenticated user.
 * Returns the synthetic empty view (D2) when the user has no Cart row yet.
 */
export async function getCart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const view = await cartService.getCartView(req.user!.id);
    res.status(200).json(view);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/carrito/items
 * Adds or increments a cart item with price snapshotting.
 */
export async function addItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = validateBody(AddItemSchema, req.body);
    const item = await cartService.addItem(req.user!.id, body.productId, body.quantity);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PR #3 — real behavior for updateItem/removeItem/clearCart.
// ---------------------------------------------------------------------------

/**
 * PATCH /api/v1/carrito/items/:itemId
 * Updates quantity of a specific cart item (preserves unitPriceSnapshot).
 */
export async function updateItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { itemId } = req.params as { itemId: string };
    const body = validateBody(UpdateItemSchema, req.body);
    const item = await cartService.updateItemQuantity(req.user!.id, itemId, body.quantity);
    res.status(200).json(item);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/carrito/items/:itemId
 * Removes a single cart item (ownership-enforced).
 */
export async function removeItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { itemId } = req.params as { itemId: string };
    await cartService.removeItem(req.user!.id, itemId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/carrito
 * Clears all items but preserves the Cart row identity.
 */
export async function clearCart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const view = await cartService.clearCart(req.user!.id);
    res.status(200).json(view);
  } catch (err) {
    next(err);
  }
}
