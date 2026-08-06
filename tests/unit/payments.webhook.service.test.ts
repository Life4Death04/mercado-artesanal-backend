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
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    deliveryMode: {
      findMany: vi.fn(),
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
const mockedFindUnique = vi.mocked(prisma.payment.findUnique);
const mockedUpdateMany = vi.mocked(prisma.payment.updateMany);
const mockedCreate = vi.mocked(prisma.payment.create);
const mockedDeliveryModeFindMany = vi.mocked(prisma.deliveryMode.findMany);

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
    // 700 cents = EUR 7.00 = default `makeCartView` item (5.00) + default
    // `deliveryMode.findMany` mock cost (2.00) — matches the Bug 2
    // reconciliation guard's recomputed total so existing dispatch tests
    // stay green without individually mocking the guard per test.
    amount = 700,
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
  // Default: no existing Payment row, and a resolvable producer_A/mode_A
  // DeliveryMode (cost 2.00) — matches the default `makeCartView`/
  // `makeSucceededEvent` fixtures so the Bug 2 reconciliation guard passes
  // by default without every succeeded-path test re-mocking it.
  mockedFindUnique.mockResolvedValue(null);
  mockedDeliveryModeFindMany.mockResolvedValue([
    { id: "mode_A", producerId: "producer_A", isActive: true, cost: 2.0 },
  ] as never);
});

// ---------------------------------------------------------------------------
// payment_intent.payment_failed -> FAILED Payment via updateMany/create,
// NEVER downgrading a SUCCEEDED row (spec R8; Bug 1 fix — WU3 rework)
// ---------------------------------------------------------------------------

describe("payments.service — payment_intent.payment_failed dispatch [WHU-FAILED]", () => {
  it("[WHU-FAILED-CREATE] first failure for a providerRef with no existing Payment -> creates a FAILED row, amount converted from cents", async () => {
    mockedUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockedFindUnique.mockResolvedValueOnce(null);
    mockedCreate.mockResolvedValueOnce({} as never);

    const event = makeFailedEvent({ id: "pi_fail_001", amount: 2700 });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { providerRef: "pi_fail_001", status: { notIn: ["SUCCEEDED", "CANCELED"] } },
      data: { status: "FAILED", amount: expect.anything() },
    });
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const call = mockedCreate.mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({ providerRef: "pi_fail_001", status: "FAILED" });
    expect(Number((call?.data as { amount?: unknown })?.amount)).toBe(27);
  });

  it("[WHU-FAILED-REUSE] a repeated failure for the SAME providerRef reuses the existing non-SUCCEEDED row via updateMany, never `create`", async () => {
    mockedUpdateMany.mockResolvedValueOnce({ count: 1 });

    const event = makeFailedEvent({ id: "pi_fail_repeat" });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockedFindUnique).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("[WHU-FAILED-NO-DOWNGRADE] a delayed/reordered failure for a providerRef with an existing SUCCEEDED Payment is a no-op — never downgrades it (Bug 1 fix)", async () => {
    mockedUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockedFindUnique.mockResolvedValueOnce({ status: "SUCCEEDED" } as never);

    const event = makeFailedEvent({ id: "pi_fail_downgrade" });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { providerRef: "pi_fail_downgrade", status: { notIn: ["SUCCEEDED", "CANCELED"] } },
      data: { status: "FAILED", amount: expect.anything() },
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("[WHU-FAILED-NO-CART-TOUCH] the FAILED path never reads the cart or calls createOrderFromPayment", async () => {
    mockedUpdateMany.mockResolvedValueOnce({ count: 1 });

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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    const fakeTx = { payment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), updateMany: vi.fn() } };
    mockedTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx));
    mockedCreateOrderFromPayment.mockResolvedValueOnce({} as OrderDetailView);
    // `cartId: "cart_xyz"` matches the event metadata below — the Bug 2
    // reconciliation guard (WU3 rework) compares cartView.cartId against
    // metadata.cartId, so the two must agree for this test to exercise the
    // metadata re-derivation path instead of the mismatch branch.
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView({ userId: "user_xyz", cartId: "cart_xyz" }));
    // producer_A/mode_B: a DIFFERENT deliveryModeId than the default
    // producer_A/mode_A fixture, still proving the selection re-derived
    // from metadata threads through untouched, while resolving to a valid
    // DeliveryMode for the cart's own producer (guard requirement).
    mockedDeliveryModeFindMany.mockResolvedValueOnce([
      { id: "mode_B", producerId: "producer_A", isActive: true, cost: 2.0 },
    ] as never);

    const event = makeSucceededEvent({
      id: "pi_success_002",
      metadata: {
        userId: "user_xyz",
        cartId: "cart_xyz",
        deliverySelections: serializeDeliverySelectionsForMetadata([
          { producerId: "producer_A", deliveryModeId: "mode_B" },
        ]),
      },
    });
    await paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event));

    expect(mockedGetCartForCheckout).toHaveBeenCalledWith("user_xyz");
    expect(mockedCreateOrderFromPayment).toHaveBeenCalledWith(
      "pi_success_002",
      expect.anything(),
      [{ producerId: "producer_A", deliveryModeId: "mode_B" }],
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
      return fn({ payment: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), updateMany: vi.fn() } });
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

// ---------------------------------------------------------------------------
// payment_intent.succeeded -> reconciliation guard: recomputeCartTotal cannot
// verify the charged amount (a selected DeliveryMode vanished / went inactive,
// so `recomputeCartTotal` returns null). WU3 R4 money-integrity fix: an
// unverifiable total must be treated the SAME as a reconciliation failure —
// persist a durable PENDING Payment for the CHARGED amount and RETURN, never
// entering the order $transaction (whose frozen createOrderFromPayment would
// throw ValidationFailedError for the missing mode, rolling back payment.create
// and leaving a CHARGED intent with NO Order and NO Payment row at all).
// ---------------------------------------------------------------------------

describe("payments.service — payment_intent.succeeded reconciliation guard: unverifiable total [WHU-CANNOT-VERIFY]", () => {
  it("[WHU-CANNOT-VERIFY] a succeeded event whose selected DeliveryMode is gone/inactive (recomputeCartTotal -> null) with a matching cartId persists a PENDING Payment for the charged amount, never opens the order $transaction, and never throws", async () => {
    // The producer's selected DeliveryMode no longer resolves to an active
    // row -> recomputeCartTotal returns null ("cannot verify"). cartId still
    // matches, so WITHOUT the fix totalMismatch is false, the safety block is
    // skipped, and execution falls into the throwing frozen $transaction.
    mockedDeliveryModeFindMany.mockResolvedValueOnce([]);
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView());
    // upsertNonTerminalPayment path: no existing row -> updateMany count 0 ->
    // findUnique null (beforeEach default) -> create a fresh PENDING row.
    mockedUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockedCreate.mockResolvedValueOnce({} as never);

    const event = makeSucceededEvent({ id: "pi_cannot_verify", amount: 700 });

    // MUST NOT throw/propagate — the charge is a fact; losing it is the bug.
    await expect(
      paymentsService.handleWebhookEvent(RAW_BODY, SIGNATURE, makeClient(event)),
    ).resolves.toBeUndefined();

    // A durable PENDING Payment for the CHARGED amount (700 cents = 7.00 EUR)
    // is written for manual reconciliation/refund.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const call = mockedCreate.mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({ providerRef: "pi_cannot_verify", status: "PENDING" });
    expect(Number((call?.data as { amount?: unknown })?.amount)).toBe(7);

    // NO order is ever created and the throwing $transaction is never opened.
    expect(mockedCreateOrderFromPayment).not.toHaveBeenCalled();
    expect(mockedTransaction).not.toHaveBeenCalled();
  });
});
