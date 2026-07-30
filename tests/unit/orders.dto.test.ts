/**
 * Unit tests — orders error taxonomy (WU1) + orders.dto pure mapping (WU3).
 *
 * WU1 (Foundation) covers the two NEW AppError subclasses (error taxonomy
 * section below), mirroring the errors-cycle2.test.ts precedent (subclass +
 * ErrorCode row added together, per the errors.ts header invariant).
 *
 * WU3 (Read Surface) adds `mapOrderSummaryView` coverage — the PURE mapping
 * function in `orders.dto.ts` that builds the frozen `OrderSummaryView` wire
 * shape from an already-derived row (see orders.dto.ts header: status and
 * producerCount are pre-computed by the caller, this function only formats).
 *
 * Scenarios covered (spec §"New Error Classes", design Decision 5):
 *   - EmptyCartCheckoutError: code EMPTY_CART_CHECKOUT, status 422
 *   - CartItemNotAvailableError: code CART_ITEM_NOT_AVAILABLE, status 409
 *   - both are instances of Error / AppError (instanceof works across targets)
 *   - typeSlug derivation invariant holds for both new subclasses
 *
 * Scenarios covered (spec §"Response Shapes" OrderSummaryView, WU3):
 *   [DTO-SUM-1] full row maps ISO createdAt, 2dp Decimal totalAmount, status
 *               and producerCount passed through unchanged
 *   [DTO-SUM-2] triangulation — a DIFFERENT row (different status, different
 *               producerCount, different totalAmount) maps independently,
 *               proving the function is not hardcoded to the first fixture
 *
 * Spec references:
 *   orders §"New Error Classes"
 *   orders §"Response Shapes" — OrderSummaryView
 *   design Decision 5 (CartItemNotAvailableError ownership — orders declares + throws)
 *   design Decision 2 (deriveOrderStatus sole authority — status is pre-derived, not
 *     re-derived here)
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CartItemNotAvailableError, EmptyCartCheckoutError } from "@/shared/errors/errors";
import { mapOrderSummaryView } from "@/modules/orders/dto/orders.dto";
import type { OrderSummaryRow } from "@/modules/orders/dto/orders.dto";

// ---------------------------------------------------------------------------
// EmptyCartCheckoutError — 422 EMPTY_CART_CHECKOUT
// ---------------------------------------------------------------------------

describe("EmptyCartCheckoutError", () => {
  it("carries code EMPTY_CART_CHECKOUT, status 422, and correct title", () => {
    const err = new EmptyCartCheckoutError("Cannot checkout an empty cart");

    expect(err.code).toBe("EMPTY_CART_CHECKOUT");
    expect(err.status).toBe(422);
    expect(err.typeSlug).toBe("/errors/empty-cart-checkout");
  });

  it("is an instance of Error", () => {
    expect(new EmptyCartCheckoutError("x")).toBeInstanceOf(Error);
    expect(new EmptyCartCheckoutError("x")).toBeInstanceOf(EmptyCartCheckoutError);
  });
});

// ---------------------------------------------------------------------------
// CartItemNotAvailableError — 409 CART_ITEM_NOT_AVAILABLE
// ---------------------------------------------------------------------------

describe("CartItemNotAvailableError", () => {
  it("carries code CART_ITEM_NOT_AVAILABLE, status 409, and correct title", () => {
    const err = new CartItemNotAvailableError("One or more cart items are no longer available");

    expect(err.code).toBe("CART_ITEM_NOT_AVAILABLE");
    expect(err.status).toBe(409);
    expect(err.typeSlug).toBe("/errors/cart-item-not-available");
  });

  it("is an instance of Error", () => {
    expect(new CartItemNotAvailableError("x")).toBeInstanceOf(Error);
    expect(new CartItemNotAvailableError("x")).toBeInstanceOf(CartItemNotAvailableError);
  });
});

// ---------------------------------------------------------------------------
// Triangulation — both new subclasses share typeSlug derivation invariant
// ---------------------------------------------------------------------------

describe("Cycle 4 orders WU1 subclasses — typeSlug derivation invariant", () => {
  it.each([
    [new EmptyCartCheckoutError("x"), "/errors/empty-cart-checkout"],
    [new CartItemNotAvailableError("x"), "/errors/cart-item-not-available"],
  ])("%s derives typeSlug = %s", (err, expectedSlug) => {
    expect(err.typeSlug).toBe(expectedSlug);
  });
});

// ---------------------------------------------------------------------------
// mapOrderSummaryView — pure mapping, orders WU3 (Read Surface)
// ---------------------------------------------------------------------------

function makeOrderSummaryRow(overrides: Partial<OrderSummaryRow> = {}): OrderSummaryRow {
  return {
    id: "order_001",
    createdAt: new Date("2026-07-28T10:00:00.000Z"),
    totalAmount: new Prisma.Decimal("24.00"),
    status: "PENDING",
    producerCount: 2,
    ...overrides,
  };
}

describe("mapOrderSummaryView", () => {
  it("[DTO-SUM-1] maps ISO createdAt, 2dp Decimal totalAmount, and passes status/producerCount through", () => {
    const row = makeOrderSummaryRow();

    const view = mapOrderSummaryView(row);

    expect(view).toEqual({
      id: "order_001",
      createdAt: "2026-07-28T10:00:00.000Z",
      totalAmount: "24.00",
      status: "PENDING",
      producerCount: 2,
    });
  });

  it("[DTO-SUM-2] triangulation — a different row (FULFILLED, producerCount 1, different total) maps independently", () => {
    const row = makeOrderSummaryRow({
      id: "order_002",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      totalAmount: new Prisma.Decimal("9.5"),
      status: "FULFILLED",
      producerCount: 1,
    });

    const view = mapOrderSummaryView(row);

    expect(view).toEqual({
      id: "order_002",
      createdAt: "2026-01-15T00:00:00.000Z",
      totalAmount: "9.50",
      status: "FULFILLED",
      producerCount: 1,
    });
  });
});
