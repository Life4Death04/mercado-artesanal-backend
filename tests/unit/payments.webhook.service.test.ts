/**
 * Unit tests — payments module webhook event DISPATCH (Cycle 5 payments WU3,
 * strict TDD).
 *
 * WU3 scope ONLY: the `payment_intent.succeeded` / `payment_intent.payment_failed`
 * production handlers inside `dispatchWebhookEvent` (design Decision 3, spec
 * R7/R8). WU1 (intent creation) and WU2 (signature verification, the default
 * no-op dispatch branch) are OUT OF SCOPE here — see `payments.service.test.ts`
 * and the WU2 integration suite for those.
 *
 * Strategy: `handleWebhookEvent(rawBody, signature, client)` accepts an
 * injectable `StripeClient` — every test below builds a fake client whose
 * `constructEvent` returns a pre-built `StripeEvent`, so signature
 * verification itself is bypassed entirely (already proven by WU2) and only
 * the WU3 dispatch/handler logic is exercised. `@/modules/cart/services/cart.service`
 * (frozen `getCartForCheckout`), `@/modules/orders/services/orders.service`
 * (frozen `createOrderFromPayment`), and `@/shared/utils/prisma` are mocked —
 * no real Postgres or Stripe SDK call is ever made from this file.
 *
 * WU3 scenarios covered (design Decision 3, spec R7/R8):
 *   [WHU-FAILED-UPSERT] payment_intent.payment_failed -> prisma.payment.upsert
 *     keyed on providerRef, status FAILED, amount converted from cents
 *   [WHU-SUCCESS-DELETE-THEN-DELEGATE] payment_intent.succeeded -> ONE
 *     prisma.$transaction that deletes a prior FAILED Payment for the SAME
 *     providerRef BEFORE delegating to createOrderFromPayment (D3 hinge)
 *   [WHU-SUCCESS-METADATA] succeeded handler re-derives cartView via
 *     getCartForCheckout(metadata.userId) and deliverySelections via
 *     deserializeDeliverySelectionsFromMetadata(metadata.deliverySelections)
 *   [WHU-P2002-RETRY] a P2002 from the delegated write triggers exactly ONE
 *     fresh-$transaction retry (design "TDD Seams: Tx boundary")
 *   [WHU-NONP2002-BUBBLES] a non-P2002 error propagates uncaught, no retry
 *
 * Spec references:
 *   payments §"payment_intent.succeeded creates the order atomically and idempotently" (R7)
 *   payments §"payment_intent.payment_failed persists a FAILED payment and keeps the cart" (R8)
 *   design Decision 3 (FAILED->SUCCEEDED same-providerRef transition, P2002 backstop)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the frozen cart read contract — payments composes it, never edits it.
// ---------------------------------------------------------------------------
vi.mock("@/modules/cart/services/cart.service", () => ({
  getCartForCheckout: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the frozen orders write contract — payments delegates to it entirely
// for the succeeded path (design Decision 3), never reimplementing it.
// ---------------------------------------------------------------------------
vi.mock("@/modules/orders/services/orders.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/orders/services/orders.service")>();
  return {
    ...actual,
    createOrderFromPayment: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock prisma singleton — WU3 touches payment.upsert directly (FAILED path)
// and $transaction (succeeded path); the tx object passed into $transaction's
// callback is a per-test fake, not this mock.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    payment: {
      upsert: vi.fn(),
    },
  },
}));

import type { CartForCheckout } from "@/modules/cart/services/cart.service";
import { getCartForCheckout } from "@/modules/cart/services/cart.service";
import * as ordersService from "@/modules/orders/services/orders.service";
import type { OrderDetailView } from "@/modules/orders/services/orders.service";
import { prisma } from "@/shared/utils/prisma";

import { serializeDeliverySelectionsForMetadata } from "@/modules/payments/dto/payments.dto";
import * as paymentsService from "@/modules/payments/services/payments.service";
import type { StripeClient, StripeEvent } from "@/modules/payments/services/stripe.client";

const mockedGetCartForCheckout = vi.mocked(getCartForCheckout);
const mockedCreateOrderFromPayment = vi.mocked(ordersService.createOrderFromPayment);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedTransaction = vi.mocked(prisma).$transaction as any;
const mockedUpsert = vi.mocked(prisma.payment.upsert);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCartView(overrides: Partial<CartForCheckout> = {}): CartForCheckout {
  return {
    cartId: "cart_001",
    userId: "user_001",
    items: [
      {
        cartItemId: "item_001",
        productId: "product_001",
        producerId: "producer_A",
        quantity: 1,
        unitPriceSnapshot: "5.00",
        isAvailable: true,
        product: {
          id: "product_001",
          name: "Aceite de Oliva",
          stock: 10,
          isActive: true,
          producer: { id: "producer_A", isActive: true },
        },
      },
    ],
    ...overrides,
  };
}

function makeSucceededEvent(
  overrides: Partial<{ id: string; amount: number; metadata: Record<string, string> }> = {},
): StripeEvent {
  const {
    id = "pi_wh_001",
    amount = 2700,
    metadata = {
      userId: "user_001",
      cartId: "cart_001",
      deliverySelections: serializeDeliverySelectionsForMetadata([
        { producerId: "producer_A", deliveryModeId: "mode_A" },
      ]),
    },
  } = overrides;
  return { id: `evt_${id}`, type: "payment_intent.succeeded", data: { object: { id, amount, metadata } } };
}

function makeFailedEvent(overrides: Partial<{ id: string; amount: number }> = {}): StripeEvent {
  const { id = "pi_wh_fail_001", amount = 2700 } = overrides;
  return { id: `evt_${id}`, type: "payment_intent.payment_failed", data: { object: { id, amount } } };
}

/** Fake `StripeClient` whose `constructEvent` returns a pre-built event —
 * bypasses real signature verification entirely (already proven by WU2). */
function makeClient(event: StripeEvent): StripeClient {
  return {
    createPaymentIntent: vi.fn(),
    constructEvent: vi.fn().mockReturnValue(event),
  };
}

const RAW_BODY = Buffer.from("{}");
const SIGNATURE = "t=1,v1=whatever";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// payment_intent.payment_failed -> FAILED Payment upsert (spec R8)
// ---------------------------------------------------------------------------

describe("payments.service — payment_intent.payment_failed dispatch [WHU-FAILED]", () => {
  it("[WHU-FAILED-UPSERT] persists a FAILED Payment via payment.upsert keyed on providerRef, amount converted from cents", async () => {
    mockedUpsert.mockResolvedValueOnce({} as never);

    const event = makeFailedEvent({ id: "pi_fail_001", amount: 2700 });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    const call = mockedUpsert.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ providerRef: "pi_fail_001" });
    // create/update both set status FAILED — never `create` unconditionally
    // (design Decision 3: the FAILED path is upsert-only, never a bare create).
    expect(String((call?.create as { status?: unknown })?.status)).toBe("FAILED");
    expect(String((call?.update as { status?: unknown })?.status)).toBe("FAILED");
    expect(Number((call?.create as { amount?: unknown })?.amount)).toBe(27);
  });

  it("[WHU-FAILED-NO-CART-TOUCH] the FAILED path never reads the cart or calls createOrderFromPayment", async () => {
    mockedUpsert.mockResolvedValueOnce({} as never);

    const event = makeFailedEvent({ id: "pi_fail_002" });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedGetCartForCheckout).not.toHaveBeenCalled();
    expect(mockedCreateOrderFromPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// payment_intent.succeeded -> ONE $transaction: delete prior FAILED, then
// delegate entirely to the frozen createOrderFromPayment (spec R7, design D3)
// ---------------------------------------------------------------------------

describe("payments.service — payment_intent.succeeded dispatch [WHU-SUCCESS]", () => {
  it("[WHU-SUCCESS-DELETE-THEN-DELEGATE] deletes any prior FAILED Payment for the providerRef BEFORE delegating to createOrderFromPayment, inside ONE $transaction", async () => {
    const callOrder: string[] = [];
    const fakeTx = {
      payment: {
        deleteMany: vi.fn().mockImplementation(async () => {
          callOrder.push("deleteMany");
          return { count: 1 };
        }),
      },
    };
    mockedTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));
    mockedCreateOrderFromPayment.mockImplementationOnce(async () => {
      callOrder.push("createOrderFromPayment");
      return {} as OrderDetailView;
    });
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView());

    const event = makeSucceededEvent({ id: "pi_success_001" });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(callOrder).toEqual(["deleteMany", "createOrderFromPayment"]);
    expect(fakeTx.payment.deleteMany).toHaveBeenCalledWith({
      where: { providerRef: "pi_success_001", status: "FAILED" },
    });
    expect(mockedCreateOrderFromPayment).toHaveBeenCalledWith(
      "pi_success_001",
      expect.objectContaining({ cartId: "cart_001" }),
      [{ producerId: "producer_A", deliveryModeId: "mode_A" }],
      fakeTx,
    );
  });

  it("[WHU-SUCCESS-METADATA] re-derives cartView via getCartForCheckout(metadata.userId) and parses deliverySelections from metadata", async () => {
    const fakeTx = { payment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    mockedTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));
    mockedCreateOrderFromPayment.mockResolvedValueOnce({} as OrderDetailView);
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView({ userId: "user_xyz" }));

    const event = makeSucceededEvent({
      id: "pi_success_002",
      metadata: {
        userId: "user_xyz",
        cartId: "cart_xyz",
        deliverySelections: serializeDeliverySelectionsForMetadata([
          { producerId: "producer_B", deliveryModeId: "mode_B" },
        ]),
      },
    });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedGetCartForCheckout).toHaveBeenCalledWith("user_xyz");
    expect(mockedCreateOrderFromPayment).toHaveBeenCalledWith(
      "pi_success_002",
      expect.anything(),
      [{ producerId: "producer_B", deliveryModeId: "mode_B" }],
      fakeTx,
    );
  });

  it("[WHU-P2002-RETRY] retries with a FRESH $transaction exactly once when the delegated write throws a P2002 unique-constraint error", async () => {
    let attempt = 0;
    mockedTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(new Error("Unique constraint failed on providerRef"), { code: "P2002" });
      }
      return fn({ payment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } });
    });
    mockedCreateOrderFromPayment.mockResolvedValue({} as OrderDetailView);
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView());

    const event = makeSucceededEvent({ id: "pi_p2002_retry" });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedTransaction).toHaveBeenCalledTimes(2);
    expect(mockedCreateOrderFromPayment).toHaveBeenCalledTimes(1);
  });

  it("[WHU-NONP2002-BUBBLES] a non-P2002 error from the delegated write propagates uncaught, with no retry", async () => {
    mockedTransaction.mockRejectedValueOnce(new Error("db connection lost"));
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView());

    const event = makeSucceededEvent({ id: "pi_other_err" });
    await expect(
      paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event)),
    ).rejects.toThrow("db connection lost");

    expect(mockedTransaction).toHaveBeenCalledTimes(1);
  });
});
