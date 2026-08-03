/**
 * Payments controller — thin HTTP layer for POST /pagos/intent (WU1).
 *
 * Validates the request body with Zod, extracts `req.user.id`, delegates to
 * `payments.service`, and serializes the response. All domain errors are
 * thrown and caught by the central errorMiddleware (RFC 7807) — this
 * controller never responds with an error body directly.
 *
 * Response codes:
 *   POST /pagos/intent -> 201 { clientSecret }                      (WU1)
 *
 * Auth chain (design — verified precedent in cart.routes.ts:39 / orders.routes.ts:35):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER|PRODUCER|ADMIN) -> controller
 *
 * The auth chain guarantees req.user is populated before any handler runs;
 * a missing user would surface as 401/403 upstream, so this handler does
 * not re-check it (matches cart.controller.ts / orders.controller.ts precedent).
 *
 * Spec references:
 *   payments §"POST /pagos/intent creates intent behind full auth chain" (R1)
 *   design — File Changes table, Data Flow (intent)
 */
import type { NextFunction, Request, Response } from "express";

import { validateBody } from "@/shared/validation/zod";

import { CreatePaymentIntentSchema } from "../dto/payments.dto";
import * as paymentsService from "../services/payments.service";

/**
 * POST /api/v1/pagos/intent
 * Creates a Stripe PaymentIntent for the authenticated user's cart.
 */
export async function createIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = validateBody(CreatePaymentIntentSchema, req.body);
    const result = await paymentsService.createPaymentIntent(req.user!.id, body.deliverySelections);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}
