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
 * trackingNumber gate (order-fulfillment MODIFIED — "Tracking number on shipment"):
 * the service enforces the tracking rules itself (design Decision #1) using the
 * `deliveryMode.type` loaded alongside the ownership `findFirst`. The gate runs
 * BEFORE the idempotent same-status no-op early-return (design Decision #3).
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
 * transition — trackingNumber gate:
 *   - PICKUP sub-order + trackingNumber → ValidationFailedError (422)
 *   - shipping sub-order entering "sent" without trackingNumber → ValidationFailedError (422)
 *   - trackingNumber present on a non-"sent" target → ValidationFailedError (422)
 *   - already-set trackingNumber cannot be overwritten → ValidationFailedError (422)
 *   - same-status "sent → sent" no-op with trackingNumber → ValidationFailedError (422),
 *     gate runs BEFORE the no-op early-return (update MUST NOT be called)
 *   - valid shipping sub-order entering "sent" persists trackingNumber in the update payload
 *
 * transition — notification emission (Cycle 5 notifications, Phase 5):
 *   - a valid transition emits SUBORDER_STATUS_CHANGED to order.userId
 *   - entering "sent" with a trackingNumber ALSO emits TRACKING_ASSIGNED (both, in order)
 *   - the idempotent no-op (Phase 5's "no-op-no-dup") creates NO notification
 *
 * Spec references:
 *   order-fulfillment §"State machine"
 *   order-fulfillment scenario "Valid transition succeeds"
 *   order-fulfillment scenario "Invalid transition rejected"
 *   order-fulfillment §"Idempotent transitions"
 *   order-fulfillment scenario "Idempotent no-op does not touch the row"
 *   order-fulfillment §"Tracking number on shipment" (MODIFIED)
 *   order-fulfillment scenario "Shipping sub-order transitions to sent with a valid trackingNumber"
 *   order-fulfillment scenario "Shipping sub-order to sent without trackingNumber rejected"
 *   order-fulfillment scenario "PICKUP sub-order rejects trackingNumber"
 *   order-fulfillment scenario "Already-set trackingNumber cannot be overwritten"
 *   order-fulfillment scenario "trackingNumber rejected on a non-sent transition"
 *   order-fulfillment scenario "Same-status no-op cannot set trackingNumber"
 *   sdd/notifications/spec §"Sub-order status change and tracking notify the consumer"
 *   sdd/notifications/spec §"Replayed event does not duplicate" (no-op path)
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

// ---------------------------------------------------------------------------
// Mock notifications service (Cycle 5 notifications Phase 5) — the fake `tx`
// built by `mockTransaction()` below has no `tx.notification` delegate, so
// the REAL `createNotification` (which calls `tx.notification.create`)
// would crash against it. This file proves the state-machine + emission
// CALL-SITE logic (which type, to which userId, in what order); the actual
// write is proven separately by `notifications.service.ts`'s own suite and
// the end-to-end HTTP path in `tests/integration/sub-orders.transitions.test.ts`.
// ---------------------------------------------------------------------------
vi.mock("@/modules/notifications/services/notifications.service", () => ({
  createNotification: vi.fn(),
}));

import type { SubOrderStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import * as notificationsService from "@/modules/notifications/services/notifications.service";
import {
  InvalidOrderTransitionError,
  NotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import * as subOrdersService from "@/modules/sub-orders/services/sub-orders.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
const mockedCreateNotification = vi.mocked(notificationsService.createNotification);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Owning Consumer's userId, shared across fixtures below (Cycle 5 notifications recipient). */
const OWNER_USER_ID = "user_001";
const OWNER_EMAIL = "owner@example.com";

function makeSubOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "so_001",
    orderId: "order_001",
    producerId: "prod_001",
    deliveryModeId: "dm_001",
    status: "pending" as SubOrderStatus,
    shippingCostSnapshot: new Decimal("5.00"),
    trackingNumber: null,
    shipToLine1: null,
    shipToLine2: null,
    shipToCity: null,
    shipToPostalCode: null,
    shipToProvince: null,
    shipToCountry: null,
    // order-public-numbers Phase 4 (PR 3) — subOrderNumber is a raw column.
    subOrderNumber: 4,
    deliveryMode: { type: "SHIPPING_FLAT_RATE" },
    // Cycle 5 notifications (design "Emission wiring", Phase 5): the step-1
    // findFirst now includes `order: { select: { userId: true, orderNumber:
    // true } } }` — `userId` is the emission recipient (never propagated to
    // the response), `orderNumber` (order-public-numbers Phase 4) is
    // propagated to `subOrder.order.orderNumber`. `Order.userId` is a bare
    // column (no Prisma `user` relation), so this fixture mirrors ONLY the
    // fields the service reads.
    order: { userId: OWNER_USER_ID, orderNumber: 9 },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Wire prisma.$transaction for a transition: findFirst returns `current`,
 * update returns `updated` (or current if not provided). `tx.user.findUnique`
 * resolves the Cycle 5 notifications recipient email.
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
        user: {
          findUnique: vi.fn().mockResolvedValue({ email: OWNER_EMAIL }),
        },
      };
      return fn(fakeTx as unknown as typeof prisma);
    },
  );
  return mockUpdate;
}

beforeEach(() => {
  vi.resetAllMocks();
  // Cycle 5 notifications: re-establish the default resolved value lost by
  // resetAllMocks() above (module-factory mocks are reset to a bare vi.fn()).
  mockedCreateNotification.mockResolvedValue({
    to: OWNER_EMAIL,
    subject: "mock subject",
    body: "mock body",
  });
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

    expect(result.subOrder.status).toBe("preparing");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "so_001" },
      data: { status: "preparing" },
    });
  });

  it("[SO-VIEW-5] maps the successful-update path to subOrderNumber + order.orderNumber, no order.userId", async () => {
    // Spec: order-fulfillment §"Producer public reference responses" (ADDED)
    // scenario "Transition returns the same contract" — P1 owns S1(#4) under
    // an order.orderNumber that MUST survive a valid transition.
    const current = makeSubOrder({
      status: "pending" as SubOrderStatus,
      subOrderNumber: 4,
      order: { userId: OWNER_USER_ID, orderNumber: 9 },
    });
    const updated = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      subOrderNumber: 4,
    });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    expect(result.subOrder.subOrderNumber).toBe(4);
    expect(result.subOrder.order).toEqual({ orderNumber: 9 });
    expect(result.subOrder).not.toHaveProperty("order.userId");
    expect(Object.keys(result.subOrder.order)).toEqual(["orderNumber"]);
  });

  it("transitions preparing → sent (PICKUP — no trackingNumber required)", async () => {
    // PICKUP sub-orders never require trackingNumber (order-fulfillment MODIFIED).
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });
    const updated = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "sent" });

    expect(result.subOrder.status).toBe("sent");
  });

  it("transitions PERSONAL_DELIVERY preparing → sent without trackingNumber", async () => {
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PERSONAL_DELIVERY" },
    });
    const updated = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "PERSONAL_DELIVERY" },
    });
    const mockUpdate = mockTransaction(current, updated);

    await subOrdersService.transition("prod_001", "so_001", { status: "sent" });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "so_001" },
      data: { status: "sent" },
    });
  });

  it("transitions sent → delivered", async () => {
    const current = makeSubOrder({ status: "sent" as SubOrderStatus });
    const updated = makeSubOrder({ status: "delivered" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "delivered" });

    expect(result.subOrder.status).toBe("delivered");
  });

  it("transitions pending → cancelled", async () => {
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    const updated = makeSubOrder({ status: "cancelled" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "cancelled" });

    expect(result.subOrder.status).toBe("cancelled");
  });

  it("transitions preparing → cancelled", async () => {
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus });
    const updated = makeSubOrder({ status: "cancelled" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "cancelled" });

    expect(result.subOrder.status).toBe("cancelled");
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
    expect(result.subOrder.status).toBe("preparing");
    // The mapped view serializes updatedAt as an ISO string (explicit
    // mapping — order-public-numbers Phase 4), not the raw Prisma Date.
    expect(result.subOrder.updatedAt).toBe(t0.toISOString());
    // SQL no-update assertion: update MUST NOT have been called
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("[SO-VIEW-6] maps the idempotent no-op path to subOrderNumber + order.orderNumber, no order.userId", async () => {
    // Spec: order-fulfillment §"Producer public reference responses" (ADDED)
    // scenario "Transition returns the same contract" — the no-op path MUST
    // return the SAME explicit shape as the successful-update path.
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      subOrderNumber: 4,
      order: { userId: OWNER_USER_ID, orderNumber: 9 },
    });
    mockTransaction(current);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    expect(result.subOrder.subOrderNumber).toBe(4);
    expect(result.subOrder.order).toEqual({ orderNumber: 9 });
    expect(result.subOrder).not.toHaveProperty("order.userId");
    expect(Object.keys(result.subOrder.order)).toEqual(["orderNumber"]);
  });

  it("[N-EMIT-NOOP-NO-DUP] creates NO notification and returns empty pendingEmails on a no-op transition", async () => {
    // Cycle 5 notifications (design "Emission wiring", Phase 5) — a same-status
    // PATCH must not duplicate a notification. Placement AFTER the step-3
    // early-return guarantees this: the no-op path returns before step 5a
    // (emission) is ever reached.
    // Spec: sdd/notifications/spec §"Replayed event does not duplicate"
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus });
    mockTransaction(current);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    expect(mockedCreateNotification).not.toHaveBeenCalled();
    expect(result.pendingEmails).toEqual([]);
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

// ===========================================================================
// transition — trackingNumber gate (order-fulfillment MODIFIED)
// ===========================================================================

describe("subOrdersService.transition — trackingNumber gate", () => {
  it("throws ValidationFailedError when PICKUP sub-order carries a trackingNumber", async () => {
    // Spec scenario: "PICKUP sub-order rejects trackingNumber"
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "sent", trackingNumber: "TN1" }),
    ).rejects.toThrow(ValidationFailedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationFailedError when PERSONAL_DELIVERY carries a trackingNumber", async () => {
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PERSONAL_DELIVERY" },
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", {
        status: "sent",
        trackingNumber: "TN1",
      }),
    ).rejects.toThrow(ValidationFailedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationFailedError when a shipping sub-order enters 'sent' without trackingNumber", async () => {
    // Spec scenario: "Shipping sub-order to sent without trackingNumber rejected"
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "sent" }),
    ).rejects.toThrow(ValidationFailedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationFailedError when trackingNumber is present on a non-'sent' target", async () => {
    // Spec scenario: "trackingNumber rejected on a non-sent transition"
    const current = makeSubOrder({
      status: "pending" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", {
        status: "preparing",
        trackingNumber: "TN1",
      }),
    ).rejects.toThrow(ValidationFailedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationFailedError when an already-set trackingNumber is overwritten", async () => {
    // Spec scenario: "Already-set trackingNumber cannot be overwritten"
    const current = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: "TN1",
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "sent", trackingNumber: "TN2" }),
    ).rejects.toThrow(ValidationFailedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws ValidationFailedError on a same-status 'sent → sent' no-op carrying trackingNumber (gate runs before no-op)", async () => {
    // Spec scenario: "Same-status no-op cannot set trackingNumber"
    const current = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: null,
    });
    const mockUpdate = mockTransaction(current);

    await expect(
      subOrdersService.transition("prod_001", "so_001", { status: "sent", trackingNumber: "TN1" }),
    ).rejects.toThrow(ValidationFailedError);
    // Gate runs BEFORE the idempotent no-op early-return AND before update.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("persists trackingNumber when a shipping sub-order validly enters 'sent'", async () => {
    // Spec scenario: "Shipping sub-order transitions to sent with a valid trackingNumber"
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: null,
    });
    const updated = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: "TN1",
    });
    const mockUpdate = mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", {
      status: "sent",
      trackingNumber: "TN1",
    });

    expect(result.subOrder.status).toBe("sent");
    expect(result.subOrder.trackingNumber).toBe("TN1");
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "so_001" },
      data: { status: "sent", trackingNumber: "TN1" },
    });
  });
});

// ===========================================================================
// transition — notification emission (Cycle 5 notifications, Phase 5)
// ===========================================================================

describe("subOrdersService.transition — notification emission", () => {
  it("[N-EMIT-SUBORDER-STATUS] emits SUBORDER_STATUS_CHANGED to order.userId on a valid transition", async () => {
    // Spec: sdd/notifications/spec §"Sub-order status change and tracking notify the consumer"
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    const updated = makeSubOrder({ status: "preparing" as SubOrderStatus });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "preparing" });

    expect(mockedCreateNotification).toHaveBeenCalledOnce();
    expect(mockedCreateNotification).toHaveBeenCalledWith(expect.anything(), {
      userId: OWNER_USER_ID,
      type: "SUBORDER_STATUS_CHANGED",
      toEmail: OWNER_EMAIL,
    });
    expect(result.pendingEmails).toHaveLength(1);
  });

  it("[N-EMIT-TRACKING-ASSIGNED] emits SUBORDER_STATUS_CHANGED THEN TRACKING_ASSIGNED when entering 'sent' with a trackingNumber", async () => {
    // Spec: sdd/notifications/spec §"Sub-order status change and tracking notify the consumer"
    // Triangulation vs. the previous test: a SECOND notification is emitted
    // only when trackingNumber is actually set — proves the conditional
    // branch runs real logic, not a hardcoded single-call Fake It.
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: null,
    });
    const updated = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: "TN1",
    });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", {
      status: "sent",
      trackingNumber: "TN1",
    });

    expect(mockedCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockedCreateNotification).toHaveBeenNthCalledWith(1, expect.anything(), {
      userId: OWNER_USER_ID,
      type: "SUBORDER_STATUS_CHANGED",
      toEmail: OWNER_EMAIL,
    });
    expect(mockedCreateNotification).toHaveBeenNthCalledWith(2, expect.anything(), {
      userId: OWNER_USER_ID,
      type: "TRACKING_ASSIGNED",
      toEmail: OWNER_EMAIL,
    });
    expect(result.pendingEmails).toHaveLength(2);
  });

  it("does NOT emit TRACKING_ASSIGNED when entering 'sent' without a trackingNumber (PICKUP)", async () => {
    // Triangulation: proves TRACKING_ASSIGNED is conditional on
    // input.trackingNumber, not on isEnteringSent alone.
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });
    const updated = makeSubOrder({
      status: "sent" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });
    mockTransaction(current, updated);

    const result = await subOrdersService.transition("prod_001", "so_001", { status: "sent" });

    expect(mockedCreateNotification).toHaveBeenCalledOnce();
    expect(mockedCreateNotification).toHaveBeenCalledWith(expect.anything(), {
      userId: OWNER_USER_ID,
      type: "SUBORDER_STATUS_CHANGED",
      toEmail: OWNER_EMAIL,
    });
    expect(result.pendingEmails).toHaveLength(1);
  });
});
