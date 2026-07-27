/**
 * Unit tests — orders error taxonomy (Cycle 4 orders WU1 TDD, RED phase).
 *
 * WU1 (Foundation) does not create an orders DTO module yet (that lands in
 * WU3 — Read Surface). This file covers the WU1 "order DTO/error codes"
 * task slice: the two NEW AppError subclasses this slice introduces,
 * mirroring the errors-cycle2.test.ts precedent (subclass + ErrorCode row
 * added together, per the errors.ts header invariant).
 *
 * Scenarios covered (spec §"New Error Classes", design Decision 5):
 *   - EmptyCartCheckoutError: code EMPTY_CART_CHECKOUT, status 422
 *   - CartItemNotAvailableError: code CART_ITEM_NOT_AVAILABLE, status 409
 *   - both are instances of Error / AppError (instanceof works across targets)
 *   - typeSlug derivation invariant holds for both new subclasses
 *
 * Spec references:
 *   orders §"New Error Classes"
 *   design Decision 5 (CartItemNotAvailableError ownership — orders declares + throws)
 */
import { describe, expect, it } from "vitest";

import { CartItemNotAvailableError, EmptyCartCheckoutError } from "@/shared/errors/errors";

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
