/**
 * Payments controller — thin HTTP layer for POST /pagos/intent (WU1) and
 * POST /pagos/webhook (WU2).
 *
 * `createIntent` validates the request body with Zod, extracts `req.user.id`,
 * delegates to `payments.service`, and serializes the response. `handleWebhook`
 * is UNAUTHENTICATED — it reads `req.body` as the raw `Buffer` set by the
 * route-scoped `express.raw` middleware (src/app.ts) and the `stripe-signature`
 * header, passing both untouched to `payments.service.handleWebhookEvent` for
 * verification. All domain errors are thrown and caught by the central
 * errorMiddleware (RFC 7807) — this controller never responds with an error
 * body directly.
 *
 * Response codes:
 *   POST /pagos/intent   -> 201 { clientSecret }                    (WU1)
 *   POST /pagos/webhook  -> 200 { received: true } (always on verified events,
 *                            handled or ignored); 400 WEBHOOK_SIGNATURE_INVALID
 *                            on a missing/invalid signature                (WU2)
 *
 * Auth chain (design — verified precedent in cart.routes.ts:39 / orders.routes.ts:35):
 *   authenticate -> loadUser -> onboardingGate -> requireRole(CONSUMER|PRODUCER|ADMIN) -> controller
 *
 * The auth chain guarantees req.user is populated before any handler runs;
 * a missing user would surface as 401/403 upstream, so this handler does
 * not re-check it (matches cart.controller.ts / orders.controller.ts precedent).
 * `handleWebhook` has NO auth chain — see payments.routes.ts.
 *
 * Spec references:
 *   payments §"POST /pagos/intent creates intent behind full auth chain" (R1)
 *   payments §"POST /pagos/webhook verifies the Stripe signature over the raw body" (R6)
 *   design — File Changes table, Data Flow (intent + webhook)
 */
import type { NextFunction, Request, Response } from "express";

import { validateBody } from "@/shared/validation/zod";

import * as deliveryModesService from "../../delivery-modes/services/delivery-modes.service";
import { CreatePaymentIntentSchema } from "../dto/payments.dto";
import * as paymentsService from "../services/payments.service";

/**
 * POST /api/v1/pagos/intent
 * Creates a Stripe PaymentIntent for the authenticated user's cart.
 */
export async function createIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = validateBody(CreatePaymentIntentSchema, req.body);
    const result = await paymentsService.createPaymentIntent(req.user!.id, body.deliverySelections, body.addressId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/v1/pagos/delivery-modes — active checkout options by cart producer. */
export async function getDeliveryModes(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const deliveryModes = await deliveryModesService.findActiveForCartProducers(req.user!.id);
    res.status(200).json(deliveryModes);
  } catch (err) {
    next(err);
  }
}

/** GET /api/v1/pagos/status/:paymentIntentId — owner-scoped payment polling. */
export async function getPaymentStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawPaymentIntentId = req.params["paymentIntentId"];
    const paymentIntentId = Array.isArray(rawPaymentIntentId) ? rawPaymentIntentId[0] ?? "" : rawPaymentIntentId ?? "";
    const status = await paymentsService.getPaymentStatus(req.user!.id, paymentIntentId);
    if (!status) {
      // The no-leak contract requires unknown and unowned ids to produce the
      // same bytes, including an invariant problem instance value.
      res.status(404).type("application/problem+json").json({
        type: "/errors/not-found",
        title: "Not found",
        status: 404,
        detail: "Payment not found",
        code: "NOT_FOUND",
        instance: "payment-status",
      });
      return;
    }
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/pagos/webhook
 * Unauthenticated (server-to-server) — verifies the Stripe signature over
 * the raw body and dispatches the event. Always 200 on a verified event
 * (handled or ignored); 400 WEBHOOK_SIGNATURE_INVALID on a bad/missing
 * signature; other errors (e.g. a WU3 transaction failure) are also mapped
 * by errorMiddleware (all thrown by `payments.service.handleWebhookEvent`,
 * caught below).
 */
export async function handleWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signatureHeader = req.headers["stripe-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    // Set by the route-scoped express.raw middleware (src/app.ts) — a Buffer,
    // never a parsed JSON object, for this specific path.
    const rawBody = req.body as Buffer;

    // `async`/`await` since WU3 — payments.service.handleWebhookEvent now
    // awaits DB writes (succeeded/failed handlers) for verified events.
    await paymentsService.handleWebhookEvent(rawBody, signature);
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
}
