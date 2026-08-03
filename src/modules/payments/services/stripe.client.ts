/**
 * Stripe SDK boundary — the ONLY file in the payments module allowed to
 * import the `stripe` package (design "TDD Seams: Stripe SDK boundary").
 *
 * `payments.service.ts` depends on the `StripeClient` INTERFACE, never on
 * the concrete `stripe` package directly — this is the mock seam: unit
 * tests `vi.mock("@/modules/payments/services/stripe.client")` wholesale,
 * so no real network call to Stripe is ever made from a test.
 *
 * WU1 implements `createPaymentIntent`. WU2 adds `constructEvent` — the
 * ONLY signature-verification point for POST /pagos/webhook (design D2,
 * spec R6, "TDD Seams: Signature verification"). `StripeEvent` is a
 * type-only shape declared here (not re-exporting the `stripe` package's
 * `Stripe.Event`) so `payments.service.ts` never needs to import the
 * concrete SDK package.
 *
 * Spec references:
 *   payments §"Intent amount server-side EUR" (R4)
 *   payments §"Stripe failure -> PaymentIntentCreationError 502" (R5)
 *   payments §"POST /pagos/webhook verifies the Stripe signature over the raw body" (R6)
 *   design — Interfaces: StripeClient.createPaymentIntent/constructEvent, TDD Seams
 */
import Stripe from "stripe";

import { env } from "@/shared/utils/env";

// ---------------------------------------------------------------------------
// Interface — the mock seam
// ---------------------------------------------------------------------------

export interface CreatePaymentIntentParams {
  /** Amount in MAJOR units (euros), e.g. 27.00 — never pre-converted to cents by callers. */
  amount: number;
  currency: "eur";
  /**
   * Stripe idempotency key — payments.service passes a sha256 content
   * fingerprint over {cartId, total, item set, deliverySelections}, NOT the
   * bare `cartView.cartId` (spec R4 supersedes the D5 bare-cartId clause;
   * review finding R1-002 — a raw cartId key would reuse a stale intent
   * after a preserved-identity cart was cleared and repopulated).
   */
  idempotencyKey: string;
  /** Compact metadata — {userId, cartId, deliverySelections} per design D1. */
  metadata: Record<string, string>;
}

export interface CreatePaymentIntentResult {
  id: string;
  client_secret: string;
}

/**
 * Minimal shape of a verified Stripe webhook event — only the fields
 * `payments.service.ts`'s event dispatch seam needs (design D3/WU3 branches
 * on `type`; WU3 will read `data.object` for `payment_intent.*` payloads).
 */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeClient {
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatePaymentIntentResult>;
  /**
   * Verifies the Stripe signature over the RAW request body and returns the
   * parsed event. This is the ONLY verification point in the module (design
   * "TDD Seams: Signature verification") — throws on a missing/invalid
   * signature; callers MUST NOT attempt to parse `rawBody` themselves.
   */
  constructEvent(rawBody: Buffer, signature: string, secret: string): StripeEvent;
}

// ---------------------------------------------------------------------------
// Money conversion — pure function, exported so it is unit-testable without
// any Stripe SDK mock (strict-tdd "Extract-Before-Mock Rule").
// ---------------------------------------------------------------------------

const CENTS_PER_EUR = 100;

/** Converts a EUR amount in major units to Stripe's integer minor-unit cents. */
export function eurosToCents(amount: number): number {
  return Math.round(amount * CENTS_PER_EUR);
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

class RealStripeClient implements StripeClient {
  private readonly sdk: Stripe;

  constructor(secretKey: string) {
    // Explicit timeout + retry bounds — without them, an unresponsive Stripe
    // endpoint can hang the request for ~241s (SDK default backoff ceiling).
    this.sdk = new Stripe(secretKey, { timeout: 20000, maxNetworkRetries: 2 });
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatePaymentIntentResult> {
    const intent = await this.sdk.paymentIntents.create(
      {
        amount: eurosToCents(params.amount),
        currency: params.currency,
        automatic_payment_methods: { enabled: true },
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );

    if (!intent.client_secret) {
      // Defensive — the Stripe API contract guarantees client_secret on create,
      // but never trust a third-party SDK response shape unconditionally.
      throw new Error("Stripe PaymentIntent response is missing client_secret");
    }

    return { id: intent.id, client_secret: intent.client_secret };
  }

  constructEvent(rawBody: Buffer, signature: string, secret: string): StripeEvent {
    // Throws Stripe.errors.StripeSignatureVerificationError on a bad/missing
    // signature — callers (payments.service.ts) wrap this in
    // WebhookSignatureError; the raw Stripe error is never leaked to the wire.
    const event = this.sdk.webhooks.constructEvent(rawBody, signature, secret);
    return {
      id: event.id,
      type: event.type,
      data: event.data as unknown as { object: Record<string, unknown> },
    };
  }
}

/** Module-level singleton — callers import `stripeClient` directly. */
export const stripeClient: StripeClient = new RealStripeClient(env.STRIPE_SECRET_KEY);
