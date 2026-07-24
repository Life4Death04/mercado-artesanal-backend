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
 * PR #2 note (producer.isActive derivation): the `Producer` Prisma model has
 * NO `isActive` boolean field — it uses `deletedAt: DateTime | null` for
 * soft-delete (see prisma/schema.prisma). The spec/design wire shape declares
 * `producer.isActive: boolean`, so this service derives it as
 * `producer.deletedAt === null`. This preserves the design's INTENT (an
 * inactive/removed producer makes its items unavailable) without a schema
 * field that does not exist. Flagged as a spec/design correction candidate
 * for the next revision — see apply-progress deviations.
 *
 * Spec references:
 *   cart §R1–R8 — full requirement set
 *   design — D1 (error taxonomy), D2 (synthetic empty view), D3 ($transaction callback),
 *            D4 (query-count seam), D5 (Zod 422)
 */
import type { Prisma } from "@prisma/client";

import { NotFoundError, ProductInactiveError, QuantityExceedsStockError } from "@/shared/errors/errors";
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
// Internal row shapes (nested Prisma includes) — mapping helpers only
// ---------------------------------------------------------------------------

type ProducerRow = { id: string; deletedAt: Date | null };
type ProductRow = {
  id: string;
  name: string;
  price: Prisma.Decimal;
  stock: number;
  isActive: boolean;
  producer: ProducerRow;
};
type CartItemRow = {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
  product: ProductRow;
};

/**
 * Computes item availability: product is active AND its producer is not
 * soft-deleted. See file header note on the producer.isActive derivation.
 */
function computeIsAvailable(product: ProductRow): boolean {
  return product.isActive && product.producer.deletedAt === null;
}

/** Maps a Prisma CartItem row (with nested product+producer) to the wire shape. */
function mapCartItemView(item: CartItemRow): CartItemView {
  const { product } = item;
  return {
    id: item.id,
    productId: item.productId,
    quantity: item.quantity,
    unitPriceSnapshot: item.unitPriceSnapshot.toFixed(2),
    isAvailable: computeIsAvailable(product),
    product: {
      id: product.id,
      name: product.name,
      price: product.price.toFixed(2),
      stock: product.stock,
      isActive: product.isActive,
      producer: {
        id: product.producer.id,
        isActive: product.producer.deletedAt === null,
      },
    },
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service functions
// PR #2 implements: getCartView, addItem
// PR #3 implements: updateItemQuantity, removeItem, clearCart, getCartForCheckout
// ---------------------------------------------------------------------------

/**
 * GET /carrito — return cart + computed availability for each item.
 * Returns synthetic empty view when user has no Cart row (D2).
 *
 * NFR-1: issues exactly ONE Prisma query — a single `cart.findUnique` with a
 * nested `include` (no N+1, no second round trip for items/product/producer).
 */
export async function getCartView(userId: string): Promise<CartReadView> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          product: { include: { producer: true } },
        },
      },
    },
  });

  if (!cart) {
    // D2 — synthetic empty view, no lazy-create on read.
    return { id: null, userId, items: [], createdAt: null, updatedAt: null };
  }

  return {
    id: cart.id,
    userId: cart.userId,
    items: cart.items.map((item) => mapCartItemView(item as CartItemRow)),
    createdAt: cart.createdAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/**
 * POST /carrito/items — add or increment an item with price snapshotting.
 *
 * Rules (spec §"POST /carrito/items adds or increments..."):
 *   1. Load Product + producer; 404 if not found.
 *   2. 409 ProductInactiveError if Product.isActive = false.
 *   3. 422 QuantityExceedsStockError if quantity > Product.stock.
 *   4. Double-upsert inside prisma.$transaction (D3): cart-level upsert on
 *      Cart.userId, then item-level upsert on @@unique([cartId, productId]).
 *      CREATE branch snapshots the live price; UPDATE branch only increments
 *      quantity and MUST NOT touch unitPriceSnapshot (NFR-2).
 *   5. NFR-3: no find-then-create — cart identity is established via upsert
 *      only, never via a preceding cart.findUnique.
 */
export async function addItem(
  userId: string,
  productId: string,
  quantity: number,
): Promise<CartItemView> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { producer: true },
  });

  if (!product) {
    throw new NotFoundError("Product not found");
  }
  if (!product.isActive) {
    throw new ProductInactiveError("Product is not active");
  }
  if (quantity > product.stock) {
    throw new QuantityExceedsStockError("Quantity exceeds available stock");
  }

  const item = await prisma.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return tx.cartItem.upsert({
      where: { cart_product_unique: { cartId: cart.id, productId } },
      create: {
        cartId: cart.id,
        productId,
        quantity,
        unitPriceSnapshot: product.price,
      },
      update: {
        quantity: { increment: quantity },
      },
    });
  });

  return mapCartItemView({ ...item, product });
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
