/**
 * Unit tests — cart.service (cycle-3/cart).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * This file is the unit-test HOME for the entire cart slice.
 * PR #1 created this file as a harness. PR #2 adds the first two
 * behavioral suites (getCartView, addItem) under strict TDD.
 *
 * PR #2 scenarios covered (spec §R2 GET, §R1/§R3 POST):
 *   getCartView:
 *     [G1] synthetic empty view when no Cart row exists (R2-S1, D2)
 *     [G2] populated view maps items with computed isAvailable (R2-S2)
 *     [G3] exactly ONE prisma query — findUnique called once, no other
 *          cart/cartItem/product delegate calls (NFR-1, D4)
 *     [G4] isAvailable = false when Product.isActive = false (R2-S3)
 *     [G5] isAvailable = false when Producer is soft-deleted (R2-S4)
 *   addItem:
 *     [A1] first add creates cart + item, snapshot = live Product.price (R1-S1, R3-S1)
 *     [A2] re-add same product increments quantity, snapshot untouched (R3-S2)
 *     [A3] unknown productId → NotFoundError, no $transaction opened
 *     [A4] Product.isActive = false → ProductInactiveError (409), no $transaction opened (R3-S3)
 *     [A5] quantity > Product.stock → QuantityExceedsStockError (422), no $transaction opened (R3-S4)
 *     [A6] NFR-3 no find-then-create — cart.findUnique is NEVER called by addItem (upsert only)
 *
 * PR #3 will add: updateItemQuantity, removeItem, clearCart, getCartForCheckout
 *
 * Spec references:
 *   cart §R1–R3 — cart identity, GET availability, POST add-with-snapshot
 *   design — D2 (synthetic empty view), D3 ($transaction callback form),
 *            D4 (delegate-count assertions, complementary to integration proof)
 *   design — TDD ordering: schema+skeleton → GET/POST → PATCH/DELETE/checkout
 */
import { Decimal } from "@prisma/client/runtime/library";
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
import { NotFoundError, ProductInactiveError, QuantityExceedsStockError } from "@/shared/errors/errors";
// Service import — behavioral exports populated across PR #2/#3
import * as cartService from "@/modules/cart/services/cart.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// `vi.mocked()` preserves the real Prisma delegate signatures, which are not
// recognized as Mock instances by TS. Cast to `any` at the delegate level —
// matches the established pattern in producers.service.test.ts / sub-orders.read.service.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedCartFindUnique = mockedPrisma.cart.findUnique as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedProductFindUnique = mockedPrisma.product.findUnique as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProducer(overrides: Record<string, unknown> = {}) {
  return {
    id: "producer_001",
    userId: "user_producer_001",
    businessName: "Test Producer",
    nif: "B12345674",
    description: "A test producer",
    addressLine1: "Calle Test 1",
    addressLine2: null,
    addressCity: "Madrid",
    addressPostalCode: "28001",
    addressProvince: "Madrid",
    addressCountry: "ES",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_001",
    producerId: "producer_001",
    categoryId: "cat_001",
    name: "Aceite de Oliva",
    description: "Aceite artesanal.",
    price: new Decimal("12.50"),
    stock: 10,
    lowStockThreshold: 5,
    isActive: true,
    ingredients: null,
    allergens: [],
    weight: null,
    presentation: null,
    reportedAt: null,
    moderationStatus: "OK",
    reportReason: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    producer: makeProducer(),
    ...overrides,
  };
}

function makeCartItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_001",
    cartId: "cart_001",
    productId: "product_001",
    quantity: 2,
    unitPriceSnapshot: new Decimal("12.50"),
    createdAt: new Date("2026-01-02T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    product: makeProduct(),
    ...overrides,
  };
}

function makeCart(overrides: Record<string, unknown> = {}) {
  return {
    id: "cart_001",
    userId: "user_001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    items: [] as unknown[],
    ...overrides,
  };
}

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

// ===========================================================================
// getCartView (PR #2, WU2-T1)
// ===========================================================================

describe("cartService.getCartView — synthetic empty view [G1]", () => {
  it("[G1] returns synthetic empty view when the user has no Cart row", async () => {
    mockedCartFindUnique.mockResolvedValueOnce(null);

    const view = await cartService.getCartView("user_001");

    expect(view).toEqual({
      id: null,
      userId: "user_001",
      items: [],
      createdAt: null,
      updatedAt: null,
    });
  });
});

describe("cartService.getCartView — populated view mapping [G2]", () => {
  it("[G2] maps a populated cart with computed isAvailable = true for active product + active producer", async () => {
    const cart = makeCart({ items: [makeCartItem()] });
    mockedCartFindUnique.mockResolvedValueOnce(cart);

    const view = await cartService.getCartView("user_001");

    expect(view.id).toBe("cart_001");
    expect(view.userId).toBe("user_001");
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      id: "item_001",
      productId: "product_001",
      quantity: 2,
      unitPriceSnapshot: "12.50",
      isAvailable: true,
      product: {
        id: "product_001",
        name: "Aceite de Oliva",
        price: "12.50",
        stock: 10,
        isActive: true,
        producer: { id: "producer_001", isActive: true },
      },
    });
    expect(view.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(view.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("cartService.getCartView — single-query seam [G3]", () => {
  it("[G3] issues exactly ONE Prisma query — findUnique called once, no other delegate touched", async () => {
    const cart = makeCart({ items: [makeCartItem()] });
    mockedCartFindUnique.mockResolvedValueOnce(cart);

    await cartService.getCartView("user_001");

    expect(mockedPrisma.cart.findUnique).toHaveBeenCalledOnce();
    expect(mockedPrisma.cart.upsert).not.toHaveBeenCalled();
    expect(mockedPrisma.cartItem.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.cartItem.upsert).not.toHaveBeenCalled();
    expect(mockedPrisma.product.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("cartService.getCartView — availability computation [G4][G5]", () => {
  it("[G4] isAvailable = false when Product.isActive = false, item still returned", async () => {
    const cart = makeCart({
      items: [makeCartItem({ product: makeProduct({ isActive: false }) })],
    });
    mockedCartFindUnique.mockResolvedValueOnce(cart);

    const view = await cartService.getCartView("user_001");

    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.isAvailable).toBe(false);
    expect(view.items[0]!.product.isActive).toBe(false);
  });

  it("[G5] isAvailable = false when Producer is soft-deleted, Product.isActive may remain true", async () => {
    const cart = makeCart({
      items: [
        makeCartItem({
          product: makeProduct({
            isActive: true,
            producer: makeProducer({ deletedAt: new Date("2026-02-01T00:00:00Z") }),
          }),
        }),
      ],
    });
    mockedCartFindUnique.mockResolvedValueOnce(cart);

    const view = await cartService.getCartView("user_001");

    expect(view.items[0]!.isAvailable).toBe(false);
    expect(view.items[0]!.product.isActive).toBe(true);
    expect(view.items[0]!.product.producer.isActive).toBe(false);
  });
});

// ===========================================================================
// addItem (PR #2, WU3-T1)
// ===========================================================================

describe("cartService.addItem — first add creates cart + item with live-price snapshot [A1]", () => {
  it("[A1] creates the cart (upsert) + item (upsert-create) and snapshots the live Product.price", async () => {
    const product = makeProduct({ price: new Decimal("12.50"), stock: 10 });
    mockedProductFindUnique.mockResolvedValueOnce(product);

    const cartUpsert = vi.fn().mockResolvedValue({ id: "cart_001", userId: "user_001" });
    const cartItemUpsert = vi.fn().mockResolvedValue(
      makeCartItem({ quantity: 2, unitPriceSnapshot: new Decimal("12.50"), product }),
    );
    mockedPrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      const tx = { cart: { upsert: cartUpsert }, cartItem: { upsert: cartItemUpsert } };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });

    const result = await cartService.addItem("user_001", "product_001", 2);

    // Cart-level upsert keyed on userId (D3)
    expect(cartUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user_001" } }),
    );
    // Item-level upsert: CREATE branch snapshots the live price
    expect(cartItemUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cart_product_unique: { cartId: "cart_001", productId: "product_001" } },
        create: expect.objectContaining({ quantity: 2, unitPriceSnapshot: product.price }),
      }),
    );
    expect(result.unitPriceSnapshot).toBe("12.50");
    expect(result.quantity).toBe(2);
  });
});

describe("cartService.addItem — re-add preserves original snapshot [A2]", () => {
  it("[A2] re-adding an existing product increments quantity via UPDATE branch without touching unitPriceSnapshot", async () => {
    // Live price has drifted to 15.00, but the UPDATE branch must not reference it.
    const product = makeProduct({ price: new Decimal("15.00"), stock: 10 });
    mockedProductFindUnique.mockResolvedValueOnce(product);

    const cartUpsert = vi.fn().mockResolvedValue({ id: "cart_001", userId: "user_001" });
    const cartItemUpsert = vi.fn().mockResolvedValue(
      makeCartItem({ quantity: 5, unitPriceSnapshot: new Decimal("12.50"), product }),
    );
    mockedPrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      const tx = { cart: { upsert: cartUpsert }, cartItem: { upsert: cartItemUpsert } };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });

    const result = await cartService.addItem("user_001", "product_001", 3);

    const call = cartItemUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    // UPDATE branch must NOT include unitPriceSnapshot (NFR-2 immutability)
    expect(call.update).not.toHaveProperty("unitPriceSnapshot");
    expect(call.update).toEqual(expect.objectContaining({ quantity: { increment: 3 } }));
    // Result reflects the preserved (pre-drift) snapshot, not the live drifted price
    expect(result.unitPriceSnapshot).toBe("12.50");
  });
});

describe("cartService.addItem — validation error branches [A3][A4][A5]", () => {
  it("[A3] unknown productId → NotFoundError, no $transaction opened", async () => {
    mockedProductFindUnique.mockResolvedValueOnce(null);

    await expect(cartService.addItem("user_001", "missing_product", 1)).rejects.toThrow(
      NotFoundError,
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("[A4] Product.isActive = false → ProductInactiveError (409), no $transaction opened", async () => {
    mockedProductFindUnique.mockResolvedValueOnce(
      makeProduct({ isActive: false }),
    );

    const err = await cartService
      .addItem("user_001", "product_001", 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductInactiveError);
    expect((err as ProductInactiveError).status).toBe(409);
    expect((err as ProductInactiveError).code).toBe("PRODUCT_INACTIVE");
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("[A5] quantity > Product.stock → QuantityExceedsStockError (422), no $transaction opened", async () => {
    mockedProductFindUnique.mockResolvedValueOnce(
      makeProduct({ stock: 3, isActive: true }),
    );

    const err = await cartService
      .addItem("user_001", "product_001", 5)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuantityExceedsStockError);
    expect((err as QuantityExceedsStockError).status).toBe(422);
    expect((err as QuantityExceedsStockError).code).toBe("QUANTITY_EXCEEDS_STOCK");
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("cartService.addItem — NFR-3 no find-then-create [A6]", () => {
  it("[A6] never calls cart.findUnique — cart identity is established via upsert only", async () => {
    const product = makeProduct({ isActive: true, stock: 10 });
    mockedProductFindUnique.mockResolvedValueOnce(product);

    const cartUpsert = vi.fn().mockResolvedValue({ id: "cart_001", userId: "user_001" });
    const cartItemUpsert = vi.fn().mockResolvedValue(makeCartItem({ product }));
    mockedPrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      const tx = { cart: { upsert: cartUpsert }, cartItem: { upsert: cartItemUpsert } };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });

    await cartService.addItem("user_001", "product_001", 1);

    expect(mockedPrisma.cart.findUnique).not.toHaveBeenCalled();
  });
});
