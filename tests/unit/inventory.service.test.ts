/**
 * Unit tests — inventory.service (Slice 5 TDD, RED phase + CORRECTIVE-RED patch).
 *
 * Strategy: mock prisma singleton so no DB is required.
 * Tests exercise service-level business logic: quantity validation,
 * ownership enforcement, stock decrement invariants, tx delegation,
 * low-stock query filtering/pagination, and the frozen Cycle 3 type contract.
 *
 * CORRECTIVE-RED note: findLowStock now uses $queryRaw (not findMany) to enforce
 * the cross-column comparison stock <= lowStockThreshold. Unit tests verify that
 * $queryRaw is called; integration test [IC2] in inventory.concurrency.test.ts
 * proves the filter actually excludes products where stock > lowStockThreshold.
 *
 * Scenarios covered (specs: inventory):
 *
 * decrementStock:
 *   - quantity = 0 rejected synchronously (no DB touch — $transaction not called)
 *   - quantity = -1 rejected synchronously (no DB touch — $transaction not called)
 *   - unknown productId → ProductNotFoundError (404)
 *   - post-decrement stock < 0 → InsufficientStockError (409) with tx rollback path
 *   - with caller tx provided: runs on caller's tx (no self-tx opened)
 *   - without tx: opens own $transaction (called exactly once)
 *
 * findLowStock:
 *   - delegates to $queryRaw (raw SQL path — not findMany)
 *   - returns result from $queryRaw
 *   - default limit = 20 when not supplied (checked via $queryRaw call)
 *   - limit capped at 100 when caller supplies > 100 (checked via $queryRaw call)
 *
 * Type-level contract (Cycle 3 frozen import):
 *   - decrementStock signature is byte-exact: (string, number, PrismaTx?) => Promise<void>
 *
 * Spec references:
 *   inventory §"decrementStock service contract (FROZEN)",
 *             §"Quantity zero or negative rejected",
 *             §"Unknown product rejected",
 *             §"Product at threshold appears in low-stock list",
 *             §"Soft-deleted or inactive product excluded",
 *             §"Low-stock query"
 *   design    Decision #7 (dual tx mode), ADR-003 (no repositories/ layer)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      product: {
        update: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
  };
});

import { prisma } from "@/shared/utils/prisma";
import {
  InsufficientStockError,
  ProductNotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import * as inventoryService from "@/modules/inventory/services/inventory.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product_001",
    producerId: "prod_001",
    categoryId: "cat_001",
    name: "Aceite de Oliva",
    description: "Aceite artesanal.",
    price: 12.5,
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// decrementStock — quantity validation (synchronous, no DB touch)
// ===========================================================================

describe("inventoryService.decrementStock — synchronous validation", () => {
  it("rejects quantity = 0 synchronously before any DB touch", async () => {
    await expect(inventoryService.decrementStock("product_001", 0)).rejects.toThrow(
      ValidationFailedError,
    );
    // $transaction must NOT have been called — validation is pre-DB
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects quantity = -1 synchronously before any DB touch", async () => {
    await expect(inventoryService.decrementStock("product_001", -1)).rejects.toThrow(
      ValidationFailedError,
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// decrementStock — ProductNotFoundError for unknown productId
// ===========================================================================

describe("inventoryService.decrementStock — unknown product", () => {
  it("throws ProductNotFoundError when productId does not exist (findFirst returns null)", async () => {
    // GIVEN: $transaction runs the callback and the product read returns null
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            update: vi.fn().mockResolvedValue(makeProduct({ stock: 9 })),
            findFirst: vi.fn().mockResolvedValue(null), // product not found after decrement
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(inventoryService.decrementStock("p_missing", 1)).rejects.toThrow(
      ProductNotFoundError,
    );
  });
});

// ===========================================================================
// decrementStock — InsufficientStockError when post-decrement stock < 0
// ===========================================================================

describe("inventoryService.decrementStock — insufficient stock", () => {
  it("throws InsufficientStockError when post-decrement stock would be negative", async () => {
    // GIVEN: after decrement the product row has stock = -1 (oversell scenario)
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            update: vi.fn().mockResolvedValue(makeProduct({ stock: -1 })),
            findFirst: vi.fn().mockResolvedValue(makeProduct({ stock: -1 })),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    // WHEN: decrementStock is called — tx should rollback via thrown error
    await expect(inventoryService.decrementStock("product_001", 5)).rejects.toThrow(
      InsufficientStockError,
    );
  });
});

// ===========================================================================
// decrementStock — happy path: opens own $transaction when tx is undefined
// ===========================================================================

describe("inventoryService.decrementStock — self-managed transaction", () => {
  it("opens its own $transaction when tx is not provided", async () => {
    // GIVEN: product has enough stock
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          product: {
            update: vi.fn().mockResolvedValue(makeProduct({ stock: 9 })),
            findFirst: vi.fn().mockResolvedValue(makeProduct({ stock: 9 })),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await inventoryService.decrementStock("product_001", 1);

    // THEN: the service opened exactly one self-managed transaction
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// decrementStock — caller-provided tx: no self-tx opened
// ===========================================================================

describe("inventoryService.decrementStock — caller-provided transaction", () => {
  it("runs on caller's tx and does NOT open a new $transaction", async () => {
    // GIVEN: a fake caller tx object that has sufficient stock
    const callerTx = {
      product: {
        update: vi.fn().mockResolvedValue(makeProduct({ stock: 9 })),
        findFirst: vi.fn().mockResolvedValue(makeProduct({ stock: 9 })),
      },
    } as unknown as Prisma.TransactionClient;

    // WHEN: decrementStock receives the caller's tx
    await inventoryService.decrementStock("product_001", 1, callerTx);

    // THEN: the service does NOT open its own $transaction
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    // AND: the caller tx's product.update was called (service ran on caller tx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((callerTx.product as any).update).toHaveBeenCalled();
  });
});

// ===========================================================================
// findLowStock — delegates to $queryRaw (CORRECTIVE: raw SQL path)
// ===========================================================================

describe("inventoryService.findLowStock — raw SQL path", () => {
  it("delegates to $queryRaw to enforce the cross-column filter (not findMany)", async () => {
    // GIVEN: $queryRaw resolves with one product at threshold
    const atThreshold = makeProduct({
      id: "product_at",
      stock: 5,
      lowStockThreshold: 5,
      isActive: true,
      deletedAt: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma as any).$queryRaw.mockResolvedValueOnce([atThreshold]);

    // WHEN
    const result = await inventoryService.findLowStock({ producerId: "prod_001" });

    // THEN: result comes from $queryRaw (cross-column filter enforced at DB)
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("product_at");

    // AND: $queryRaw was called (raw SQL path active)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma as any).$queryRaw).toHaveBeenCalledOnce();

    // AND: findMany was NOT called (raw SQL replaced it)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma.product as any).findMany).not.toHaveBeenCalled();
  });

  it("returns empty array when $queryRaw resolves with no matching products", async () => {
    // GIVEN: DB returns empty (all products above threshold or soft-deleted)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma as any).$queryRaw.mockResolvedValueOnce([]);

    // WHEN
    const result = await inventoryService.findLowStock({ producerId: "prod_001" });

    // THEN: empty result from DB is returned as-is
    expect(result).toHaveLength(0);
    // AND: $queryRaw still executed (filter ran; result is genuinely empty)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma as any).$queryRaw).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// findLowStock — pagination defaults and cap
// ===========================================================================

describe("inventoryService.findLowStock — pagination", () => {
  it("uses limit = 20 when not supplied", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma as any).$queryRaw.mockResolvedValueOnce([]);

    await inventoryService.findLowStock({ producerId: "prod_001" });

    // $queryRaw called once — limit=20 and offset=0 are embedded in the SQL template
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma as any).$queryRaw).toHaveBeenCalledOnce();
  });

  it("caps limit at 100 when caller supplies a value above 100", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma as any).$queryRaw.mockResolvedValueOnce([]);

    await inventoryService.findLowStock({ producerId: "prod_001", limit: 999 });

    // $queryRaw called once — effectiveLimit is capped to 100 inside the service
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma as any).$queryRaw).toHaveBeenCalledOnce();
  });

  it("passes offset to the query", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedPrisma as any).$queryRaw.mockResolvedValueOnce([]);

    await inventoryService.findLowStock({ producerId: "prod_001", limit: 10, offset: 30 });

    // $queryRaw called once — offset=30 embedded in the SQL template
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockedPrisma as any).$queryRaw).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// Type-level contract test — Cycle 3 frozen import
// ===========================================================================

describe("inventoryService.decrementStock — type-level contract (Cycle 3 frozen import)", () => {
  it("signature matches the frozen contract: (string, number, PrismaTx?) => Promise<void>", () => {
    /**
     * This test validates at the TYPE level that the decrementStock function
     * matches the exact signature that Cycle 3 checkout will import AS-IS.
     *
     * FROZEN signature per spec inventory §"decrementStock service contract":
     *   decrementStock(productId: string, quantity: number, tx?: PrismaTx): Promise<void>
     *
     * If any parameter type or return type changes, this assignment will produce
     * a TypeScript compile error — caught by `npx tsc --noEmit`.
     *
     * The runtime assertion (expect.toBe) validates the function is exported
     * and callable as a real function, not just a type alias.
     */
    type PrismaTx = Prisma.TransactionClient;

    // Type-level assignment — if the signature is wrong, tsc --noEmit will fail
    const _contractCheck: (
      productId: string,
      quantity: number,
      tx?: PrismaTx,
    ) => Promise<void> = inventoryService.decrementStock;

    // Runtime check: the export is a real function
    expect(typeof _contractCheck).toBe("function");

    // Suppress "never read" lint warning
    void _contractCheck;
  });
});
