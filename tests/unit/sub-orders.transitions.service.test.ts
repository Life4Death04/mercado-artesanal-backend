/**
 * Unit tests — sub-orders service transition (state machine) path (Slice 8, Commit B RED).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic for the state machine:
 *   - valid transitions update the row
 *   - invalid transitions throw InvalidOrderTransitionError (409)
 *   - idempotent no-op does NOT call update (SQL no-update assertion)
 *   - terminal state transitions are rejected
 *
 * Note: trackingNumber rejection is covered at the DTO level (integration test [SO-T4]).
 * The service itself never sees the trackingNumber field because the controller's
 * validateBody(PatchSubOrderBodySchema) rejects it before calling service.transition().
 *
 * Scenarios covered (specs: order-fulfillment):
 *
 * transition — valid:
 *   - pending → preparing succeeds (200)
 *   - preparing → sent succeeds (200)
 *   - sent → delivered succeeds (200)
 *   - pending → cancelled succeeds (200)
 *   - preparing → cancelled succeeds (200)
 *
 * transition — idempotent:
 *   - preparing → preparing: returns current row WITHOUT calling tx.subOrder.update
 *     (SQL no-update assertion per spec §"Idempotent no-op does not touch the row")
 *
 * transition — invalid:
 *   - pending → delivered throws InvalidOrderTransitionError (409)
 *   - sent → preparing throws InvalidOrderTransitionError (409)
 *   - delivered → any throws InvalidOrderTransitionError (409) — terminal state
 *   - cancelled → any throws InvalidOrderTransitionError (409) — terminal state
 *
 * transition — 404:
 *   - throws NotFoundError when SubOrder not owned by producer (cross-producer)
 *   - throws NotFoundError when SubOrder id does not exist
 *
 * Spec references:
 *   order-fulfillment §"State machine"
 *   order-fulfillment scenario "Valid transition succeeds"
 *   order-fulfillment scenario "Invalid transition rejected"
 *   order-fulfillment §"Idempotent transitions"
 *   order-fulfillment scenario "Idempotent no-op does not touch the row"
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
import { InvalidOrderTransitionError, NotFoundError } from "@/shared/errors/errors";
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
    ...overrides,
  };
}

/**
 * Wire prisma.$transaction for a transition: findFirst returns `current`,
 * update returns `updated` (or current if not provided).
 * Returns the mockUpdate spy so callers can assert it was or wasn't called.
 */
function mockTransaction(
  current: ReturnType<typeof makeSubOrder> | null,
  updated?: ReturnType<typeof makeSubOrder>,
): ReturnType<typeof vi.fn> {
  const mockUpdate = vi.fn().mockResolvedValue(updated ?? current);
  mockedPrisma.$transaction.mockImplementationOnce(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const fakeTx = {
        subOrder: {
          findFirst: vi.fn().mockResolvedValue(current),
          update: mockUpdate,
        },
      };
      return fn(fakeTx as unknown as typeof prisma);
    },
  );
  return mockUpdate;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// transition — valid transitions
// ===========================================================================

describe("subOrdersService.transition — valid transitions", () => {
  it("transitions pending → preparing and returns updated SubOrder", async () => {
    // Spec scenario: "Valid transition succeeds"
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    const updated = makeSubOrder({ status: "preparing" as SubOrderStatus });
    const mockUpdate = mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    expect(result.status).toBe("preparing");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "so_001" },
      data: { status: "preparing" },
    });
  });

  it("transitions preparing → sent", async () => {
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus });
    const updated = makeSubOrder({ status: "sent" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "sent" });

    expect(result.status).toBe("sent");
  });

  it("transitions sent → delivered", async () => {
    const current = makeSubOrder({ status: "sent" as SubOrderStatus });
    const updated = makeSubOrder({ status: "delivered" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "delivered" });

    expect(result.status).toBe("delivered");
  });

  it("transitions pending → cancelled", async () => {
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    const updated = makeSubOrder({ status: "cancelled" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "cancelled" });

    expect(result.status).toBe("cancelled");
  });

  it("transitions preparing → cancelled", async () => {
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus });
    const updated = makeSubOrder({ status: "cancelled" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "cancelled" });

    expect(result.status).toBe("cancelled");
  });
});

// ===========================================================================
// transition — idempotent no-op
// ===========================================================================

describe("subOrdersService.transition — idempotent no-op", () => {
  it("returns current row WITHOUT calling update when target === current status (preparing → preparing)", async () => {
    // Spec: order-fulfillment §"Idempotent transitions"
    // Spec scenario: "Idempotent no-op does not touch the row"
    // "The service MUST NOT issue any UPDATE to the row; updatedAt MUST remain unchanged."
    // SQL no-update assertion: mockUpdate spy must NOT be called.
    const t0 = new Date("2026-01-15T10:00:00Z");
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus, updatedAt: t0 });
    const mockUpdate = mockTransaction(current);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    // Returns the current row unchanged
    expect(result.status).toBe("preparing");
    expect(result.updatedAt).toEqual(t0);
    // SQL no-update assertion: update MUST NOT have been called
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// transition — invalid transitions
// ===========================================================================

describe("subOrdersService.transition — invalid transitions", () => {
  it("throws InvalidOrderTransitionError when transitioning pending → delivered", async () => {
    // Spec scenario: "Invalid transition rejected"
    // pending→delivered skips intermediate states → INVALID
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "delivered" }),
    ).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("throws InvalidOrderTransitionError when transitioning sent → preparing (backwards)", async () => {
    // Backwards transition is not allowed
    const current = makeSubOrder({ status: "sent" as SubOrderStatus });
    mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "preparing" }),
    ).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("throws InvalidOrderTransitionError when SubOrder is in terminal state 'delivered'", async () => {
    // delivered is terminal — no further transitions
    const current = makeSubOrder({ status: "delivered" as SubOrderStatus });
    mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "cancelled" }),
    ).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("throws InvalidOrderTransitionError when SubOrder is in terminal state 'cancelled'", async () => {
    // cancelled is terminal — no further transitions
    const current = makeSubOrder({ status: "cancelled" as SubOrderStatus });
    mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "preparing" }),
    ).rejects.toThrow(InvalidOrderTransitionError);
  });
});

// ===========================================================================
// transition — 404 no-leak
// ===========================================================================

describe("subOrdersService.transition — 404 no-leak", () => {
  it("throws NotFoundError when SubOrder belongs to another producer (cross-producer)", async () => {
    mockTransaction(null);

    await expect(
      subOrdersService.transition("prod_attacker", "so_001", { status: "preparing" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when SubOrder id does not exist", async () => {
    mockTransaction(null);

    await expect(
      subOrdersService.transition("prod_001", "nonexistent_id", { status: "preparing" }),
    ).rejects.toThrow(NotFoundError);
  });
});
