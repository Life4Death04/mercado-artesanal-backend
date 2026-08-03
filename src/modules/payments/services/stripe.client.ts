/**
 * Stripe SDK boundary — the ONLY file in the payments module allowed to
 * import the `stripe` package (design "TDD Seams: Stripe SDK boundary").
 *
 * `payments.service.ts` depends on the `StripeClient` INTERFACE, never on
 * the concrete `stripe` package directly — this is the mock seam: unit
 * tests `vi.mock("@/modules/payments/services/stripe.client")` wholesale,
 * so no real network call to Stripe is ever made from a test.
 *
 * WU1 implements `createPaymentIntent` only. `constructEvent` (webhook
 * signature verification, design D2/D3) is deliberately NOT declared on
 * this interface yet — it is added in WU2 alongside its own RED tests, per
 * strict TDD ("do not write more code than the current failing test needs").
 *
 * Spec references:
 *   payments §"Intent amount server-side EUR" (R4)
 *   payments §"Stripe failure -> PaymentIntentCreationError 502" (R5)
 *   design — Interfaces: StripeClient.createPaymentIntent, TDD Seams
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
  /** Stripe idempotency key — payments.service passes cartView.cartId (spec R4). */
  idempotencyKey: string;
  /** Compact metadata — {userId, cartId, deliverySelections} per design D1. */
  metadata: Record<string, string>;
}

export interface CreatePaymentIntentResult {
  id: string;
  client_secret: string;
}

export interface StripeClient {
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<CreatePaymentIntentResult>;
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
}

/** Module-level singleton — callers import `stripeClient` directly. */
export const stripeClient: StripeClient = new RealStripeClient(env.STRIPE_SECRET_KEY);
