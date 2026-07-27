/**
 * Unit tests — orders.service (Cycle 4 orders WU2, RED phase).
 *
 * Strategy: mock `@/shared/utils/prisma` (harness for future WU3 read-surface
 * functions — not used by WU2's `createOrderFromPayment`, which runs entirely
 * on the caller-supplied `tx`) and mock `@/modules/inventory/services/inventory.service`
 * so `decrementStock` is an observable spy (design Testing Strategy: "spy
 * restockProduct/decrementStock").
 *
 * WU2 scenarios covered (design Decision 2 + Decision 4, spec §ADDED requirements):
 *   deriveOrderStatus:
 *     [DS1] all pending -> PENDING
 *     [DS2] all delivered -> FULFILLED
 *     [DS3] all cancelled -> CANCELLED
 *     [DS4] mixed (delivered + cancelled) -> PARTIAL
 *     [DS5] empty array -> throws (not a silent default)
 *   createOrderFromPayment:
 *     [CO-IDEMP] existing Payment+Order for stripeIntentId -> returns mapped view, no writes
 *     [CO-EMPTY] empty cartView.items -> EmptyCartCheckoutError, no tx calls
 *     [CO-SNAPSHOT-UNAVAIL] snapshot isAvailable=false fast-fail -> CartItemNotAvailableError, no live query
 *     [CO-INCOMPLETE] live findMany returns fewer rows than checkoutedCartItemIds -> CartItemNotAvailableError
 *     [CO-LIVE-UNAVAIL] live re-check finds inactive product -> CartItemNotAvailableError, no writes
 *     [CO-SEL-MISSING] deliverySelections missing a cart producerId -> ValidationFailedError
 *     [CO-SEL-EXTRA] deliverySelections has an unknown producerId -> ValidationFailedError
 *     [CO-SEL-UNRESOLVED] deliveryModeId does not resolve in selectedModes -> ValidationFailedError
 *     [CO-SEL-MISMATCH] resolved DeliveryMode.producerId != selection.producerId -> ValidationFailedError
 *     [CO-SEL-INACTIVE] resolved DeliveryMode.isActive = false -> ValidationFailedError
 *     [CO-ORDER] exact D4 step order: payment.findUnique -> cartItem.findMany ->
 *                deliveryMode.findMany -> payment.create -> order.create ->
 *                subOrder.create(xN) -> orderLine.create(xN) -> decrementStock(xN) -> cartItem.deleteMany
 *     [CO-DECIMAL] total = Σ(unitPriceSnapshot*qty) + Σ shippingByProducer, computed with Prisma.Decimal
 *     [CO-MAPS] shippingCostSnapshot/deliveryModeId per SubOrder come from the step-3a maps;
 *               OrderLine.subOrderId resolves via the step-6 subOrderIdByProducer map
 *     [CO-SNAPSHOT-LINE] OrderLine.unitPriceSnapshot copied AS-IS from cartView.items, not live price
 *     [CO-P2002] payment.create throws P2002 -> bubbles UNCAUGHT, order.create never called
 *
 * Spec references:
 *   orders §"createOrderFromPayment writes the order aggregate atomically"
 *   orders §"Checkout enforces all-or-nothing availability"
 *   orders §"Order.status is derived, never set directly"
 *   design Decision 2 (deriveOrderStatus), Decision 4 (createOrderFromPayment internals)
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma singleton (harness for future WU3 read-surface exports —
// createOrderFromPayment itself never touches the singleton, only the
// caller-supplied `tx`). Pattern matches cart.service.test.ts / inventory.service.test.ts.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock inventory service — decrementStock is a pure spy (frozen contract,
// design Testing Strategy: "spy restockProduct/decrementStock").
// ---------------------------------------------------------------------------
vi.mock("@/modules/inventory/services/inventory.service", () => ({
  decrementStock: vi.fn(),
}));

import { decrementStock } from "@/modules/inventory/services/inventory.service";
import {
  CartItemNotAvailableError,
  EmptyCartCheckoutError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import type { CartForCheckout, CartItemForCheckout } from "@/modules/cart/services/cart.service";
// Service import — behavioral exports populated by WU2
import * as ordersService from "@/modules/orders/services/orders.service";

const mockedDecrementStock = vi.mocked(decrementStock);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCartItemForCheckout(overrides: Partial<CartItemForCheckout> = {}): CartItemForCheckout {
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

/** Live cartItem.findMany row shape — mirrors the nested Prisma include used in step 2. */
function makeLiveCartItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_001",
    productId: "product_001",
    quantity: 2,
    unitPriceSnapshot: new Prisma.Decimal("5.00"),
    product: {
      id: "product_001",
      isActive: true,
      deletedAt: null,
      producer: { id: "producer_A", deletedAt: null },
    },
    ...overrides,
  };
}

function makeDeliveryModeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dm_A",
    producerId: "producer_A",
    cost: new Prisma.Decimal("2.00"),
    isActive: true,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockTx(overrides: Record<string, any> = {}) {
  let orderLineSeq = 0;
  return {
    payment: {
      findUnique: vi.fn().mockResolvedValue(null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: "payment_001",
        status: data.status,
        amount: data.amount,
        providerRef: data.providerRef,
      })),
    },
    order: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: "order_001",
        userId: data.userId,
        paymentId: data.paymentId,
        totalAmount: data.totalAmount,
        createdAt: new Date("2026-07-27T10:00:00Z"),
      })),
    },
    subOrder: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `subOrder_${data.producerId}`,
        orderId: data.orderId,
        producerId: data.producerId,
        deliveryModeId: data.deliveryModeId,
        shippingCostSnapshot: data.shippingCostSnapshot,
        status: "pending",
      })),
    },
    orderLine: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `orderLine_${++orderLineSeq}`,
        subOrderId: data.subOrderId,
        productId: data.productId,
        quantity: data.quantity,
        unitPriceSnapshot: data.unitPriceSnapshot,
      })),
    },
    deliveryMode: {
      findMany: vi.fn().mockResolvedValue([makeDeliveryModeRow()]),
    },
    cartItem: {
      findMany: vi.fn().mockResolvedValue([makeLiveCartItemRow()]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// deriveOrderStatus — pure function, table-tested (design Decision 2)
// ===========================================================================

describe("ordersService.deriveOrderStatus", () => {
  it("[DS1] all pending -> PENDING", () => {
    expect(ordersService.deriveOrderStatus(["pending", "pending"])).toBe("PENDING");
  });

  it("[DS2] all delivered -> FULFILLED", () => {
    expect(ordersService.deriveOrderStatus(["delivered", "delivered"])).toBe("FULFILLED");
  });

  it("[DS3] all cancelled -> CANCELLED", () => {
    expect(ordersService.deriveOrderStatus(["cancelled", "cancelled"])).toBe("CANCELLED");
  });

  it("[DS4] mixed statuses (delivered + cancelled) -> PARTIAL", () => {
    expect(ordersService.deriveOrderStatus(["delivered", "cancelled"])).toBe("PARTIAL");
  });

  it("[DS4b] mixed statuses (pending + preparing) -> PARTIAL", () => {
    expect(ordersService.deriveOrderStatus(["pending", "preparing"])).toBe("PARTIAL");
  });

  it("[DS5] empty array throws — not a silent default", () => {
    expect(() => ordersService.deriveOrderStatus([])).toThrow();
  });
});

// ===========================================================================
// createOrderFromPayment — atomic checkout write contract (design Decision 4)
// ===========================================================================

describe("ordersService.createOrderFromPayment — idempotency pre-check [CO-IDEMP]", () => {
  it("[CO-IDEMP] returns the existing OrderDetailView when providerRef already recorded, no writes issued", async () => {
    const existingOrder = {
      id: "order_existing",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      totalAmount: new Prisma.Decimal("12.00"),
      subOrders: [
        {
          id: "subOrder_existing",
          producerId: "producer_A",
          status: "pending",
          shippingCostSnapshot: new Prisma.Decimal("2.00"),
          deliveryModeId: "dm_A",
          orderLines: [
            {
              id: "line_existing",
              productId: "product_001",
              quantity: 2,
              unitPriceSnapshot: new Prisma.Decimal("5.00"),
            },
          ],
        },
      ],
    };
    const tx = makeMockTx();
    tx.payment.findUnique.mockResolvedValueOnce({
      id: "payment_existing",
      status: "SUCCEEDED",
      order: existingOrder,
    });

    const cartView = makeCartView([makeCartItemForCheckout()]);
    const result = await ordersService.createOrderFromPayment(
      "pi_123",
      cartView,
      [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
      tx,
    );

    expect(result.id).toBe("order_existing");
    expect(result.status).toBe("PENDING");
    expect(result.payment.status).toBe("SUCCEEDED");
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
  });
});

describe("ordersService.createOrderFromPayment — empty cart rejection [CO-EMPTY]", () => {
  it("[CO-EMPTY] throws EmptyCartCheckoutError for zero items, no writes issued", async () => {
    const tx = makeMockTx();
    const cartView = makeCartView([]);

    await expect(
      ordersService.createOrderFromPayment("pi_123", cartView, [], tx),
    ).rejects.toThrow(EmptyCartCheckoutError);
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
  });
});

describe("ordersService.createOrderFromPayment — availability gates [CO-SNAPSHOT-UNAVAIL][CO-INCOMPLETE][CO-LIVE-UNAVAIL]", () => {
  it("[CO-SNAPSHOT-UNAVAIL] snapshot isAvailable=false fast-fails before the live query", async () => {
    const tx = makeMockTx();
    const cartView = makeCartView([makeCartItemForCheckout({ isAvailable: false })]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toThrow(CartItemNotAvailableError);
    expect(tx.cartItem.findMany).not.toHaveBeenCalled();
  });

  it("[CO-INCOMPLETE] live findMany returning fewer rows than checkoutedCartItemIds throws CartItemNotAvailableError", async () => {
    const tx = makeMockTx({
      cartItem: {
        findMany: vi.fn().mockResolvedValue([]), // item removed before webhook delivery
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const cartView = makeCartView([makeCartItemForCheckout()]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toThrow(CartItemNotAvailableError);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("[CO-LIVE-UNAVAIL] live re-check finds an inactive product, all-or-nothing rejection, no writes", async () => {
    const tx = makeMockTx({
      cartItem: {
        findMany: vi.fn().mockResolvedValue([makeLiveCartItemRow({ product: { ...makeLiveCartItemRow().product, isActive: false } })]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const cartView = makeCartView([makeCartItemForCheckout()]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toThrow(CartItemNotAvailableError);
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(mockedDecrementStock).not.toHaveBeenCalled();
  });
});

describe("ordersService.createOrderFromPayment — deliverySelections validation [CO-SEL-*]", () => {
  it("[CO-SEL-MISSING] missing a cart producerId in deliverySelections -> ValidationFailedError", async () => {
    const tx = makeMockTx();
    const cartView = makeCartView([makeCartItemForCheckout({ producerId: "producer_A" })]);

    await expect(
      ordersService.createOrderFromPayment("pi_123", cartView, [], tx),
    ).rejects.toThrow(ValidationFailedError);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("[CO-SEL-EXTRA] an unknown producerId in deliverySelections -> ValidationFailedError", async () => {
    const tx = makeMockTx();
    const cartView = makeCartView([makeCartItemForCheckout({ producerId: "producer_A" })]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [
          { producerId: "producer_A", deliveryModeId: "dm_A" },
          { producerId: "producer_UNKNOWN", deliveryModeId: "dm_X" },
        ],
        tx,
      ),
    ).rejects.toThrow(ValidationFailedError);
  });

  it("[CO-SEL-UNRESOLVED] deliveryModeId does not resolve in selectedModes -> ValidationFailedError", async () => {
    const tx = makeMockTx({ deliveryMode: { findMany: vi.fn().mockResolvedValue([]) } });
    const cartView = makeCartView([makeCartItemForCheckout({ producerId: "producer_A" })]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_missing" }],
        tx,
      ),
    ).rejects.toThrow(ValidationFailedError);
  });

  it("[CO-SEL-MISMATCH] resolved DeliveryMode.producerId != selection.producerId -> ValidationFailedError", async () => {
    const tx = makeMockTx({
      deliveryMode: {
        findMany: vi.fn().mockResolvedValue([makeDeliveryModeRow({ producerId: "producer_OTHER" })]),
      },
    });
    const cartView = makeCartView([makeCartItemForCheckout({ producerId: "producer_A" })]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toThrow(ValidationFailedError);
  });

  it("[CO-SEL-INACTIVE] resolved DeliveryMode.isActive = false -> ValidationFailedError", async () => {
    const tx = makeMockTx({
      deliveryMode: { findMany: vi.fn().mockResolvedValue([makeDeliveryModeRow({ isActive: false })]) },
    });
    const cartView = makeCartView([makeCartItemForCheckout({ producerId: "producer_A" })]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toThrow(ValidationFailedError);
  });
});

describe("ordersService.createOrderFromPayment — exact D4 step order [CO-ORDER]", () => {
  it("[CO-ORDER] executes: payment.findUnique -> cartItem.findMany -> deliveryMode.findMany -> payment.create -> order.create -> subOrder.create(xN) -> orderLine.create(xN) -> decrementStock(xN) -> cartItem.deleteMany", async () => {
    const calls: string[] = [];

    const producerAItem = makeCartItemForCheckout({
      cartItemId: "item_A",
      productId: "product_A",
      producerId: "producer_A",
      quantity: 2,
      unitPriceSnapshot: "5.00",
    });
    const producerBItem = makeCartItemForCheckout({
      cartItemId: "item_B",
      productId: "product_B",
      producerId: "producer_B",
      quantity: 1,
      unitPriceSnapshot: "10.00",
    });

    const tx = makeMockTx();
    tx.payment.findUnique.mockImplementation(async () => {
      calls.push("payment.findUnique");
      return null;
    });
    tx.cartItem.findMany.mockImplementation(async () => {
      calls.push("cartItem.findMany");
      return [
        makeLiveCartItemRow({
          id: "item_A",
          productId: "product_A",
          product: { id: "product_A", isActive: true, deletedAt: null, producer: { id: "producer_A", deletedAt: null } },
        }),
        makeLiveCartItemRow({
          id: "item_B",
          productId: "product_B",
          product: { id: "product_B", isActive: true, deletedAt: null, producer: { id: "producer_B", deletedAt: null } },
        }),
      ];
    });
    tx.deliveryMode.findMany.mockImplementation(async () => {
      calls.push("deliveryMode.findMany");
      return [
        makeDeliveryModeRow({ id: "dm_A", producerId: "producer_A", cost: new Prisma.Decimal("2.00") }),
        makeDeliveryModeRow({ id: "dm_B", producerId: "producer_B", cost: new Prisma.Decimal("4.00") }),
      ];
    });
    const originalPaymentCreate = tx.payment.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.payment.create.mockImplementation(async (args: any) => {
      calls.push("payment.create");
      return originalPaymentCreate(args);
    });
    const originalOrderCreate = tx.order.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.order.create.mockImplementation(async (args: any) => {
      calls.push("order.create");
      return originalOrderCreate(args);
    });
    const originalSubOrderCreate = tx.subOrder.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.subOrder.create.mockImplementation(async (args: any) => {
      calls.push(`subOrder.create:${args.data.producerId}`);
      return originalSubOrderCreate(args);
    });
    const originalOrderLineCreate = tx.orderLine.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.orderLine.create.mockImplementation(async (args: any) => {
      calls.push(`orderLine.create:${args.data.productId}`);
      return originalOrderLineCreate(args);
    });
    tx.cartItem.deleteMany.mockImplementation(async () => {
      calls.push("cartItem.deleteMany");
      return { count: 2 };
    });
    mockedDecrementStock.mockImplementation(async (productId: string) => {
      calls.push(`decrementStock:${productId}`);
    });

    const cartView = makeCartView([producerAItem, producerBItem]);
    await ordersService.createOrderFromPayment(
      "pi_123",
      cartView,
      [
        { producerId: "producer_A", deliveryModeId: "dm_A" },
        { producerId: "producer_B", deliveryModeId: "dm_B" },
      ],
      tx,
    );

    expect(calls[0]).toBe("payment.findUnique");
    expect(calls[1]).toBe("cartItem.findMany");
    expect(calls[2]).toBe("deliveryMode.findMany");
    expect(calls[3]).toBe("payment.create");
    expect(calls[4]).toBe("order.create");

    const subOrderIdxA = calls.indexOf("subOrder.create:producer_A");
    const subOrderIdxB = calls.indexOf("subOrder.create:producer_B");
    const orderLineIdxA = calls.indexOf("orderLine.create:product_A");
    const orderLineIdxB = calls.indexOf("orderLine.create:product_B");
    const decrementIdxA = calls.indexOf("decrementStock:product_A");
    const decrementIdxB = calls.indexOf("decrementStock:product_B");
    const deleteManyIdx = calls.indexOf("cartItem.deleteMany");

    // subOrder creates happen before any orderLine create
    expect(Math.max(subOrderIdxA, subOrderIdxB)).toBeLessThan(Math.min(orderLineIdxA, orderLineIdxB));
    // orderLine creates happen before decrementStock calls
    expect(Math.max(orderLineIdxA, orderLineIdxB)).toBeLessThan(Math.min(decrementIdxA, decrementIdxB));
    // decrementStock calls happen before the final cart clear
    expect(Math.max(decrementIdxA, decrementIdxB)).toBeLessThan(deleteManyIdx);
    // cart clear is the LAST call
    expect(calls[calls.length - 1]).toBe("cartItem.deleteMany");

    expect(calls.filter((c) => c.startsWith("decrementStock")).length).toBe(2);
  });
});

describe("ordersService.createOrderFromPayment — Decimal totals [CO-DECIMAL]", () => {
  it("[CO-DECIMAL] total = Σ(unitPriceSnapshot*qty) + Σ shippingByProducer, computed with Prisma.Decimal", async () => {
    const producerAItem1 = makeCartItemForCheckout({
      cartItemId: "item_A1",
      productId: "product_A1",
      producerId: "producer_A",
      quantity: 2,
      unitPriceSnapshot: "5.00",
    });
    const producerAItem2 = makeCartItemForCheckout({
      cartItemId: "item_A2",
      productId: "product_A2",
      producerId: "producer_A",
      quantity: 1,
      unitPriceSnapshot: "3.00",
    });
    const producerBItem = makeCartItemForCheckout({
      cartItemId: "item_B",
      productId: "product_B",
      producerId: "producer_B",
      quantity: 1,
      unitPriceSnapshot: "10.00",
    });

    const tx = makeMockTx({
      cartItem: {
        findMany: vi.fn().mockResolvedValue([
          makeLiveCartItemRow({ id: "item_A1", productId: "product_A1", product: { id: "product_A1", isActive: true, deletedAt: null, producer: { id: "producer_A", deletedAt: null } } }),
          makeLiveCartItemRow({ id: "item_A2", productId: "product_A2", product: { id: "product_A2", isActive: true, deletedAt: null, producer: { id: "producer_A", deletedAt: null } } }),
          makeLiveCartItemRow({ id: "item_B", productId: "product_B", product: { id: "product_B", isActive: true, deletedAt: null, producer: { id: "producer_B", deletedAt: null } } }),
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
      deliveryMode: {
        findMany: vi.fn().mockResolvedValue([
          makeDeliveryModeRow({ id: "dm_A", producerId: "producer_A", cost: new Prisma.Decimal("2.00") }),
          makeDeliveryModeRow({ id: "dm_B", producerId: "producer_B", cost: new Prisma.Decimal("4.00") }),
        ]),
      },
    });

    const cartView = makeCartView([producerAItem1, producerAItem2, producerBItem]);
    const result = await ordersService.createOrderFromPayment(
      "pi_123",
      cartView,
      [
        { producerId: "producer_A", deliveryModeId: "dm_A" },
        { producerId: "producer_B", deliveryModeId: "dm_B" },
      ],
      tx,
    );

    // (5*2 + 3*1) + 2.00 shippingA = 15.00 ; (10*1) + 4.00 shippingB = 14.00 -> total 29.00
    expect(result.totalAmount).toBe("29.00");
    const paymentCreateArg = tx.payment.create.mock.calls[0]![0];
    expect(paymentCreateArg.data.amount).toBeInstanceOf(Prisma.Decimal);
    expect((paymentCreateArg.data.amount as InstanceType<typeof Prisma.Decimal>).toFixed(2)).toBe("29.00");
    const orderCreateArg = tx.order.create.mock.calls[0]![0];
    expect((orderCreateArg.data.totalAmount as InstanceType<typeof Prisma.Decimal>).toFixed(2)).toBe("29.00");
  });
});

describe("ordersService.createOrderFromPayment — maps for shipping/deliveryMode/subOrderId [CO-MAPS]", () => {
  it("[CO-MAPS] SubOrder rows use shippingByProducer/deliveryModeByProducer; OrderLine rows resolve subOrderId via subOrderIdByProducer", async () => {
    const producerAItem = makeCartItemForCheckout({
      cartItemId: "item_A",
      productId: "product_A",
      producerId: "producer_A",
      quantity: 2,
      unitPriceSnapshot: "5.00",
    });
    const producerBItem = makeCartItemForCheckout({
      cartItemId: "item_B",
      productId: "product_B",
      producerId: "producer_B",
      quantity: 1,
      unitPriceSnapshot: "10.00",
    });

    const tx = makeMockTx({
      cartItem: {
        findMany: vi.fn().mockResolvedValue([
          makeLiveCartItemRow({ id: "item_A", productId: "product_A", product: { id: "product_A", isActive: true, deletedAt: null, producer: { id: "producer_A", deletedAt: null } } }),
          makeLiveCartItemRow({ id: "item_B", productId: "product_B", product: { id: "product_B", isActive: true, deletedAt: null, producer: { id: "producer_B", deletedAt: null } } }),
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      deliveryMode: {
        findMany: vi.fn().mockResolvedValue([
          makeDeliveryModeRow({ id: "dm_A", producerId: "producer_A", cost: new Prisma.Decimal("2.00") }),
          makeDeliveryModeRow({ id: "dm_B", producerId: "producer_B", cost: new Prisma.Decimal("4.00") }),
        ]),
      },
    });

    const cartView = makeCartView([producerAItem, producerBItem]);
    const result = await ordersService.createOrderFromPayment(
      "pi_123",
      cartView,
      [
        { producerId: "producer_A", deliveryModeId: "dm_A" },
        { producerId: "producer_B", deliveryModeId: "dm_B" },
      ],
      tx,
    );

    // subOrder.create called once per producer, with the correct shipping/deliveryMode from the maps
    expect(tx.subOrder.create).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subOrderCallA = tx.subOrder.create.mock.calls.find((c: any) => c[0].data.producerId === "producer_A")![0];
    expect(subOrderCallA.data.deliveryModeId).toBe("dm_A");
    expect((subOrderCallA.data.shippingCostSnapshot as InstanceType<typeof Prisma.Decimal>).toFixed(2)).toBe("2.00");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subOrderCallB = tx.subOrder.create.mock.calls.find((c: any) => c[0].data.producerId === "producer_B")![0];
    expect(subOrderCallB.data.deliveryModeId).toBe("dm_B");
    expect((subOrderCallB.data.shippingCostSnapshot as InstanceType<typeof Prisma.Decimal>).toFixed(2)).toBe("4.00");

    // Response maps each SubOrder to its own producer's orderLines only
    const subOrderViewA = result.subOrders.find((s) => s.producerId === "producer_A")!;
    const subOrderViewB = result.subOrders.find((s) => s.producerId === "producer_B")!;
    expect(subOrderViewA.orderLines).toHaveLength(1);
    expect(subOrderViewA.orderLines[0]!.productId).toBe("product_A");
    expect(subOrderViewB.orderLines).toHaveLength(1);
    expect(subOrderViewB.orderLines[0]!.productId).toBe("product_B");

    // OrderLine.create was called with the subOrderId belonging to the SAME producer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderLineCallA = tx.orderLine.create.mock.calls.find((c: any) => c[0].data.productId === "product_A")![0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderLineCallB = tx.orderLine.create.mock.calls.find((c: any) => c[0].data.productId === "product_B")![0];
    expect(orderLineCallA.data.subOrderId).toBe(subOrderViewA.id);
    expect(orderLineCallB.data.subOrderId).toBe(subOrderViewB.id);
  });
});

describe("ordersService.createOrderFromPayment — snapshot line mapping [CO-SNAPSHOT-LINE]", () => {
  it("[CO-SNAPSHOT-LINE] OrderLine.unitPriceSnapshot copies cartView.items[i].unitPriceSnapshot AS-IS, not any live value", async () => {
    // Live re-check row deliberately carries a DIFFERENT unitPriceSnapshot (simulating drift) —
    // the created OrderLine must still reflect the FROZEN cart snapshot value.
    const tx = makeMockTx({
      cartItem: {
        findMany: vi.fn().mockResolvedValue([
          makeLiveCartItemRow({ unitPriceSnapshot: new Prisma.Decimal("999.99") }),
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const cartView = makeCartView([
      makeCartItemForCheckout({ unitPriceSnapshot: "5.00", quantity: 2 }),
    ]);

    const result = await ordersService.createOrderFromPayment(
      "pi_123",
      cartView,
      [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
      tx,
    );

    const orderLineCreateArg = tx.orderLine.create.mock.calls[0]![0];
    expect((orderLineCreateArg.data.unitPriceSnapshot as InstanceType<typeof Prisma.Decimal>).toFixed(2)).toBe("5.00");
    expect(result.subOrders[0]!.orderLines[0]!.unitPriceSnapshot).toBe("5.00");
  });
});

describe("ordersService.createOrderFromPayment — P2002 bubbles uncaught [CO-P2002]", () => {
  it("[CO-P2002] payment.create P2002 propagates uncaught, order.create is never called", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const tx = makeMockTx({
      payment: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue(p2002),
      },
    });

    const cartView = makeCartView([makeCartItemForCheckout()]);

    await expect(
      ordersService.createOrderFromPayment(
        "pi_123",
        cartView,
        [{ producerId: "producer_A", deliveryModeId: "dm_A" }],
        tx,
      ),
    ).rejects.toBe(p2002);

    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.subOrder.create).not.toHaveBeenCalled();
    expect(mockedDecrementStock).not.toHaveBeenCalled();
  });
});
