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
  deletedAt: Date | null;
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
 * Computes item availability: product is not soft-deleted, is active, AND
 * its producer is not soft-deleted. See file header note on the
 * producer.isActive derivation.
 */
function computeIsAvailable(product: ProductRow): boolean {
  return product.deletedAt === null && product.isActive && product.producer.deletedAt === null;
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
 * NFR-1: issues exactly ONE SQL query — a single `cart.findUnique` with a
 * nested `include`, forced to lower to a single Postgres `LEFT JOIN` query
 * via `relationLoadStrategy: "join"` (requires the `relationJoins` preview
 * feature, see prisma/schema.prisma generator block). Without this, Prisma's
 * default strategy batches nested includes into separate queries per relation
 * level (verified empirically: 4 queries for this exact shape — see
 * tests/integration/cart.query-count.test.ts, the authoritative NFR-1 proof).
 */
export async function getCartView(userId: string): Promise<CartReadView> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    relationLoadStrategy: "join",
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
 *   1. Load Product + producer, scoped to `deletedAt: null` on BOTH the
 *      product and its producer; 404 (same not-found path as an unknown
 *      productId) when it does not resolve — a soft-deleted product/producer
 *      is NOT FOUND, never a self-contradicting `isAvailable:false` 201.
 *   2. 409 ProductInactiveError if Product.isActive = false.
 *   3. 422 QuantityExceedsStockError if the requested quantity alone already
 *      exceeds Product.stock (fast-fail, no transaction opened).
 *   4. Double-upsert inside prisma.$transaction (D3): cart-level upsert on
 *      Cart.userId, then item-level upsert on @@unique([cartId, productId]).
 *      CREATE branch snapshots the live price; UPDATE branch only increments
 *      quantity and MUST NOT touch unitPriceSnapshot (NFR-2).
 *      Inside the transaction, the RESULTING total quantity (existing
 *      cart-item quantity + requested increment) is re-validated against
 *      Product.stock — 422 QuantityExceedsStockError if it would be
 *      exceeded. This closes the gap where repeated valid increments (each
 *      individually within stock) could otherwise push CartItem.quantity
 *      above Product.stock (e.g. stock=1, add 1 twice → quantity 2).
 *   5. NFR-3: no find-then-create — cart identity is established via upsert
 *      only, never via a preceding cart.findUnique. Prisma's `upsert` is NOT
 *      atomic against concurrent inserts under READ COMMITTED inside an
 *      interactive transaction (select-then-insert, not a native
 *      INSERT ... ON CONFLICT): two concurrent first-adds for the same user
 *      can both take the create path and one hits P2002 on `Cart.userId`.
 *      Postgres aborts the ENTIRE transaction on that error (a transaction
 *      cannot keep running further statements once one has failed — error
 *      25P02 "current transaction is aborted"), so the recovery cannot be a
 *      same-transaction catch-and-continue. Instead, the whole
 *      `prisma.$transaction` call is retried ONCE on P2002: by the time the
 *      retry starts, the winning transaction has already committed its cart
 *      row, so the retried upsert takes the UPDATE branch and succeeds. This
 *      is a catch-and-retry of an already-failed create, not a pre-emptive
 *      find-then-create, so NFR-3's intent (no speculative read before
 *      attempting the write) is preserved.
 */
export async function addItem(
  userId: string,
  productId: string,
  quantity: number,
): Promise<CartItemView> {
  const product = await prisma.product.findUnique({
    where: { id: productId, deletedAt: null, producer: { deletedAt: null } },
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

  const runTransaction = () =>
    prisma.$transaction(async (tx) => {
      const cart = await tx.cart.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });

      const existingItem = await tx.cartItem.findUnique({
        where: { cart_product_unique: { cartId: cart.id, productId } },
      });
      const totalQuantity = (existingItem?.quantity ?? 0) + quantity;
      if (totalQuantity > product.stock) {
        throw new QuantityExceedsStockError("Quantity exceeds available stock");
      }

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

  let item;
  try {
    item = await runTransaction();
  } catch (err: unknown) {
    const isCartUserIdConflict =
      typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
    if (!isCartUserIdConflict) {
      throw err;
    }
    // Retry once: the transaction that just aborted lost a concurrent race
    // on `Cart.userId`; the winner has fully committed by now, so this
    // retry's cart.upsert takes the UPDATE branch and succeeds.
    item = await runTransaction();
  }

  return mapCartItemView({ ...item, product });
}

/**
 * PATCH /carrito/items/:itemId — update quantity only.
 * Preserves unitPriceSnapshot (NFR-2, never included in the write).
 *
 * Rules (spec §"PATCH /carrito/items/:itemId updates quantity only"):
 *   1. Load the CartItem scoped to ownership (`cart: { userId }`); 404 if the
 *      item does not exist or belongs to a different user (NFR-6 — no-leak,
 *      same status for "unknown" and "unowned").
 *   2. Re-validate `quantity` against the freshly-loaded `Product.stock`
 *      (nested in the same query — no separate product lookup needed).
 *   3. Update `quantity` only; the write payload never references
 *      `unitPriceSnapshot`.
 */
export async function updateItemQuantity(
  userId: string,
  itemId: string,
  quantity: number,
): Promise<CartItemView> {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { userId } },
    include: { product: { include: { producer: true } } },
  });

  if (!item) {
    throw new NotFoundError("Cart item not found");
  }
  if (quantity > item.product.stock) {
    throw new QuantityExceedsStockError("Quantity exceeds available stock");
  }

  const updated = await prisma.cartItem.update({
    where: { id: itemId },
    data: { quantity },
    include: { product: { include: { producer: true } } },
  });

  return mapCartItemView(updated);
}

/**
 * DELETE /carrito/items/:itemId — remove a single item.
 * Ownership-enforced 404 (NFR-6): the ownership lookup happens before the
 * delete, so an unowned/unknown itemId never reaches `prisma.cartItem.delete`.
 */
export async function removeItem(userId: string, itemId: string): Promise<void> {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cart: { userId } },
    select: { id: true },
  });

  if (!item) {
    throw new NotFoundError("Cart item not found");
  }

  await prisma.cartItem.delete({ where: { id: itemId } });
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
