/**
 * Cart service — business rules for cart management.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as cartService from "@/modules/cart/services/cart.service"`.
 *
 * Key invariants (from spec + design):
 *   - One cart per user (Cart.userId @unique); lazy-created on first addItem.
 *   - addItem uses prisma.$transaction(async tx => ...) callback form (D3, obs #887).
 *   - unitPriceSnapshot written ONCE at addItem time; never mutated (NFR-2, obs #882 D1).
 *   - GET /carrito uses exactly ONE Prisma query with nested include (NFR-1).
 *   - Empty cart: synthetic view { id: null, createdAt: null, updatedAt: null, userId, items: [] }
 *     — no lazy-create on read (D2, obs #887).
 *   - Ownership 404 on PATCH/DELETE /carrito/items/:itemId (NFR-6).
 *   - getCartForCheckout is a frozen read contract for the orders slice (R8, obs #886).
 *
 * All multi-row state transitions run inside `prisma.$transaction(async (tx) => { ... })`
 * callback form (NOT the array form) — required by the test mock strategy (D3, obs #887).
 *
 * Spec references:
 *   cart §R1–R8 — full requirement set
 *   design — D1 (error taxonomy), D2 (synthetic empty view), D3 ($transaction callback),
 *            D4 (query-count seam), D5 (Zod 422)
 */

import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface CartItemView {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: string;
  isAvailable: boolean;
  product: {
    id: string;
    name: string;
    price: string;
    stock: number;
    isActive: boolean;
    producer: {
      id: string;
      isActive: boolean;
    };
  };
  createdAt: string;
  updatedAt: string;
}

export interface CartReadView {
  id: string | null;
  userId: string;
  items: CartItemView[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CartItemForCheckout {
  cartItemId: string;
  productId: string;
  producerId: string;
  quantity: number;
  unitPriceSnapshot: string;
  isAvailable: boolean;
  product: {
    id: string;
    name: string;
    stock: number;
    isActive: boolean;
    producer: {
      id: string;
      isActive: boolean;
    };
  };
}

export interface CartForCheckout {
  cartId: string;
  userId: string;
  items: CartItemForCheckout[];
}

// ---------------------------------------------------------------------------
// Service functions — STUB implementations for PR #1
// PR #2 implements: getCartView, addItem
// PR #3 implements: updateItemQuantity, removeItem, clearCart, getCartForCheckout
// ---------------------------------------------------------------------------

/**
 * GET /carrito — return cart + computed availability for each item.
 * Returns synthetic empty view when user has no Cart row (D2).
 * STUB in PR #1 — implemented in PR #2.
 */
export async function getCartView(_userId: string): Promise<CartReadView> {
  // PR #1 stub — returns 501 via controller; actual implementation in PR #2
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * POST /carrito/items — add or increment an item with price snapshotting.
 * Creates Cart row if it doesn't exist (double-upsert pattern, D3).
 * STUB in PR #1 — implemented in PR #2.
 */
export async function addItem(
  _userId: string,
  _productId: string,
  _quantity: number,
): Promise<CartItemView> {
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * PATCH /carrito/items/:itemId — update quantity only.
 * Preserves unitPriceSnapshot (NFR-2).
 * STUB in PR #1 — implemented in PR #3.
 */
export async function updateItemQuantity(
  _userId: string,
  _itemId: string,
  _quantity: number,
): Promise<CartItemView> {
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * DELETE /carrito/items/:itemId — remove a single item.
 * Ownership-enforced 404 (NFR-6).
 * STUB in PR #1 — implemented in PR #3.
 */
export async function removeItem(_userId: string, _itemId: string): Promise<void> {
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * DELETE /carrito — clear all items, preserve Cart row identity.
 * STUB in PR #1 — implemented in PR #3.
 */
export async function clearCart(_userId: string): Promise<CartReadView> {
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

/**
 * Internal — read cart in the frozen CartForCheckout shape for the orders slice.
 * Frozen contract: shape MUST NOT change without a new proposal (ADR-003).
 * STUB in PR #1 — implemented in PR #3.
 */
export async function getCartForCheckout(_userId: string): Promise<CartForCheckout> {
  await Promise.resolve();
  throw new Error("NOT_IMPLEMENTED");
}

// Prevent "prisma imported but never used" lint error in the stub phase.
// PR #2/#3 will replace stubs with real calls.
void prisma;
