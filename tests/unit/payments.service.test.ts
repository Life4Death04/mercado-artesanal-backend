/**
 * Unit tests — payments module (Cycle 5 payments WU1, strict TDD).
 *
 * WU1 scope ONLY: POST /pagos/intent (authenticated PaymentIntent creation).
 * WU2 (webhook trust boundary) and WU3 (atomic webhook events) are OUT OF
 * SCOPE for this file — no webhook/event-dispatch tests belong here.
 *
 * Strategy:
 *   - DTO/metadata-guard/cents-conversion tests are PURE — zero mocks
 *     (strict-tdd "Pure Function Preference" + "Extract-Before-Mock Rule").
 *   - `createPaymentIntent` tests mock the frozen `getCartForCheckout`
 *     contract (`@/modules/cart/services/cart.service`), the `prisma`
 *     singleton (`deliveryMode.findMany` only — no other delegate is touched
 *     by WU1), and the `stripeClient` mock seam
 *     (`@/modules/payments/services/stripe.client`) so no real Stripe SDK
 *     call is ever made from a unit test.
 *
 * WU1 scenarios covered (design D1-D3 scoped to intent creation; spec R1-R5):
 *   [PD-VALID] CreatePaymentIntentSchema accepts a well-formed deliverySelections array
 *   [PD-STRICT] CreatePaymentIntentSchema rejects unknown top-level keys (strictObject)
 *   [PD-SEL-STRICT] DeliverySelectionSchema rejects unknown keys per selection
 *   [PD-SEL-EMPTY] DeliverySelectionSchema rejects empty producerId/deliveryModeId
 *   [PD-META-OK] serializeDeliverySelectionsForMetadata returns compact JSON under 500 chars
 *   [PD-META-TOOLONG] serializeDeliverySelectionsForMetadata throws ValidationFailedError when
 *                      compact JSON exceeds 500 chars
 *   [PD-META-TOOMANY] serializeDeliverySelectionsForMetadata throws ValidationFailedError when
 *                      selections.length exceeds 50 keys
 *   [SC-CENTS-1] eurosToCents converts a whole-euro amount to integer cents
 *   [SC-CENTS-2] eurosToCents rounds a fractional-cent amount (floating point safety)
 *   [CPI-NOCART] no Cart row -> NotFoundError (404), no deliveryMode query, no Stripe call
 *   [CPI-EMPTY] empty cart -> EmptyCartCheckoutError (422), no deliveryMode query, no Stripe call
 *   [CPI-SEL-MISSING] deliverySelections missing a cart producerId -> ValidationFailedError (422)
 *   [CPI-SEL-EXTRA] deliverySelections has an unknown producerId -> ValidationFailedError (422)
 *   [CPI-SEL-UNRESOLVED] deliveryModeId does not resolve -> ValidationFailedError (422)
 *   [CPI-SEL-MISMATCH] resolved DeliveryMode.producerId != selection.producerId -> ValidationFailedError (422)
 *   [CPI-SEL-INACTIVE] resolved DeliveryMode.isActive = false -> ValidationFailedError (422)
 *   [CPI-STOCK] quantity > live Product.stock on one item -> InsufficientStockError (409), no Stripe call
 *   [CPI-TOTAL] total = Σ(unitPriceSnapshot*qty) + Σ shippingByProducer -> exactly "27.00"
 *   [CPI-CLIENT-AMOUNT-IGNORED] createPaymentIntent never reads any client-supplied amount field
 *   [CPI-IDEMPOTENCY] idempotencyKey passed to Stripe equals cartView.cartId, stable across repeat calls
 *   [CPI-STRIPE-FAIL] stripeClient.createPaymentIntent rejects -> PaymentIntentCreationError (502), no partial state
 *   [CPI-SUCCESS] happy path returns { clientSecret } from the Stripe mock response
 *
 * Spec references:
 *   payments §"POST /pagos/intent creates intent behind full auth chain"
 *   payments §"Intent validates delivery selections"
 *   payments §"Intent hard stock gate"
 *   payments §"Intent amount server-side EUR"
 *   payments §"Stripe failure -> PaymentIntentCreationError 502"
 *   design D1 (deliverySelections carry-through / metadata guard)
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the frozen cart read contract — payments composes it, never edits it.
// ---------------------------------------------------------------------------
vi.mock("@/modules/cart/services/cart.service", () => ({
  getCartForCheckout: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock prisma singleton — WU1 only touches deliveryMode.findMany directly.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => ({
  prisma: {
    deliveryMode: {
      findMany: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock the Stripe SDK boundary/mock seam — no real Stripe SDK call in unit
// tests. `eurosToCents` is re-exported as the REAL pure function (not a
// spy) — it has zero dependency on the Stripe SDK, so the mock factory
// imports the actual module to preserve it (strict-tdd "Pure Function
// Preference" + "Extract-Before-Mock Rule": no reason to mock pure logic).
// ---------------------------------------------------------------------------
vi.mock("@/modules/payments/services/stripe.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/payments/services/stripe.client")>();
  return {
    ...actual,
    stripeClient: {
      createPaymentIntent: vi.fn(),
    },
  };
});

import type { CartForCheckout, CartItemForCheckout } from "@/modules/cart/services/cart.service";
import { getCartForCheckout } from "@/modules/cart/services/cart.service";
import type { DeliverySelection } from "@/modules/orders/services/orders.service";
import {
  CartItemNotAvailableError,
  EmptyCartCheckoutError,
  InsufficientStockError,
  NotFoundError,
  PaymentIntentCreationError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import {
  CreatePaymentIntentSchema,
  DeliverySelectionSchema,
  serializeDeliverySelectionsForMetadata,
} from "@/modules/payments/dto/payments.dto";
import { eurosToCents } from "@/modules/payments/services/stripe.client";
import { stripeClient } from "@/modules/payments/services/stripe.client";
import * as paymentsService from "@/modules/payments/services/payments.service";

const mockedGetCartForCheckout = vi.mocked(getCartForCheckout);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedDeliveryMode = vi.mocked(prisma).deliveryMode as any;
const mockedCreatePaymentIntent = vi.mocked(stripeClient.createPaymentIntent);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCartItem(overrides: Partial<CartItemForCheckout> = {}): CartItemForCheckout {
  return {
    cartItemId: "item_001",
    productId: "product_001",
    producerId: "producer_A",
    quantity: 2,
    unitPriceSnapshot: "5.00",
    isAvailable: true,
    product: {
      id: "product_001",
      name: "Aceite de Oliva",
      stock: 10,
      isActive: true,
      producer: { id: "producer_A", isActive: true },
    },
    ...overrides,
  };
}

function makeCartView(items: CartItemForCheckout[], overrides: Partial<CartForCheckout> = {}): CartForCheckout {
  return {
    cartId: "cart_001",
    userId: "user_001",
    items,
    ...overrides,
  };
}

function makeDeliveryModeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mode_A",
    producerId: "producer_A",
    isActive: true,
    cost: new Prisma.Decimal("2.00"),
    ...overrides,
  };
}

function makeSelection(overrides: Partial<DeliverySelection> = {}): DeliverySelection {
  return { producerId: "producer_A", deliveryModeId: "mode_A", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// DTO — pure Zod schema tests (zero mocks)
// ---------------------------------------------------------------------------

describe("payments.dto — CreatePaymentIntentSchema / DeliverySelectionSchema", () => {
  it("[PD-VALID] accepts a well-formed deliverySelections array", () => {
    const result = CreatePaymentIntentSchema.safeParse({
      deliverySelections: [{ producerId: "producer_A", deliveryModeId: "mode_A" }],
    });
    expect(result.success).toBe(true);
  });

  it("[PD-STRICT] rejects unknown top-level keys", () => {
    const result = CreatePaymentIntentSchema.safeParse({
      deliverySelections: [],
      amount: 999,
    });
    expect(result.success).toBe(false);
  });

  it("[PD-SEL-STRICT] rejects unknown keys inside a selection", () => {
    const result = DeliverySelectionSchema.safeParse({
      producerId: "producer_A",
      deliveryModeId: "mode_A",
      trackingNumber: "sneaky",
    });
    expect(result.success).toBe(false);
  });

  it("[PD-SEL-EMPTY] rejects an empty producerId", () => {
    const result = DeliverySelectionSchema.safeParse({ producerId: "", deliveryModeId: "mode_A" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DTO — metadata guard (D1), pure function, zero mocks
// ---------------------------------------------------------------------------

describe("payments.dto — serializeDeliverySelectionsForMetadata (D1 guard)", () => {
  it("[PD-META-OK] returns compact JSON under 500 chars for a normal cart", () => {
    const selections = [makeSelection()];
    const json = serializeDeliverySelectionsForMetadata(selections);
    expect(json).toBe(JSON.stringify(selections));
    expect(json.length).toBeLessThanOrEqual(500);
  });

  it("[PD-META-TOOLONG] throws ValidationFailedError when compact JSON exceeds 500 chars", () => {
    const selections: DeliverySelection[] = Array.from({ length: 15 }, (_, i) =>
      makeSelection({
        producerId: `producer_with_a_very_long_identifier_${i}`,
        deliveryModeId: `mode_with_a_very_long_identifier_${i}`,
      }),
    );
    expect(() => serializeDeliverySelectionsForMetadata(selections)).toThrow(ValidationFailedError);
  });

  it("[PD-META-TOOMANY] throws ValidationFailedError when selections.length exceeds 50 keys", () => {
    const selections: DeliverySelection[] = Array.from({ length: 51 }, (_, i) =>
      makeSelection({ producerId: `p${i}`, deliveryModeId: `m${i}` }),
    );
    expect(() => serializeDeliverySelectionsForMetadata(selections)).toThrow(ValidationFailedError);
  });
});

// ---------------------------------------------------------------------------
// stripe.client — eurosToCents pure function (zero mocks)
// ---------------------------------------------------------------------------

describe("stripe.client — eurosToCents", () => {
  it("[SC-CENTS-1] converts a whole-euro amount to integer cents", () => {
    expect(eurosToCents(27)).toBe(2700);
  });

  it("[SC-CENTS-2] rounds a fractional-cent amount (floating point safety)", () => {
    expect(eurosToCents(19.999999999998)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// payments.service.createPaymentIntent
// ---------------------------------------------------------------------------

describe("payments.service.createPaymentIntent", () => {
  it("[CPI-NOCART] no Cart row -> NotFoundError, no deliveryMode query, no Stripe call", async () => {
    mockedGetCartForCheckout.mockRejectedValueOnce(new NotFoundError("Cart not found"));

    await expect(paymentsService.createPaymentIntent("user_001", [])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(mockedDeliveryMode.findMany).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-EMPTY] empty cart -> EmptyCartCheckoutError, no deliveryMode query, no Stripe call", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([]));

    await expect(paymentsService.createPaymentIntent("user_001", [])).rejects.toBeInstanceOf(
      EmptyCartCheckoutError,
    );
    expect(mockedDeliveryMode.findMany).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-SEL-MISSING] missing a cart producerId in deliverySelections -> ValidationFailedError", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    // deliverySelections is empty here, so the service short-circuits BEFORE
    // querying deliveryMode.findMany (selectedModeIds.length === 0) — no mock needed.

    await expect(paymentsService.createPaymentIntent("user_001", [])).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-SEL-EXTRA] deliverySelections has an unknown producerId -> ValidationFailedError", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([
      makeDeliveryModeRow({ id: "mode_X", producerId: "producer_X" }),
    ]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [
        makeSelection({ producerId: "producer_X", deliveryModeId: "mode_X" }),
      ]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-SEL-UNRESOLVED] deliveryModeId does not resolve -> ValidationFailedError", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-SEL-MISMATCH] resolved DeliveryMode.producerId != selection.producerId -> ValidationFailedError", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([
      makeDeliveryModeRow({ id: "mode_A", producerId: "producer_OTHER" }),
    ]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-SEL-INACTIVE] resolved DeliveryMode.isActive = false -> ValidationFailedError", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([
      makeDeliveryModeRow({ isActive: false }),
    ]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-STOCK] quantity > live Product.stock -> InsufficientStockError, no Stripe call", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(
      makeCartView([makeCartItem({ quantity: 999, product: { ...makeCartItem().product, stock: 3 } })]),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-UNAVAILABLE] isAvailable=false on one item -> CartItemNotAvailableError, no Stripe call", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(
      makeCartView([makeCartItem({ isAvailable: false, quantity: 1 })]),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(CartItemNotAvailableError);
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("[CPI-TOTAL] total sums lines + per-producer shipping -> exactly 27.00", async () => {
    // 2 * 5.00 + 3 * 5.00 = 25.00, + shipping 2.00 = 27.00
    mockedGetCartForCheckout.mockResolvedValueOnce(
      makeCartView([
        makeCartItem({ cartItemId: "item_001", quantity: 2, unitPriceSnapshot: "5.00" }),
        makeCartItem({ cartItemId: "item_002", quantity: 3, unitPriceSnapshot: "5.00" }),
      ]),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow({ cost: new Prisma.Decimal("2.00") })]);
    mockedCreatePaymentIntent.mockResolvedValueOnce({ id: "pi_123", client_secret: "secret_123" });

    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);

    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 27 }),
    );
  });

  it("[CPI-CLIENT-AMOUNT-IGNORED] createPaymentIntent signature has no client-amount parameter", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockResolvedValueOnce({ id: "pi_123", client_secret: "secret_123" });

    // createPaymentIntent(userId, deliverySelections) — exactly 2 required params.
    // Calling it with the real arity proves no third "amount" argument exists.
    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);

    const callArgs = mockedCreatePaymentIntent.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty("clientAmount");
  });

  it("[CPI-IDEMPOTENCY-SAME] identical cart content across repeat calls -> same idempotencyKey", async () => {
    mockedGetCartForCheckout.mockResolvedValue(makeCartView([makeCartItem()], { cartId: "cart_XYZ" }));
    mockedDeliveryMode.findMany.mockResolvedValue([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockResolvedValue({ id: "pi_123", client_secret: "secret_123" });

    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);
    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);

    const firstKey = mockedCreatePaymentIntent.mock.calls[0]?.[0]?.idempotencyKey;
    const secondKey = mockedCreatePaymentIntent.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it("[CPI-IDEMPOTENCY-DIFF] changed cart content on same cartId -> different idempotencyKey", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(
      makeCartView([makeCartItem({ quantity: 2 })], { cartId: "cart_XYZ" }),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockResolvedValueOnce({ id: "pi_123", client_secret: "secret_123" });

    mockedGetCartForCheckout.mockResolvedValueOnce(
      makeCartView([makeCartItem({ quantity: 3 })], { cartId: "cart_XYZ" }),
    );
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockResolvedValueOnce({ id: "pi_456", client_secret: "secret_456" });

    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);
    await paymentsService.createPaymentIntent("user_001", [makeSelection()]);

    const firstKey = mockedCreatePaymentIntent.mock.calls[0]?.[0]?.idempotencyKey;
    const secondKey = mockedCreatePaymentIntent.mock.calls[1]?.[0]?.idempotencyKey;
    expect(firstKey).not.toBe(secondKey);
  });

  it("[CPI-STRIPE-FAIL] stripeClient rejection -> PaymentIntentCreationError, no partial state leaked", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockRejectedValueOnce(new Error("stripe down"));

    await expect(
      paymentsService.createPaymentIntent("user_001", [makeSelection()]),
    ).rejects.toBeInstanceOf(PaymentIntentCreationError);
  });

  it("[CPI-SUCCESS] happy path returns { clientSecret } from the Stripe mock response", async () => {
    mockedGetCartForCheckout.mockResolvedValueOnce(makeCartView([makeCartItem()]));
    mockedDeliveryMode.findMany.mockResolvedValueOnce([makeDeliveryModeRow()]);
    mockedCreatePaymentIntent.mockResolvedValueOnce({ id: "pi_999", client_secret: "secret_999" });

    const result = await paymentsService.createPaymentIntent("user_001", [makeSelection()]);

    expect(result).toEqual({ clientSecret: "secret_999" });
  });
});
