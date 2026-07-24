/**
 * Cart controller — thin HTTP layer for cart management.
 *
 * Validates request bodies with Zod, extracts req.user.id, delegates to
 * cart.service, and serializes responses. All domain errors are thrown
 * and caught by the central errorMiddleware (RFC 7807).
 *
 * PR #1 stub policy: all handlers throw NotImplementedError (501). The
 * errorMiddleware serializes it as application/problem+json with code
 * NOT_IMPLEMENTED, keeping stubs on the canonical error envelope.
 * PR #2 will implement: getCart, addItem
 * PR #3 will implement: updateItem, removeItem, clearCart
 *
 * Response codes (target — implemented in PR #2/#3):
 *   GET  /carrito               → 200 CartReadView
 *   POST /carrito/items         → 201 CartItemView
 *   PATCH /carrito/items/:id    → 200 CartItemView
 *   DELETE /carrito/items/:id   → 204 No Content
 *   DELETE /carrito             → 200 CartReadView (empty items)
 *
 * Auth chain (design Data Flow, verified against addresses.routes.ts:33):
 *   authenticate → loadUser → onboardingGate → requireRole(CONSUMER|PRODUCER|ADMIN) → controller
 *
 * The auth chain guarantees req.user is populated before any handler runs;
 * a missing user would surface as 401/403 upstream, so handlers do not
 * re-check it.
 *
 * Spec references:
 *   cart §R1–R8 — full requirement set
 *   cart §"API Contracts" — endpoint table, request DTOs, response shapes
 *   design — "File Changes" table, D1 (error taxonomy invariant), D5 (Zod 422)
 */
import type { NextFunction, Request, Response } from "express";

import { NotImplementedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// PR #1 stubs — throw NotImplementedError (501) so the response goes through
// errorMiddleware and uses the RFC 7807 Problem Details envelope. Full
// implementations arrive in PR #2 (getCart, addItem) and PR #3 (rest).
// The middleware chain is wired NOW (in cart.routes.ts) so PR #2/#3 only
// need to fill these handlers.
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/carrito
 * Returns cart + items + computed isAvailable for the authenticated user.
 */
export async function getCart(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(PR #2): implement via cartService.getCartView(req.user.id)
    await Promise.resolve();
    throw new NotImplementedError("GET /carrito not yet implemented");
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/carrito/items
 * Adds or increments a cart item with price snapshotting.
 */
export async function addItem(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(PR #2): validate body, call cartService.addItem(req.user.id, productId, quantity)
    await Promise.resolve();
    throw new NotImplementedError("POST /carrito/items not yet implemented");
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/carrito/items/:itemId
 * Updates quantity of a specific cart item (preserves unitPriceSnapshot).
 */
export async function updateItem(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(PR #3): validate body, call cartService.updateItemQuantity(req.user.id, itemId, quantity)
    await Promise.resolve();
    throw new NotImplementedError("PATCH /carrito/items/:itemId not yet implemented");
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/carrito/items/:itemId
 * Removes a single cart item (ownership-enforced).
 */
export async function removeItem(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(PR #3): call cartService.removeItem(req.user.id, itemId)
    await Promise.resolve();
    throw new NotImplementedError("DELETE /carrito/items/:itemId not yet implemented");
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/carrito
 * Clears all items but preserves the Cart row identity.
 */
export async function clearCart(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // TODO(PR #3): call cartService.clearCart(req.user.id)
    await Promise.resolve();
    throw new NotImplementedError("DELETE /carrito not yet implemented");
  } catch (err) {
    next(err);
  }
}
