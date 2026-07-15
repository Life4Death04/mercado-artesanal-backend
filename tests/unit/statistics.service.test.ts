/**
 * Unit tests — statistics.service (Slice 10 TDD, Commit A RED + Corrective RED).
 *
 * Strategy: mock prisma singleton and inventory service so no DB is required.
 * Tests verify service-level logic for the three statistics functions:
 *   - getRevenue: clock injection, window→date translation, $queryRaw delegation,
 *     cancelled exclusion, decimal-string serialization, empty-window zero.
 *   - getOrderCount: clock injection, window→date translation, cancelled exclusion.
 *   - getLowStock: delegates to findLowStock with correct args; returns envelope.
 *
 * KEY INVARIANTS UNDER TEST:
 *   1. Services MUST NOT call `new Date()` directly — clock is injected.
 *   2. totalRevenue MUST be a decimal string (never a JS number).
 *   3. getLowStock MUST delegate to inventory.findLowStock with producerId + pagination.
 *   4. getLowStock MUST return { items, limit, offset, total } envelope (spec:69-72).
 *   5. Low-stock items MUST expose `productId` (spec field name), not `id`.
 *   6. $queryRaw bounds MUST equal the clock-derived from/to dates exactly.
 *   7. subOrder.count where-clause MUST include status.notIn and exact date bounds.
 *
 * Spec references:
 *   sales-stats §"Window parameter contract"
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint" (spec lines 69-72: envelope contract)
 *   sales-stats §Invariants
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: prisma singleton
// Revenue query uses prisma.$queryRaw; order count uses prisma.subOrder.count.
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    subOrder: { count: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Mock: inventory service — getLowStock delegates to findLowStock
// ---------------------------------------------------------------------------
vi.mock("@/modules/inventory/services/inventory.service", () => ({
  findLowStock: vi.fn(),
  findLowStockCount: vi.fn(),
}));

import { prisma } from "@/shared/utils/prisma";
import * as inventoryService from "@/modules/inventory/services/inventory.service";
import * as statisticsService from "@/modules/statistics/services/statistics.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedQueryRaw = mockedPrisma.$queryRaw as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedSubOrderCount = mockedPrisma.subOrder as any;
const mockedFindLowStock = vi.mocked(inventoryService.findLowStock);
const mockedFindLowStockCount = vi.mocked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (inventoryService as any).findLowStockCount as (...args: unknown[]) => Promise<number>,
);

// ---------------------------------------------------------------------------
// Fixed clock fixture
// Spec: sales-stats scenario "Deterministic clock in tests"
//   now = 2026-01-01T00:00:00Z, window = "7d" → from = 2025-12-25T00:00:00Z
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock = (): Date => FIXED_NOW;

// Pre-compute expected bounds for the 7d window
const EXPECTED_FROM_7D = new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
const EXPECTED_FROM_30D = new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.resetAllMocks();
});

// ===========================================================================
// getRevenue
// ===========================================================================

describe("statisticsService.getRevenue", () => {
  it("[SR-1] returns { window, totalRevenue: string } — decimal-string invariant", async () => {
    // Spec invariant: totalRevenue MUST be a decimal string, never a JS number.
    // Mock $queryRaw returning a Postgres NUMERIC aggregate as string.
    mockedQueryRaw.mockResolvedValueOnce([{ total: "123.45" }]);

    const result = await statisticsService.getRevenue("prod_001", "30d", fixedClock);

    expect(result.window).toBe("30d");
    expect(typeof result.totalRevenue).toBe("string");
    // Must be a decimal string representation, not a number
    expect(result.totalRevenue).toBe("123.45");
  });

  it("[SR-2] empty window → totalRevenue = '0.00' (string, not 0)", async () => {
    // Spec scenario: "Empty window returns zero"
    // GIVEN a producer with no SubOrders in the window
    // THEN totalRevenue = "0.00" (decimal string, NOT 0)
    mockedQueryRaw.mockResolvedValueOnce([{ total: null }]);

    const result = await statisticsService.getRevenue("prod_001", "7d", fixedClock);

    expect(result.totalRevenue).toBe("0.00");
    expect(typeof result.totalRevenue).toBe("string");
  });

  it("[SR-3] clock injection — $queryRaw receives exact clock-derived from/to bounds", async () => {
    // Spec scenario: "Deterministic clock in tests"
    // GIVEN now = 2026-01-01T00:00:00Z and window = "7d"
    // THEN from = 2025-12-25T00:00:00Z
    // This test inspects the actual Prisma.sql template values passed to $queryRaw
    // to prove the clock-derived bounds are used as query parameters.
    mockedQueryRaw.mockResolvedValueOnce([{ total: "0" }]);

    const result = await statisticsService.getRevenue("prod_001", "7d", fixedClock);

    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);

    // The service result exposes from/to — these MUST match the fixed clock
    // Because computeDateRange must use clock() for `to` and derive `from` from it
    expect(result.to.getTime()).toBe(FIXED_NOW.getTime());
    expect(result.from.getTime()).toBe(EXPECTED_FROM_7D.getTime());

    // Inspect the Prisma.sql template object passed to $queryRaw.
    // Prisma.sql produces a tagged template with `values` array containing the
    // interpolated parameters. The from and to dates must appear as values.
    const callArg = mockedQueryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(callArg).toBeDefined();
    // callArg.values contains the interpolated parameters in order:
    // [producerId, from, to] — indices 1 and 2 are the date bounds
    const dateValues = callArg.values.filter((v) => v instanceof Date);
    expect(dateValues).toHaveLength(2);
    // The from date must equal the clock-derived from (FIXED_NOW - 7d)
    const fromInQuery = dateValues[0] as Date;
    const toInQuery = dateValues[1] as Date;
    expect(fromInQuery.getTime()).toBe(EXPECTED_FROM_7D.getTime());
    expect(toInQuery.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("[SR-4] cancelled SubOrders excluded — $queryRaw SQL contains status filter", async () => {
    // Spec scenario: "Cancelled SubOrders excluded"
    // GIVEN a producer with a cancelled SubOrder in window
    // THEN the cancelled SubOrder's lines MUST NOT contribute to totalRevenue
    // We verify by inspecting the SQL template string that the status IN
    // ('sent', 'delivered') predicate is present in the raw query.
    mockedQueryRaw.mockResolvedValueOnce([{ total: "50.00" }]);

    const result = await statisticsService.getRevenue("prod_001", "30d", fixedClock);

    expect(result.totalRevenue).toBe("50.00");
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);

    // Inspect the SQL template strings in the Prisma.sql object.
    // Prisma.sql produces { strings: TemplateStringsArray, values: unknown[] }
    const callArg = mockedQueryRaw.mock.calls[0][0] as { strings: readonly string[] };
    expect(callArg.strings).toBeDefined();
    // The SQL must include the sent/delivered status filter — join all string chunks
    const fullSql = callArg.strings.join(" ");
    expect(fullSql).toContain("sent");
    expect(fullSql).toContain("delivered");
    // Cancelled must not appear as an INCLUDED status (it may appear in comments,
    // so we verify the filter uses inclusion — 'sent' and 'delivered' are there)
  });

  it("[SR-5] response includes window, totalRevenue, currency, from, to fields", async () => {
    // Spec: response body includes window, totalRevenue, currency, from, to
    mockedQueryRaw.mockResolvedValueOnce([{ total: "99.99" }]);

    const result = await statisticsService.getRevenue("prod_001", "90d", fixedClock);

    expect(result.window).toBe("90d");
    expect(result.totalRevenue).toBe("99.99");
    expect(result.currency).toBe("EUR");
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    // to should be FIXED_NOW
    expect(result.to).toEqual(FIXED_NOW);
  });

  it("[SR-6] 1y window — lower bound is 365 days before now", async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ total: "1000.00" }]);

    const result = await statisticsService.getRevenue("prod_001", "1y", fixedClock);

    const expectedFrom = new Date("2025-01-01T00:00:00.000Z"); // 365 days before 2026-01-01
    expect(result.from.getTime()).toBe(expectedFrom.getTime());
  });
});

// ===========================================================================
// getOrderCount
// ===========================================================================

describe("statisticsService.getOrderCount", () => {
  it("[SOC-1] returns { window, count: number } — count is integer", async () => {
    mockedSubOrderCount.count.mockResolvedValueOnce(5);

    const result = await statisticsService.getOrderCount("prod_001", "30d", fixedClock);

    expect(result.window).toBe("30d");
    expect(typeof result.count).toBe("number");
    expect(result.count).toBe(5);
  });

  it("[SOC-2] cancelled excluded — subOrder.count receives status.notIn with exact filter", async () => {
    // Spec scenario: "Count excludes cancelled"
    // GIVEN 3 SubOrders: 2 delivered, 1 cancelled → count = 2
    // This test INSPECTS the where-clause passed to prisma.subOrder.count to
    // prove the cancelled exclusion is expressed at the ORM level (not faked).
    mockedSubOrderCount.count.mockResolvedValueOnce(2);

    const result = await statisticsService.getOrderCount("prod_001", "30d", fixedClock);

    expect(result.count).toBe(2);
    expect(mockedSubOrderCount.count).toHaveBeenCalledTimes(1);

    // Inspect the where-clause object passed to prisma.subOrder.count
    const call = mockedSubOrderCount.count.mock.calls[0][0] as {
      where: {
        producerId: string;
        status: { notIn: string[] };
        createdAt: { gte: Date; lte: Date };
      };
    };
    expect(call.where).toBeDefined();
    // Status filter MUST be expressed as notIn to exclude cancelled
    expect(call.where.status).toBeDefined();
    expect(call.where.status.notIn).toBeDefined();
    expect(call.where.status.notIn).toContain("cancelled");
    // The notIn list must NOT include non-cancelled statuses as excluded
    // (pending, preparing, sent, delivered should be counted)
    expect(call.where.status.notIn).not.toContain("pending");
    expect(call.where.status.notIn).not.toContain("delivered");
  });

  it("[SOC-3] clock injection — subOrder.count receives exact clock-derived date bounds", async () => {
    // Spec scenario: "Deterministic clock in tests"
    // Proves the where-clause has exact from/to dates from the injected clock,
    // not from a `new Date()` call inside the service.
    mockedSubOrderCount.count.mockResolvedValueOnce(0);

    await statisticsService.getOrderCount("prod_001", "7d", fixedClock);

    const call = mockedSubOrderCount.count.mock.calls[0][0] as {
      where: {
        producerId: string;
        createdAt: { gte: Date; lte: Date };
      };
    };
    expect(call.where).toBeDefined();
    // producerId scoping
    expect(call.where.producerId).toBe("prod_001");
    // Date bounds MUST match the injected clock exactly
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte.getTime()).toBe(EXPECTED_FROM_7D.getTime());
    expect(call.where.createdAt.lte.getTime()).toBe(FIXED_NOW.getTime());
  });

  it("[SOC-4] response includes window, count, from, to fields", async () => {
    mockedSubOrderCount.count.mockResolvedValueOnce(3);

    const result = await statisticsService.getOrderCount("prod_001", "90d", fixedClock);

    expect(result.window).toBe("90d");
    expect(result.count).toBe(3);
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.to).toEqual(FIXED_NOW);
  });
});

// ===========================================================================
// getLowStock — envelope contract (Corrective RED)
// ===========================================================================

describe("statisticsService.getLowStock — envelope contract", () => {
  it("[SLS-1] returns { items, limit, offset, total } envelope — spec:69-72", async () => {
    // Spec (sales-stats spec.md:69-72):
    //   Response body: { items: [{ productId, name, stock, lowStockThreshold }], limit, offset, total }
    // getLowStock MUST return this envelope, NOT a bare array.
    // findLowStock mock returns Prisma Product shape (id field), service maps id → productId.
    const products = [
      { id: "p1", name: "Cheese", stock: 0, lowStockThreshold: 5 },
      { id: "p2", name: "Honey", stock: 5, lowStockThreshold: 5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce(products as any);
    mockedFindLowStockCount.mockResolvedValueOnce(2);

    const result = await statisticsService.getLowStock("prod_001", {});

    // MUST NOT be an array — must be an envelope object
    expect(Array.isArray(result)).toBe(false);
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("limit");
    expect(result).toHaveProperty("offset");
    expect(result).toHaveProperty("total");
  });

  it("[SLS-1b] items expose productId (not id) — spec field name", async () => {
    // Spec (sales-stats spec.md:70): items: [{ productId, name, stock, lowStockThreshold }]
    // findLowStock returns Prisma Product with `id`; service maps id → productId.
    // Items in the envelope MUST expose `productId`, NOT `id`.
    const products = [
      { id: "p1", name: "Cheese", stock: 0, lowStockThreshold: 5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce(products as any);
    mockedFindLowStockCount.mockResolvedValueOnce(1);

    const result = await statisticsService.getLowStock("prod_001", {});

    expect(result.items).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (result.items as any[])[0];
    // Service maps Prisma Product.id → LowStockItem.productId per spec
    expect(item).toHaveProperty("productId");
    expect(item.productId).toBe("p1");
  });

  it("[SLS-1c] total reflects count before pagination (from findLowStockCount)", async () => {
    // Spec: total must be the count of ALL matching low-stock items, NOT items.length
    // Here pagination returns 2 items but total = 10 (10 low-stock items for producer)
    const products = [
      { id: "p1", name: "Cheese", stock: 0, lowStockThreshold: 5 },
      { id: "p2", name: "Honey", stock: 5, lowStockThreshold: 5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce(products as any);
    mockedFindLowStockCount.mockResolvedValueOnce(10);

    const result = await statisticsService.getLowStock("prod_001", { limit: 2, offset: 0 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(10); // total = all matching, not just page
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(0);
  });

  it("[SLS-2] passes limit and offset through to inventory.findLowStock", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);
    mockedFindLowStockCount.mockResolvedValueOnce(0);

    await statisticsService.getLowStock("prod_001", { limit: 10, offset: 20 });

    expect(mockedFindLowStock).toHaveBeenCalledWith({
      producerId: "prod_001",
      limit: 10,
      offset: 20,
    });
  });

  it("[SLS-3] returns envelope with empty items when no low-stock products", async () => {
    // Spec scenario: products with stock > threshold are excluded
    // Empty result MUST still be an envelope: { items: [], limit, offset, total: 0 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);
    mockedFindLowStockCount.mockResolvedValueOnce(0);

    const result = await statisticsService.getLowStock("prod_001", {});

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ===========================================================================
// Window → date range translation (pure logic)
// ===========================================================================

describe("window date range translation", () => {
  it("[WIN-1] 7d → from = 7 days before now", async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ total: "0" }]);

    const result = await statisticsService.getRevenue("prod_001", "7d", fixedClock);

    const expectedFrom = new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(result.from.getTime()).toBe(expectedFrom.getTime());
  });

  it("[WIN-2] 30d → from = 30 days before now", async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ total: "0" }]);

    const result = await statisticsService.getRevenue("prod_001", "30d", fixedClock);

    const expectedFrom = new Date(FIXED_NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(result.from.getTime()).toBe(expectedFrom.getTime());
  });

  it("[WIN-3] 90d → from = 90 days before now", async () => {
    mockedQueryRaw.mockResolvedValueOnce([{ total: "0" }]);

    const result = await statisticsService.getRevenue("prod_001", "90d", fixedClock);

    const expectedFrom = new Date(FIXED_NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(result.from.getTime()).toBe(expectedFrom.getTime());
  });
});
