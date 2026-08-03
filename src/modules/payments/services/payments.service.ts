/**
 * Payments service — WU1 (Payment Intent creation) + WU2 (webhook signature
 * verification and event-dispatch seam).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as paymentsService from "@/modules/payments/services/payments.service"`.
 *
 * `createPaymentIntent` COMPOSES the frozen `getCartForCheckout(userId)`
 * read contract (cart slice) — it never edits `cart` or `orders`. It does
 * NOT open a Prisma transaction and does NOT write any local state; the
 * only side effect is the Stripe PaymentIntent creation call itself.
 *
 * Step order (design D1/D4-analog for intent creation, spec R1-R5):
 *   1. `getCartForCheckout(userId)` — 404 no cart (frozen contract throw).
 *   2. Reject an empty cart -> `EmptyCartCheckoutError` (422).
 *   3. Resolve + validate `deliverySelections` against the cart's producer
 *      set: bijection (exactly one selection per cart producerId), FK match
 *      (deliveryModeId belongs to producerId), and `isActive` -> otherwise
 *      `ValidationFailedError` (422). Validation sources EXCLUSIVELY from the
 *      resolved `DeliveryMode` rows, never the bare input (matches the
 *      orders slice's own re-validation pattern at webhook time).
 *   4. Hard stock gate, all-or-nothing: `item.quantity > item.product.stock`
 *      on ANY item -> `InsufficientStockError` (409). `product.stock` here
 *      is already LIVE — `getCartForCheckout` issues a fresh Prisma query on
 *      every call, so no separate stock query is needed.
 *   5. Compute the EUR total EXCLUSIVELY server-side with `Prisma.Decimal`:
 *      Σ(unitPriceSnapshot * quantity) + Σ(per-producer DeliveryMode.cost).
 *      No client-supplied amount is ever read (spec R4 "client amount ignored").
 *   6. Serialize the D1 compact metadata guard
 *      (`serializeDeliverySelectionsForMetadata`) — may itself throw
 *      `ValidationFailedError` (422) before any Stripe call.
 *   7. Call `stripeClient.createPaymentIntent` with `idempotencyKey` set to
 *      a sha256 content fingerprint of {cartId, total, item set, delivery
 *      selections} (spec R4 "same checkout content reuses idempotency key")
 *      — a rejection is wrapped as `PaymentIntentCreationError` (502), never
 *      leaking the raw Stripe error.
 *
 * Spec references:
 *   payments §"POST /pagos/intent creates intent behind full auth chain" (R1)
 *   payments §"Intent validates delivery selections" (R2)
 *   payments §"Intent hard stock gate" (R3)
 *   payments §"Intent amount server-side EUR" (R4)
 *   payments §"Stripe failure -> PaymentIntentCreationError 502" (R5)
 *   design D1 (deliverySelections carry-through / metadata guard)
 */
import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { Prisma as PrismaValue } from "@prisma/client";

import { getCartForCheckout } from "@/modules/cart/services/cart.service";
import type { DeliverySelection } from "@/modules/orders/services/orders.service";
import {
  CartItemNotAvailableError,
  EmptyCartCheckoutError,
  InsufficientStockError,
  PaymentIntentCreationError,
  ValidationFailedError,
  WebhookSignatureError,
} from "@/shared/errors/errors";
import { env } from "@/shared/utils/env";
import { prisma } from "@/shared/utils/prisma";

import { serializeDeliverySelectionsForMetadata } from "../dto/payments.dto";

import { stripeClient } from "./stripe.client";
import type { StripeClient, StripeEvent } from "./stripe.client";

type DecimalValue = InstanceType<typeof PrismaValue.Decimal>;
type DeliveryModeRow = { id: string; producerId: string; isActive: boolean; cost: Prisma.Decimal };

export interface PaymentIntentResult {
  clientSecret: string;
}

/**
 * Creates a Stripe PaymentIntent for the caller's cart, behind the full
 * auth chain (enforced at the route level — see payments.routes.ts).
 *
 * @param userId - `req.user.id`; owner of the cart being checked out.
 * @param deliverySelections - validated request body shape (Zod-checked by
 *   the controller); bijection/ownership/isActive are re-validated here
 *   against LIVE `DeliveryMode` rows.
 * @param client - injectable `StripeClient` (defaults to the module
 *   singleton); tests supply a mock via the `@/modules/payments/services/stripe.client`
 *   module mock rather than this parameter, but the parameter keeps the
 *   function callable in isolation without a global mock if ever needed.
 */
export async function createPaymentIntent(
  userId: string,
  deliverySelections: DeliverySelection[],
  client: StripeClient = stripeClient,
): Promise<PaymentIntentResult> {
  // Step 1: frozen read contract — 404 no cart (NotFoundError thrown by cart.service).
  const cartView = await getCartForCheckout(userId);

  // Step 2: reject an empty cart.
  if (cartView.items.length === 0) {
    throw new EmptyCartCheckoutError("Cannot create a payment intent for an empty cart");
  }

  // Step 3: resolve + validate deliverySelections against the cart's producer set.
  const cartProducerIds = new Set(cartView.items.map((item) => item.producerId));
  const selectedModeIds = deliverySelections.map((selection) => selection.deliveryModeId);
  const selectedModes: DeliveryModeRow[] =
    selectedModeIds.length > 0
      ? await prisma.deliveryMode.findMany({ where: { id: { in: selectedModeIds } } })
      : [];
  const modesById = new Map(selectedModes.map((mode) => [mode.id, mode]));

  const deliveryModeByProducer = new Map<string, string>();
  const shippingByProducer = new Map<string, DecimalValue>();

  for (const selection of deliverySelections) {
    if (!cartProducerIds.has(selection.producerId)) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: `Unknown producerId: ${selection.producerId}` }],
        "Invalid delivery selections",
      );
    }
    if (deliveryModeByProducer.has(selection.producerId)) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: `Duplicate producerId: ${selection.producerId}` }],
        "Invalid delivery selections",
      );
    }

    const mode = modesById.get(selection.deliveryModeId);
    if (!mode) {
      throw new ValidationFailedError(
        [
          {
            path: "deliverySelections",
            message: `Unknown deliveryModeId: ${selection.deliveryModeId}`,
          },
        ],
        "Invalid delivery selections",
      );
    }
    if (mode.producerId !== selection.producerId) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: "deliveryModeId does not belong to producerId" }],
        "Invalid delivery selections",
      );
    }
    if (!mode.isActive) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: "deliveryMode is not active" }],
        "Invalid delivery selections",
      );
    }

    deliveryModeByProducer.set(selection.producerId, mode.id);
    shippingByProducer.set(selection.producerId, mode.cost);
  }

  // Bijection completeness — every cart producerId MUST have exactly one selection.
  if (deliveryModeByProducer.size !== cartProducerIds.size) {
    throw new ValidationFailedError(
      [
        {
          path: "deliverySelections",
          message: "Missing a deliverySelection for one or more cart producers",
        },
      ],
      "Invalid delivery selections",
    );
  }

  // Step 3b: availability gate, all-or-nothing (mirrors orders.service.ts's
  // base checkout guard) — a soft-deleted/inactive/producer-deleted product
  // must never be charged, even if its stock snapshot still looks sufficient.
  if (cartView.items.some((item) => !item.isAvailable)) {
    throw new CartItemNotAvailableError("One or more cart items are no longer available");
  }

  // Step 4: hard stock gate, all-or-nothing. `product.stock` is already LIVE
  // (getCartForCheckout issues a fresh query per call) — no second query needed.
  const hasShortfall = cartView.items.some((item) => item.quantity > item.product.stock);
  if (hasShortfall) {
    throw new InsufficientStockError("One or more items exceed available stock");
  }

  // Step 5: server-side EUR total — client-supplied amounts are never read.
  let total = new PrismaValue.Decimal(0);
  for (const item of cartView.items) {
    total = total.plus(new PrismaValue.Decimal(item.unitPriceSnapshot).times(item.quantity));
  }
  for (const producerId of cartProducerIds) {
    total = total.plus(shippingByProducer.get(producerId)!);
  }

  // Step 6: D1 compact metadata guard — may throw ValidationFailedError before any Stripe call.
  const deliverySelectionsMetadata = serializeDeliverySelectionsForMetadata(deliverySelections);

  // Step 6b: idempotency key = a content fingerprint, NOT the bare cartId.
  // Cart identity is preserved across clear/repopulate (cart.service.ts
  // clear-then-repopulate flow), so a raw cartId key would make a CHANGED
  // checkout reuse a stale prior intent's client_secret. A sha256 digest over
  // {cartId, total, sorted item set, deliverySelections} is deterministic: a
  // genuine retry of the SAME content reuses the key (Stripe dedupes
  // correctly); any change in items/amount/delivery yields a new key.
  const itemFingerprint = cartView.items
    .map((item) => `${item.productId}:${item.quantity}`)
    .sort()
    .join(",");
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        cartId: cartView.cartId,
        total: total.toString(),
        items: itemFingerprint,
        deliverySelections: deliverySelectionsMetadata,
      }),
    )
    .digest("hex");

  // Step 7: Stripe call — idempotencyKey = content fingerprint, failure -> 502, never leaked raw.
  try {
    const intent = await client.createPaymentIntent({
      amount: total.toNumber(),
      currency: "eur",
      idempotencyKey,
      metadata: {
        userId,
        cartId: cartView.cartId,
        deliverySelections: deliverySelectionsMetadata,
      },
    });
    return { clientSecret: intent.client_secret };
  } catch (err) {
    throw new PaymentIntentCreationError("Failed to create payment intent", err);
  }
}

// ===========================================================================
// WU2 — Webhook Trust Boundary (spec R6, R9; design Decision 2, TDD Seams)
//
// `verifyWebhookSignature` is the ONLY place in the codebase that reads the
// `stripe-signature` header value and calls `client.constructEvent`. The
// controller (payments.controller.ts) passes through the raw `Buffer` body
// (set by the route-scoped `express.raw` middleware in src/app.ts) and the
// header value untouched — it does not parse or inspect either.
// ===========================================================================

/**
 * Verifies a Stripe webhook signature over the RAW request body and returns
 * the parsed event.
 *
 * @throws {WebhookSignatureError} when the signature header is missing, or
 *   when `client.constructEvent` rejects it (invalid/expired HMAC). Neither
 *   branch performs any DB read/write — this function runs strictly BEFORE
 *   `dispatchWebhookEvent`, so a rejection here writes zero local state
 *   (spec "Invalid signature is rejected before any processing").
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  client: StripeClient = stripeClient,
): StripeEvent {
  if (!signature) {
    throw new WebhookSignatureError("Missing Stripe signature header");
  }

  try {
    return client.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw new WebhookSignatureError("Invalid Stripe webhook signature", err);
  }
}

/**
 * Event dispatch seam (design "TDD Seams: Tx boundary" + REFACTOR task 2.3).
 *
 * WU2 wires the signature-verification boundary and the routing seam ONLY —
 * no `case` here performs a production write yet, so EVERY verified event
 * type reaches `default` and is a no-op (spec "Unhandled webhook event types
 * are ignored"). WU3 adds `case "payment_intent.succeeded"` (delegates to
 * the frozen `createOrderFromPayment` inside one `$transaction`, design
 * Decision 3) and `case "payment_intent.payment_failed"` (FAILED
 * `payment.upsert`) here, WITHOUT touching `verifyWebhookSignature` above.
 */
function dispatchWebhookEvent(event: StripeEvent): void {
  switch (event.type) {
    default:
      return;
  }
}

/**
 * Entry point for `POST /pagos/webhook` (design Decision 2, spec R6).
 * Verifies the signature over the raw body, then dispatches by event type.
 * Rejection paths (missing/invalid signature) throw BEFORE any dispatch —
 * see `verifyWebhookSignature` for the zero-write guarantee.
 *
 * Not `async` yet — neither `verifyWebhookSignature` nor `dispatchWebhookEvent`
 * awaits anything in WU2. WU3 makes `dispatchWebhookEvent` async (it opens a
 * `prisma.$transaction` for the succeeded/failed cases) and this function
 * will need `async`/`await` again at that point; the controller already
 * `await`s this call, so that change is transparent to callers.
 */
export function handleWebhookEvent(
  rawBody: Buffer,
  signature: string | undefined,
  client: StripeClient = stripeClient,
): void {
  const event = verifyWebhookSignature(rawBody, signature, client);
  dispatchWebhookEvent(event);
}
