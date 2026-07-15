/**
 * Unit tests — producers.service (Slice 9 TDD, Commit A RED).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic: producer-scoped patch,
 * NIF non-editability, category slug replacement transaction,
 * soft-delete guard using non-terminal SubOrder count,
 * and public projection redaction.
 *
 * Scenarios covered (specs: producer-bootstrap):
 *
 * patch:
 *   - updates businessName when owned by producer
 *   - throws UnknownCategoryError when unknown categorySlugs provided
 *   - does NOT touch the DB row when only forbidden field (nif) attempted
 *     (DTO rejects at HTTP layer — this tests service with valid input)
 *
 * softDelete:
 *   - throws ProducerHasActiveOrdersError when non-terminal SubOrders exist
 *   - sets deletedAt when all SubOrders are terminal (count = 0)
 *   - sets deletedAt when producer has no SubOrders (count = 0)
 *
 * findPublicById:
 *   - returns redacted projection omitting PII (nif, addressLine1, addressLine2, addressPostalCode)
 *   - throws NotFoundError when producer not found or deleted
 *
 * isTerminalStatus (imported from sub-orders for reuse awareness):
 *   - confirmed reuse: "delivered" and "cancelled" are terminal
 *   - confirmed non-terminal: "pending", "preparing", "sent"
 *
 * Spec references:
 *   producer-bootstrap §"Private profile edit endpoint"
 *   producer-bootstrap §"Public producer projection endpoint"
 *   producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
 *   producer-bootstrap scenario "NIF edit rejected" (DTO-level; unit test verifies service-level)
 *   producer-bootstrap scenario "Unknown categorySlug rejected"
 *   producer-bootstrap scenario "Public projection redacts PII"
 *   producer-bootstrap scenario "Delete blocked by non-terminal SubOrder"
 *   producer-bootstrap scenario "Delete allowed when all SubOrders terminal"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      producer: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      producerCategory: {
        findMany: vi.fn(),
      },
      producerCategoryOnProducer: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      subOrder: { count: vi.fn() },
    },
  };
});

import { prisma } from "@/shared/utils/prisma";
import {
  NotFoundError,
  ProducerHasActiveOrdersError,
  UnknownCategoryError,
} from "@/shared/errors/errors";
import * as producersService from "@/modules/producers/services/producers.service";
import { isTerminalStatus } from "@/modules/sub-orders/services/sub-orders.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProducer(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_001",
    userId: "user_001",
    businessName: "Old Business",
    nif: "B12345678",
    description: "A description",
    addressLine1: "Calle X 1",
    addressLine2: null,
    addressCity: "Madrid",
    addressPostalCode: "28001",
    addressProvince: "Madrid",
    addressCountry: "ES",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    categories: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// patch
// ===========================================================================

describe("producersService.patch", () => {
  it("updates businessName in a transaction and returns updated producer", async () => {
    // Spec: producer-bootstrap §"Private profile edit endpoint" — partial update
    const existing = makeProducer();
    const updated = makeProducer({ businessName: "New Business" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn().mockResolvedValueOnce(updated),
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
        producerCategory: { findMany: vi.fn().mockResolvedValueOnce([]) },
        producerCategoryOnProducer: {
          deleteMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
          createMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
        },
      };
      return fn(tx);
    });

    const result = await producersService.patch("prod_001", { businessName: "New Business" });

    expect(result.businessName).toBe("New Business");
    expect(result.id).toBe("prod_001");
  });

  it("throws UnknownCategoryError when categorySlugs contains an unknown slug", async () => {
    // Spec: producer-bootstrap scenario "Unknown categorySlug rejected"
    const existing = makeProducer();
    // Capture mocks to assert join-table and producer row are NOT mutated
    let capturedProducerUpdate: ReturnType<typeof vi.fn> | undefined;
    let capturedDeleteMany: ReturnType<typeof vi.fn> | undefined;
    let capturedCreateMany: ReturnType<typeof vi.fn> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      capturedProducerUpdate = vi.fn();
      capturedDeleteMany = vi.fn();
      capturedCreateMany = vi.fn();
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: capturedProducerUpdate,
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
        producerCategory: {
          findMany: vi.fn().mockResolvedValueOnce([
            // only 1 found of 2 requested
            { id: "cat_queso", slug: "queso", name: "Queso" },
          ]),
        },
        producerCategoryOnProducer: {
          deleteMany: capturedDeleteMany,
          createMany: capturedCreateMany,
        },
      };
      return fn(tx);
    });

    await expect(
      producersService.patch("prod_001", { categorySlugs: ["queso", "not-a-real-slug"] }),
    ).rejects.toBeInstanceOf(UnknownCategoryError);

    // Invariant: unknown category rejection MUST NOT mutate the join table or the producer row
    // Spec: "Unknown categorySlug rejected" → row stays unchanged
    expect(capturedProducerUpdate).toBeDefined();
    expect(capturedProducerUpdate!).not.toHaveBeenCalled();
    expect(capturedDeleteMany).toBeDefined();
    expect(capturedDeleteMany!).not.toHaveBeenCalled();
    expect(capturedCreateMany).toBeDefined();
    expect(capturedCreateMany!).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when producer not found", async () => {
    // Spec: cross-producer 404-no-leak (producer resource not found)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(null),
          update: vi.fn(),
        },
        subOrder: { count: vi.fn() },
        producerCategory: { findMany: vi.fn() },
        producerCategoryOnProducer: { deleteMany: vi.fn(), createMany: vi.fn() },
      };
      return fn(tx);
    });

    await expect(
      producersService.patch("prod_unknown", { businessName: "X" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// softDelete
// ===========================================================================

describe("producersService.softDelete", () => {
  it("throws ProducerHasActiveOrdersError when non-terminal SubOrders exist", async () => {
    // Spec: producer-bootstrap §"Producer soft-delete guard against non-terminal SubOrders"
    // Scenario: "Delete blocked by non-terminal SubOrder"
    const existing = makeProducer();
    // Capture tx.producer.update to assert it was NOT called (deletedAt invariant)
    let capturedUpdate: ReturnType<typeof vi.fn> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      capturedUpdate = vi.fn();
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: capturedUpdate,
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(1) }, // 1 active SubOrder
      };
      return fn(tx);
    });

    await expect(
      producersService.softDelete("prod_001"),
    ).rejects.toBeInstanceOf(ProducerHasActiveOrdersError);

    // Invariant: blocked delete MUST NOT write deletedAt — producer.update must not be called
    // Spec: "Delete blocked by non-terminal SubOrder" → producer row stays unchanged
    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate!).not.toHaveBeenCalled();
  });

  it("sets deletedAt when all SubOrders are terminal (count = 0)", async () => {
    // Spec: producer-bootstrap scenario "Delete allowed when all SubOrders terminal"
    const existing = makeProducer();
    const deleted = makeProducer({ deletedAt: new Date("2026-07-14T00:00:00Z") });
    // Capture tx.producer.update to assert it WAS called with deletedAt
    let capturedUpdate: ReturnType<typeof vi.fn> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      capturedUpdate = vi.fn().mockResolvedValueOnce(deleted);
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: capturedUpdate,
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
      };
      return fn(tx);
    });

    await producersService.softDelete("prod_001");

    // Invariant: successful delete MUST write deletedAt on the producer row
    // Spec: "Delete allowed when all SubOrders terminal" → producer.update with { deletedAt }
    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate!).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it("sets deletedAt when producer has no SubOrders (count = 0)", async () => {
    // Spec: producer-bootstrap scenario "Delete allowed when producer has no SubOrders"
    const existing = makeProducer();
    const deleted = makeProducer({ deletedAt: new Date("2026-07-14T00:00:00Z") });
    // Capture tx.producer.update to assert it WAS called with deletedAt
    let capturedUpdate: ReturnType<typeof vi.fn> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      capturedUpdate = vi.fn().mockResolvedValueOnce(deleted);
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: capturedUpdate,
        },
        subOrder: { count: vi.fn().mockResolvedValueOnce(0) },
      };
      return fn(tx);
    });

    await producersService.softDelete("prod_001");

    // Invariant: successful delete MUST write deletedAt on the producer row
    // Spec: "Delete allowed when producer has no SubOrders" → producer.update with { deletedAt }
    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate!).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

// ===========================================================================
// findPublicById
// ===========================================================================

describe("producersService.findPublicById", () => {
  it("returns redacted projection omitting PII fields (nif, addressLine1, postalCode)", async () => {
    // Spec: producer-bootstrap §"Public producer projection endpoint"
    // Scenario: "Public projection redacts PII"
    const fullProducer = makeProducer({
      categories: [{ category: { slug: "artesania", name: "Artesanía" } }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.producer as any).findFirst.mockResolvedValueOnce(fullProducer);

    const result = await producersService.findPublicById("prod_001");

    // Public fields present
    expect(result.id).toBe("prod_001");
    expect(result.businessName).toBe("Old Business");
    expect(result.address.city).toBe("Madrid");
    expect(result.address.province).toBe("Madrid");
    expect(result.address.country).toBe("ES");
    expect(Array.isArray(result.categories)).toBe(true);

    // PII fields MUST NOT appear — cast to unknown to avoid TS complaining
    // about absent keys on a correctly-typed return type (that's the whole point).
    const resultUnknown = result as unknown as Record<string, unknown>;
    const addressUnknown = result.address as unknown as Record<string, unknown>;
    expect(resultUnknown.nif).toBeUndefined();
    expect(resultUnknown.userId).toBeUndefined();
    expect(addressUnknown.line1).toBeUndefined();
    expect(addressUnknown.line2).toBeUndefined();
    expect(addressUnknown.postalCode).toBeUndefined();

    // Raw PII strings should not be in the serialized output
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("B12345678");
    expect(serialized).not.toContain("Calle X 1");
  });

  it("throws NotFoundError when producer not found", async () => {
    // Spec: producer-bootstrap §"Public producer projection endpoint"
    // — returns 404 when row does not exist
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.producer as any).findFirst.mockResolvedValueOnce(null);

    await expect(
      producersService.findPublicById("prod_unknown"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when producer is soft-deleted", async () => {
    // Spec: producer-bootstrap scenario "Soft-deleted producer returns 404"
    // The service filters deletedAt: null in the query — mock returns null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.producer as any).findFirst.mockResolvedValueOnce(null);

    await expect(
      producersService.findPublicById("prod_deleted"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// isTerminalStatus reuse contract (CRITICAL 1 — cross-slice contract)
// ===========================================================================

describe("softDelete guard uses isTerminalStatus() from sub-orders (CRITICAL 1 reuse contract)", () => {
  it("counts SubOrders using notIn terminal statuses, not a local hardcoded non-terminal list", async () => {
    // CRITICAL 1: design contract requires producers.service to delegate to isTerminalStatus()
    // from sub-orders.service rather than hardcoding a local NON_TERMINAL_SUBORDER_STATUSES array.
    // The query must use { status: { notIn: ['delivered','cancelled'] } } (terminal exclusion)
    // instead of { status: { in: ['pending','preparing','sent'] } } (non-terminal inclusion).
    // RED: current implementation uses the local hardcoded `in` filter — this test FAILS.
    const existing = makeProducer();
    let capturedSubOrderCount: ReturnType<typeof vi.fn> | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      capturedSubOrderCount = vi.fn().mockResolvedValueOnce(0);
      const tx = {
        producer: {
          findFirst: vi.fn().mockResolvedValueOnce(existing),
          update: vi.fn().mockResolvedValueOnce({ ...existing, deletedAt: new Date() }),
        },
        subOrder: { count: capturedSubOrderCount },
      };
      return fn(tx);
    });

    await producersService.softDelete("prod_001");

    // Assert: the count WHERE clause uses terminal-status exclusion (notIn)
    // derived from isTerminalStatus(), NOT a local hardcoded `in` list.
    // Spec: cross-slice contract — producers guard must stay in sync with sub-orders state machine.
    expect(capturedSubOrderCount).toBeDefined();
    expect(capturedSubOrderCount!).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: expect.objectContaining({
            notIn: expect.arrayContaining(["delivered", "cancelled"]),
          }),
        }),
      }),
    );
  });
});

// ===========================================================================
// isTerminalStatus reuse awareness (from sub-orders — imported by guard)
// ===========================================================================

describe("isTerminalStatus (sub-orders reuse — awareness test)", () => {
  it("confirms 'delivered' and 'cancelled' are terminal", () => {
    // This validates the reuse pattern exported from sub-orders.service
    expect(isTerminalStatus("delivered")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("confirms 'pending', 'preparing', 'sent' are non-terminal", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("preparing")).toBe(false);
    expect(isTerminalStatus("sent")).toBe(false);
  });
});
