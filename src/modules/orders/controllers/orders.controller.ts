/**
 * Orders controller — thin HTTP layer for the consumer read surface (WU3).
 *
 * No request body/query validation needed here — both routes are
 * unparameterized reads (`:id` is consumed as a raw string, matching the
 * `sub-orders.controller.ts` precedent for id params). All domain errors are
 * thrown by `orders.service` and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET /pedidos      -> 200 OrderSummaryView[]
 *   GET /pedidos/:id  -> 200 OrderDetailView, 404 unknown/unowned (no-leak)
 *
 * Auth chain (mirrors cart.routes.ts / design Decision 6):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER|PRODUCER|ADMIN) -> controller
 *
 * The auth chain guarantees req.user is populated before any handler runs.
 *
 * Spec references:
 *   orders §"GET /pedidos returns owner-scoped summary history"
 *   orders §"GET /pedidos/:id returns nested detail with no-leak 404"
 *   design Decision 6 (module layout, guard chain, owner = req.user.id)
 */
import type { NextFunction, Request, Response } from "express";

import * as ordersService from "../services/orders.service";

/**
 * GET /api/v1/pedidos
 * Returns the authenticated user's own order history, newest first.
 */
export async function listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orders = await ordersService.listOrders(req.user!.id);
    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/pedidos/:id
 * Returns the nested detail for an order owned by the authenticated user.
 * Unknown or non-owned ids resolve to 404 (no-leak, never 403).
 */
export async function getOrderDetail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const order = await ordersService.getOrderDetail(req.user!.id, id);
    res.status(200).json(order);
  } catch (err) {
    next(err);
  }
}
