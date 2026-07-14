/**
 * Unit tests — sub-orders service read path (Slice 8, Commit A RED).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic: producer-scoped ownership
 * enforcement, status filter forwarding, and 404-no-leak on cross-producer read.
 *
 * Scenarios covered (specs: order-fulfillment):
 *
 * findAll:
 *   - returns SubOrders owned by producer (no filter)
 *   - forwards status filter to prisma query when provided
 *   - returns empty array when producer has no SubOrders
 *
 * findById:
 *   - returns SubOrder with orderLines when owned by producer
 *   - throws SubOrderNotFoundError when SubOrder belongs to another producer (404-no-leak)
 *   - throws SubOrderNotFoundError when id does not exist (404-no-leak)
 *
 * Spec references:
 *   order-fulfillment §"Producer read of own SubOrders"
 *   order-fulfillment scenario "Filter by status"
 *   order-fulfillment scenario "Cross-producer read returns 404"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      subOrder: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
    },
  };
});

import type { SubOrderStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import { NotFoundError } from "@/shared/errors/errors";
import * as subOrdersService from "@/modules/sub-orders/services/sub-orders.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "so_001",
    orderId: "order_001",
    producerId: "prod_001",
    deliveryModeId: "dm_001",
    status: "pending" as SubOrderStatus,
    shippingCostSnapshot: new Decimal("5.00"),
    trackingNumber: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    orderLines: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// findAll
// ===========================================================================

describe("subOrdersService.findAll", () => {
  it("returns SubOrders owned by producer when no status filter given", async () => {
    const so1 = makeSubOrder({ id: "so_001", status: "pending" as SubOrderStatus });
    const so2 = makeSubOrder({ id: "so_002", status: "sent" as SubOrderStatus });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findMany.mockResolvedValueOnce([so1, so2]);

    const result = await subOrdersService.findAll("prod_001");

    expect(result).toHaveLength(2);
    expect(result[0]!.producerId).toBe("prod_001");
    expect(result[1]!.producerId).toBe("prod_001");
  });

  it("forwards status filter to prisma when provided — returns only matching SubOrders", async () => {
    // Spec: order-fulfillment scenario "Filter by status"
    // Given P1 owns S1(pending), S2(sent), S3(delivered)
    // When P1 calls with status=sent → only S2 returned
    const sentOrder = makeSubOrder({ id: "so_002", status: "sent" as SubOrderStatus });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findMany.mockResolvedValueOnce([sentOrder]);

    const result = await subOrdersService.findAll("prod_001", { status: "sent" });

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("sent");
    // Verify the mock was called with a filter that includes status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = (mockedPrisma.subOrder as any).findMany.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect((callArgs.where as Record<string, unknown>).status).toBe("sent");
  });

  it("returns empty array when producer has no SubOrders", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findMany.mockResolvedValueOnce([]);

    const result = await subOrdersService.findAll("prod_002");

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// findById
// ===========================================================================

describe("subOrdersService.findById", () => {
  it("returns SubOrder with orderLines when owned by producer", async () => {
    const so = makeSubOrder({
      orderLines: [
        {
          id: "ol_001",
          subOrderId: "so_001",
          productId: "prod_item_001",
          quantity: 2,
          unitPriceSnapshot: new Decimal("10.00"),
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findFirst.mockResolvedValueOnce(so);

    const result = await subOrdersService.findById("prod_001", "so_001");

    expect(result.id).toBe("so_001");
    expect(result.producerId).toBe("prod_001");
    expect(result.orderLines).toHaveLength(1);
  });

  it("throws NotFoundError when SubOrder belongs to another producer (404-no-leak)", async () => {
    // Spec: order-fulfillment scenario "Cross-producer read returns 404"
    // Service uses findFirst({ where: { id, producerId } }) → null for wrong producer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findFirst.mockResolvedValueOnce(null);

    await expect(
      subOrdersService.findById("prod_attacker", "so_001"),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when SubOrder id does not exist (404-no-leak)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.subOrder as any).findFirst.mockResolvedValueOnce(null);

    await expect(
      subOrdersService.findById("prod_001", "nonexistent_id"),
    ).rejects.toThrow(NotFoundError);
  });
});
