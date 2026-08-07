/**
 * Integration tests — sub-orders transition endpoint (Slice 8, Commit B RED).
 *
 * Strategy: mock prisma singleton and express-oauth2-jwt-bearer.
 * Tests exercise the full wire contract for the PATCH endpoint: routing,
 * middleware chain, state machine, idempotency, and trackingNumber rejection.
 *
 * HOW THE MOCKS WORK:
 *   - `express-oauth2-jwt-bearer` replaced with test double reading X-Test-Auth.
 *   - `@/shared/utils/prisma` mocked so all Prisma calls are intercepted.
 *     loadUser calls `prisma.user.findUnique`; transition calls
 *     `prisma.$transaction` (callback form).
 *
 * Scenarios covered (specs: order-fulfillment):
 *   [SO-T1] PATCH /producers/me/sub-orders/:id — 200 valid transition (pending→preparing)
 *   [SO-T2] PATCH /producers/me/sub-orders/:id — 409 INVALID_ORDER_TRANSITION (pending→delivered)
 *   [SO-T3] PATCH /producers/me/sub-orders/:id — 200 idempotent no-op (preparing→preparing)
 *   [SO-T4] PATCH /producers/me/sub-orders/:id — 422 VALIDATION_FAILED, PICKUP sub-order rejects trackingNumber
 *   [SO-T5] PATCH /producers/me/sub-orders/:id — 404 cross-producer (no-leak)
 *   [SO-T6] PATCH /producers/me/sub-orders/:id — 200 shipping sub-order persists trackingNumber on →sent
 *   [SO-T7] PATCH /producers/me/sub-orders/:id — 422 VALIDATION_FAILED, shipping sub-order missing trackingNumber on →sent
 *   [SO-T-unauth] PATCH /producers/me/sub-orders/:id — 401 unauthenticated
 *
 * NOTE — [SO-T4] formally supersedes the Cycle 2 "Attempt to set trackingNumber rejected"
 * scenario (order-fulfillment §"Tracking number deferred", now REMOVED). This delta
 * un-defers trackingNumber; see order-fulfillment §"Tracking number on shipment" (MODIFIED).
 *
 * Spec references:
 *   order-fulfillment §"State machine"
 *   order-fulfillment scenario "Valid transition succeeds"
 *   order-fulfillment scenario "Invalid transition rejected"
 *   order-fulfillment §"Idempotent transitions"
 *   order-fulfillment scenario "Idempotent no-op does not touch the row"
 *   order-fulfillment §"Tracking number on shipment" (MODIFIED)
 *   order-fulfillment scenario "PICKUP sub-order rejects trackingNumber"
 *   order-fulfillment scenario "Shipping sub-order transitions to sent with a valid trackingNumber"
 *   order-fulfillment scenario "Shipping sub-order to sent without trackingNumber rejected"
 */
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: express-oauth2-jwt-bearer — same pattern as delivery-modes.test.ts
// ---------------------------------------------------------------------------
vi.mock("express-oauth2-jwt-bearer", () => ({
  auth: () =>
    (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const header = req.headers["x-test-auth"] as string | undefined;
      if (!header) {
        next({ status: 401, name: "UnauthorizedError" });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
        req.auth = { payload: payload as never, header: {}, token: "test-token" };
        next();
      } catch {
        next({ status: 401, name: "UnauthorizedError" });
      }
    },
}));

// ---------------------------------------------------------------------------
// Mock: prisma singleton
// loadUser calls prisma.user.findUnique.
// transition calls prisma.$transaction (callback form).
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $transaction: vi.fn(),
      user: { findUnique: vi.fn() },
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
import { createApp } from "@/app";

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedUser = mockedPrisma.user as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function authHeader(claims: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(claims)).toString("base64");
}

function makeProducerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "cuid_user_001",
    role: "PRODUCER",
    email: "producer@example.com",
    producerId: "prod_001",
    ...overrides,
  };
}

function makeSubOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "so_001",
    orderId: "order_001",
    producerId: "prod_001",
    deliveryModeId: "dm_001",
    status: "pending" as SubOrderStatus,
    shippingCostSnapshot: new Decimal("5.00"),
    trackingNumber: null,
    deliveryMode: { type: "SHIPPING_FLAT_RATE" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Configure prisma.user.findUnique to return a user projection for loadUser.
 * PRODUCER role also returns a producer relation for producerId.
 */
function mockLoadUser(user: ReturnType<typeof makeProducerUser> | null): void {
  if (!user) {
    mockedUser.findUnique.mockResolvedValueOnce(null);
    return;
  }
  mockedUser.findUnique.mockResolvedValueOnce({
    id: user.id,
    role: user.role,
    email: user.email,
    producer: user.producerId ? { id: user.producerId } : null,
  });
}

/**
 * Wire up prisma.$transaction for transition scenarios.
 * The callback is called with a fake tx that has findFirst and update methods.
 */
function mockTransition(
  current: ReturnType<typeof makeSubOrder> | null,
  updated?: ReturnType<typeof makeSubOrder>,
): void {
  mockedPrisma.$transaction.mockImplementationOnce(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const fakeTx = {
        subOrder: {
          findFirst: vi.fn().mockResolvedValue(current),
          update: vi.fn().mockResolvedValue(updated ?? current),
        },
      };
      return fn(fakeTx as unknown as typeof prisma);
    },
  );
}

// ---------------------------------------------------------------------------
// App + request
// ---------------------------------------------------------------------------

const app = createApp();
const request = supertest(app);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// PATCH /api/v1/producers/me/sub-orders/:id — state machine transitions
// ===========================================================================

describe("PATCH /api/v1/producers/me/sub-orders/:id — state machine transitions", () => {
  it("[SO-T1] returns 200 with updated SubOrder on valid transition (pending → preparing)", async () => {
    // Spec scenario: "Valid transition succeeds"
    // GIVEN S1(status=pending) owned by P1
    // WHEN P1 PATCHes S1 with { status: "preparing" }
    // THEN the response MUST be 200 with S1.status = "preparing"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });
    const updated = makeSubOrder({ status: "preparing" as SubOrderStatus });

    mockLoadUser(user);
    mockTransition(current, updated);

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("preparing");
    expect(res.body.id).toBe("so_001");
  });

  it("[SO-T2] returns 409 INVALID_ORDER_TRANSITION on invalid transition (pending → delivered)", async () => {
    // Spec scenario: "Invalid transition rejected"
    // GIVEN S1(status=pending)
    // WHEN P1 PATCHes S1 with { status: "delivered" }
    // THEN the response MUST be 409 with code: "INVALID_ORDER_TRANSITION"
    // AND S1.status MUST remain pending
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const current = makeSubOrder({ status: "pending" as SubOrderStatus });

    mockLoadUser(user);
    mockTransition(current); // no update call for invalid transition

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "delivered" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_ORDER_TRANSITION");
  });

  it("[SO-T3] returns 200 with unchanged SubOrder on idempotent no-op (preparing → preparing)", async () => {
    // Spec: order-fulfillment §"Idempotent transitions"
    // Spec scenario: "Idempotent no-op does not touch the row"
    // GIVEN S1(status=preparing, updatedAt=T0)
    // WHEN P1 PATCHes S1 with { status: "preparing" }
    // THEN the response MUST be 200 with S1.status = "preparing"
    // AND S1.updatedAt MUST still equal T0 (no UPDATE issued)
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const t0 = new Date("2026-01-15T10:00:00Z");
    const current = makeSubOrder({ status: "preparing" as SubOrderStatus, updatedAt: t0 });

    mockLoadUser(user);
    // Idempotent no-op: service returns current without calling update.
    // We verify no update is called by checking the mock isn't called.
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn();
        const fakeTx = {
          subOrder: {
            findFirst: vi.fn().mockResolvedValue(current),
            update: mockUpdate,
          },
        };
        const result = await fn(fakeTx as unknown as typeof prisma);
        // SQL no-update assertion: update MUST NOT have been called
        expect(mockUpdate).not.toHaveBeenCalled();
        return result;
      },
    );

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("preparing");
    // updatedAt should remain T0 — serialized as ISO string in JSON
    expect(new Date(res.body.updatedAt as string).getTime()).toBe(t0.getTime());
  });

  it("[SO-T4] returns 422 VALIDATION_FAILED when a PICKUP sub-order carries a trackingNumber", async () => {
    // Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
    // Spec scenario: "PICKUP sub-order rejects trackingNumber"
    // Formally supersedes the Cycle 2 "Attempt to set trackingNumber rejected" scenario.
    // GIVEN S1(status=preparing, deliveryMode.type=PICKUP)
    // WHEN P1 PATCHes S1 with { status: "sent", trackingNumber: "TN1" }
    // THEN the response MUST be 422 with code: "VALIDATION_FAILED"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "PICKUP" },
    });

    mockLoadUser(user);
    mockTransition(current); // gate rejects before update is ever called

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "sent", trackingNumber: "TN1" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[SO-T6] returns 200 and persists trackingNumber when a shipping sub-order enters 'sent'", async () => {
    // Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
    // Spec scenario: "Shipping sub-order transitions to sent with a valid trackingNumber"
    // GIVEN S1(status=preparing, deliveryMode.type=SHIPPING_FLAT_RATE)
    // WHEN P1 PATCHes S1 with { status: "sent", trackingNumber: "TN1" }
    // THEN the response MUST be 200 with S1.status = "sent" and S1.trackingNumber = "TN1"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
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

    mockLoadUser(user);
    mockTransition(current, updated);

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "sent", trackingNumber: "TN1" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.trackingNumber).toBe("TN1");
  });

  it("[SO-T7] returns 422 VALIDATION_FAILED when a shipping sub-order enters 'sent' without trackingNumber", async () => {
    // Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
    // Spec scenario: "Shipping sub-order to sent without trackingNumber rejected"
    // GIVEN S1(status=preparing, deliveryMode.type=SHIPPING_FLAT_RATE)
    // WHEN P1 PATCHes S1 with { status: "sent" }
    // THEN the response MUST be 422 with code: "VALIDATION_FAILED"
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });
    const current = makeSubOrder({
      status: "preparing" as SubOrderStatus,
      deliveryMode: { type: "SHIPPING_FLAT_RATE" },
      trackingNumber: null,
    });

    mockLoadUser(user);
    mockTransition(current);

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "sent" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("[SO-T5] returns 404 when SubOrder belongs to another producer (cross-producer no-leak)", async () => {
    const sub = "auth0|producer001";
    const user = makeProducerUser({ auth0Sub: sub });

    mockLoadUser(user);
    mockTransition(null); // findFirst returns null → NotFoundError

    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_owned_by_p2")
      .set("X-Test-Auth", authHeader({ sub }))
      .send({ status: "preparing" });

    expect(res.status).toBe(404);
    expect(res.body.code).not.toBe("FORBIDDEN");
  });

  it("[SO-T-unauth] returns 401 when no auth header", async () => {
    const res = await request
      .patch("/api/v1/producers/me/sub-orders/so_001")
      .send({ status: "preparing" });
    expect(res.status).toBe(401);
  });
});
