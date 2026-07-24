/**
 * Unit tests — cart.service (cycle-3/cart).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * This file is the unit-test HOME for the entire cart slice.
 * PR #1 creates this file as a harness — actual behavioral tests
 * (getCartView, addItem, etc.) are added in PR #2/#3 as each service
 * function is implemented under strict TDD.
 *
 * PR #1 harness content:
 *   - Prisma mock setup (same pattern as inventory.service.test.ts)
 *   - Placeholder describe block confirming the module is importable
 *
 * PR #2 will add: getCartView, addItem scenarios
 * PR #3 will add: updateItemQuantity, removeItem, clearCart, getCartForCheckout
 *
 * Spec references:
 *   cart §R1–R8 — full requirement set (behavioral tests come in PR #2/#3)
 *   design — D3 ($transaction callback form), D4 (delegate-count assertions)
 *   design — TDD ordering: schema+skeleton → GET/POST → PATCH/DELETE/checkout
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// Pattern: matches tests/unit/inventory.service.test.ts exactly
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      cart: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      cartItem: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      product: {
        findUnique: vi.fn(),
      },
    },
  };
});

import { prisma } from "@/shared/utils/prisma";
// Service import — will be populated in PR #2/#3
import * as cartService from "@/modules/cart/services/cart.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PR #1 harness — confirms the module is importable and mock is wired
// ---------------------------------------------------------------------------

describe("cart.service — module harness (PR #1)", () => {
  it("is importable and exports the expected function names", () => {
    expect(typeof cartService.getCartView).toBe("function");
    expect(typeof cartService.addItem).toBe("function");
    expect(typeof cartService.updateItemQuantity).toBe("function");
    expect(typeof cartService.removeItem).toBe("function");
    expect(typeof cartService.clearCart).toBe("function");
    expect(typeof cartService.getCartForCheckout).toBe("function");
  });

  it("prisma mock is in place (mockedPrisma.cart.findUnique is a spy)", () => {
    expect(vi.isMockFunction(mockedPrisma.cart.findUnique)).toBe(true);
  });
});
