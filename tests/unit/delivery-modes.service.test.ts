/**
 * Unit tests — delivery-modes.service (Slice 7 TDD, RED phase + follow-up fix).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic: producer-scoped ownership
 * enforcement, PICKUP validation guard, active-SubOrder delete guard,
 * and the frozen Cycle 3 enum wire contract.
 *
 * Scenarios covered (specs: delivery-modes):
 *
 * create:
 *   - creates SHIPPING_FLAT_RATE delivery mode for producer (201)
 *   - throws ValidationFailedError when type=PICKUP and pickupLocation is null
 *   - [follow-up] creates SHIPPING_FLAT_RATE with cost=0 (free shipping) — Decimal("0.00")
 *
 * findAll:
 *   - returns all delivery modes owned by producer
 *   - returns empty array when producer has no delivery modes
 *
 * findById:
 *   - returns delivery mode when owned by producer
 *   - throws DeliveryModeNotFoundError when not owned (404-no-leak)
 *
 * update:
 *   - updates fields when delivery mode is owned by producer
 *   - throws DeliveryModeNotFoundError when not owned (404-no-leak)
 *   - [follow-up] throws ValidationFailedError when patching type=PICKUP without pickupLocation
 *   - [follow-up] succeeds when patching type=PICKUP with a valid pickupLocation
 *
 * hardDelete:
 *   - throws DeliveryModeNotFoundError when not owned (404-no-leak)
 *   - throws ProducerHasActiveOrdersError when active SubOrders reference the delivery mode
 *   - hard-deletes when no active SubOrders reference the delivery mode
 *
 * Spec references:
 *   delivery-modes §"Producer-scoped CRUD", §"DeliveryMode entity",
 *                  §"PICKUP without pickupLocation rejected",
 *                  §"SHIPPING_FLAT_RATE with cost = 0 accepted",
 *                  §"Cross-producer read returns 404",
 *                  §"Delete blocked by active SubOrder reference"
 *   design         §"Delivery-modes delete guard", §"ProducerHasActiveOrdersError reuse"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      deliveryMode: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      subOrder: { count: vi.fn() },
    },
  };
});

import type { DeliveryModeType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/shared/utils/prisma";
import {
  DeliveryModeNotFoundError,
  ProducerHasActiveOrdersError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import * as deliveryModesService from "@/modules/delivery-modes/services/delivery-modes.service";
import { DeliveryModeTypeSchema } from "@/modules/delivery-modes/dto/delivery-modes.dto";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeliveryMode(overrides: Record<string, unknown> = {}) {
  return {
    id: "dm_001",
    producerId: "prod_001",
    type: "SHIPPING_FLAT_RATE" as DeliveryModeType,
    cost: new Decimal("5.00"),
    coverageZone: "Madrid",
    pickupLocation: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// create
// ===========================================================================

describe("deliveryModesService.create", () => {
  it("creates SHIPPING_FLAT_RATE delivery mode for producer", async () => {
    const created = makeDeliveryMode();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).create.mockResolvedValueOnce(created);

    const result = await deliveryModesService.create("prod_001", {
      type: "SHIPPING_FLAT_RATE",
      cost: 5.0,
      coverageZone: "Madrid",
    });

    expect(result.id).toBe("dm_001");
    expect(result.type).toBe("SHIPPING_FLAT_RATE");
    expect(result.producerId).toBe("prod_001");
  });

  it("throws ValidationFailedError when type=PICKUP and pickupLocation is null", async () => {
    await expect(
      deliveryModesService.create("prod_001", {
        type: "PICKUP",
        cost: 0,
        pickupLocation: undefined,
      }),
    ).rejects.toThrow(ValidationFailedError);
  });

  // Spec: delivery-modes §"SHIPPING_FLAT_RATE with cost = 0 accepted"
  // Coverage-gap test: free shipping (cost=0) must be accepted and persisted as Decimal("0.00").
  it("creates SHIPPING_FLAT_RATE delivery mode with cost=0 and returns Decimal('0.00')", async () => {
    const created = makeDeliveryMode({ cost: new Decimal("0.00") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).create.mockResolvedValueOnce(created);

    const result = await deliveryModesService.create("prod_001", {
      type: "SHIPPING_FLAT_RATE",
      cost: 0,
    });

    // Production code must not reject cost=0; it passes through to prisma.deliveryMode.create.
    // The returned entity MUST reflect Decimal("0.00") — matching the spec.
    expect(result.cost).toEqual(new Decimal("0.00"));
    expect(result.type).toBe("SHIPPING_FLAT_RATE");
  });
});

// ===========================================================================
// findAll
// ===========================================================================

describe("deliveryModesService.findAll", () => {
  it("returns all delivery modes owned by producer", async () => {
    const dm1 = makeDeliveryMode();
    const dm2 = makeDeliveryMode({ id: "dm_002", type: "PICKUP" as DeliveryModeType, pickupLocation: "Calle Mayor 1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).findMany.mockResolvedValueOnce([dm1, dm2]);

    const result = await deliveryModesService.findAll("prod_001");

    expect(result).toHaveLength(2);
    // Non-null assertions safe: length asserted above (noUncheckedIndexedAccess TS2532 fix)
    expect(result[0]!.id).toBe("dm_001");
    expect(result[1]!.id).toBe("dm_002");
  });

  it("returns empty array when producer has no delivery modes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).findMany.mockResolvedValueOnce([]);

    const result = await deliveryModesService.findAll("prod_002");

    expect(result).toEqual([]);
  });
});

// ===========================================================================
// findById
// ===========================================================================

describe("deliveryModesService.findById", () => {
  it("returns delivery mode when owned by producer", async () => {
    const dm = makeDeliveryMode();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).findFirst.mockResolvedValueOnce(dm);

    const result = await deliveryModesService.findById("prod_001", "dm_001");

    expect(result.id).toBe("dm_001");
    expect(result.producerId).toBe("prod_001");
  });

  it("throws DeliveryModeNotFoundError when delivery mode belongs to another producer (404-no-leak)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.deliveryMode as any).findFirst.mockResolvedValueOnce(null);

    await expect(
      deliveryModesService.findById("prod_attacker", "dm_001"),
    ).rejects.toThrow(DeliveryModeNotFoundError);
  });
});

// ===========================================================================
// update
// ===========================================================================

describe("deliveryModesService.update", () => {
  it("updates delivery mode fields when owned by producer", async () => {
    const updated = makeDeliveryMode({ coverageZone: "Barcelona" });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            update: vi.fn().mockResolvedValue(updated),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await deliveryModesService.update("prod_001", "dm_001", {
      coverageZone: "Barcelona",
    });

    expect(result.coverageZone).toBe("Barcelona");
  });

  it("throws DeliveryModeNotFoundError when delivery mode not owned (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      deliveryModesService.update("prod_attacker", "dm_001", { coverageZone: "Hacked" }),
    ).rejects.toThrow(DeliveryModeNotFoundError);
  });

  // Spec: delivery-modes §"PICKUP without pickupLocation rejected" — update path
  // Regression test for CRITICAL 1: PATCH to type=PICKUP must enforce pickupLocation invariant.
  it("throws ValidationFailedError when patching type=PICKUP without pickupLocation", async () => {
    // The existing delivery mode is SHIPPING_FLAT_RATE (no pickupLocation).
    // Patching to type=PICKUP without providing a pickupLocation must be rejected.
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode({ type: "SHIPPING_FLAT_RATE", pickupLocation: null })),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      deliveryModesService.update("prod_001", "dm_001", { type: "PICKUP" }),
    ).rejects.toThrow(ValidationFailedError);
  });

  // Triangulation: update succeeds when patching to PICKUP with a valid pickupLocation.
  it("succeeds when patching type=PICKUP with a valid pickupLocation", async () => {
    const updated = makeDeliveryMode({ type: "PICKUP" as import("@prisma/client").DeliveryModeType, pickupLocation: "Calle Mayor 1, Madrid" });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            update: vi.fn().mockResolvedValue(updated),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await deliveryModesService.update("prod_001", "dm_001", {
      type: "PICKUP",
      pickupLocation: "Calle Mayor 1, Madrid",
    });

    expect(result.type).toBe("PICKUP");
    expect(result.pickupLocation).toBe("Calle Mayor 1, Madrid");
  });
});

// ===========================================================================
// hardDelete
// ===========================================================================

describe("deliveryModesService.hardDelete", () => {
  it("throws DeliveryModeNotFoundError when delivery mode does not belong to producer (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(null),
            delete: vi.fn(),
          },
          subOrder: { count: vi.fn() },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      deliveryModesService.hardDelete("prod_attacker", "dm_001"),
    ).rejects.toThrow(DeliveryModeNotFoundError);
  });

  it("throws ProducerHasActiveOrdersError when active SubOrders reference the delivery mode", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            delete: vi.fn(),
          },
          subOrder: {
            count: vi.fn().mockResolvedValue(1), // active SubOrders exist (pending/preparing/sent)
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      deliveryModesService.hardDelete("prod_001", "dm_001"),
    ).rejects.toThrow(ProducerHasActiveOrdersError);
  });

  it("hard-deletes the delivery mode when no active SubOrders reference it", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockDelete = vi.fn().mockResolvedValue(makeDeliveryMode());
        const fakeTx = {
          deliveryMode: {
            findFirst: vi.fn().mockResolvedValue(makeDeliveryMode()),
            delete: mockDelete,
          },
          subOrder: {
            count: vi.fn().mockResolvedValue(0), // no active SubOrders
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        // MUST call delete exactly once
        expect(mockDelete).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "dm_001" } }),
        );
        return res;
      },
    );

    // Should resolve without throwing
    await deliveryModesService.hardDelete("prod_001", "dm_001");
  });
});

// ===========================================================================
// Enum widening boundary — DeliveryModeTypeSchema
// ===========================================================================

/**
 * Spec: delivery-modes §"Enum widening rejected in review"
 *   GIVEN a proposed schema that adds "COURIER" to DeliveryModeType
 *   WHEN this spec is in force
 *   THEN the change MUST be treated as scope creep and rejected.
 *
 * This test enforces the runtime boundary of DeliveryModeTypeSchema:
 *   - The schema MUST accept exactly ["PICKUP", "SHIPPING_FLAT_RATE"].
 *   - Any value outside that set (e.g. "COURIER") MUST fail Zod parsing.
 *   - If someone widens the schema (adds "COURIER"), THIS TEST BREAKS — scope creep detected.
 *
 * Layer: Unit — no prisma calls; pure DTO schema assertion.
 */
describe("DeliveryModeTypeSchema — enum boundary (enum widening rejected in review)", () => {
  // Uses the statically imported DeliveryModeTypeSchema from the DTO module.
  // No prisma calls; pure DTO schema assertion. The prisma mock above is hoisted
  // but this describe block does not exercise service code.

  it("accepts PICKUP as a valid DeliveryModeType", () => {
    const result = DeliveryModeTypeSchema.safeParse("PICKUP");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("PICKUP");
    }
  });

  it("accepts SHIPPING_FLAT_RATE as a valid DeliveryModeType", () => {
    const result = DeliveryModeTypeSchema.safeParse("SHIPPING_FLAT_RATE");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("SHIPPING_FLAT_RATE");
    }
  });

  it("rejects COURIER — enum widening is scope creep and MUST fail validation", () => {
    // If DeliveryModeTypeSchema is ever widened to include "COURIER", this test fails.
    // That failure is the signal that a new SDD cycle is required per spec.
    const result = DeliveryModeTypeSchema.safeParse("COURIER");
    expect(result.success).toBe(false);
  });

  it("rejects unknown enum literals — only PICKUP and SHIPPING_FLAT_RATE are allowed in Cycle 2", () => {
    const unknowns = ["COURIER", "EXPRESS", "DRONE", "pickup", "shipping_flat_rate", ""];
    for (const unknown of unknowns) {
      const result = DeliveryModeTypeSchema.safeParse(unknown);
      expect(result.success).toBe(false);
    }
  });
});
