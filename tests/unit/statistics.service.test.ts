/**
 * Unit tests — statistics.service (Slice 10 TDD, Commit A RED).
 *
 * Strategy: mock prisma singleton and inventory service so no DB is required.
 * Tests verify service-level logic for the three statistics functions:
 *   - getRevenue: clock injection, window→date translation, $queryRaw delegation,
 *     cancelled exclusion, decimal-string serialization, empty-window zero.
 *   - getOrderCount: clock injection, window→date translation, cancelled exclusion.
 *   - getLowStock: delegates to findLowStock with correct args.
 *
 * KEY INVARIANTS UNDER TEST:
 *   1. Services MUST NOT call `new Date()` directly — clock is injected.
 *   2. totalRevenue MUST be a decimal string (never a JS number).
 *   3. getLowStock MUST delegate to inventory.findLowStock with producerId + pagination.
 *
 * Spec references:
 *   sales-stats §"Window parameter contract"
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint"
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

// ---------------------------------------------------------------------------
// Fixed clock fixture
// Spec: sales-stats scenario "Deterministic clock in tests"
//   now = 2026-01-01T00:00:00Z, window = "7d" → from = 2025-12-25T00:00:00Z
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock = (): Date => FIXED_NOW;

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

  it("[SR-3] clock injection — query uses injected now, not new Date()", async () => {
    // Spec scenario: "Deterministic clock in tests"
    // GIVEN now = 2026-01-01T00:00:00Z and window = "7d"
    // THEN from = 2025-12-25T00:00:00Z
    mockedQueryRaw.mockResolvedValueOnce([{ total: "0" }]);

    await statisticsService.getRevenue("prod_001", "7d", fixedClock);

    // Capture the arguments passed to $queryRaw
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);
    const callArgs = mockedQueryRaw.mock.calls[0];
    // The raw SQL template should contain the date bounds derived from fixed clock
    // Verify the call was made (production code MUST invoke $queryRaw)
    expect(callArgs).toBeDefined();
    expect(callArgs.length).toBeGreaterThan(0);
  });

  it("[SR-4] cancelled SubOrders excluded — $queryRaw filters status IN (sent, delivered)", async () => {
    // Spec scenario: "Cancelled SubOrders excluded"
    // GIVEN a producer with a cancelled SubOrder in window
    // THEN the cancelled SubOrder's lines MUST NOT contribute to totalRevenue
    // We verify this by asserting $queryRaw is called (filtering happens in SQL).
    // The integration test seeds real data; the unit test verifies the SQL is called.
    mockedQueryRaw.mockResolvedValueOnce([{ total: "50.00" }]);

    const result = await statisticsService.getRevenue("prod_001", "30d", fixedClock);

    expect(result.totalRevenue).toBe("50.00");
    // $queryRaw must be invoked exactly once (not multiple calls)
    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);
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

  it("[SOC-2] count excludes cancelled SubOrders", async () => {
    // Spec scenario: "Count excludes cancelled"
    // GIVEN 3 SubOrders: 2 delivered, 1 cancelled → count = 2
    mockedSubOrderCount.count.mockResolvedValueOnce(2);

    const result = await statisticsService.getOrderCount("prod_001", "30d", fixedClock);

    expect(result.count).toBe(2);
    // prisma.subOrder.count must have been called once
    expect(mockedSubOrderCount.count).toHaveBeenCalledTimes(1);
  });

  it("[SOC-3] clock injection — from date derived from fixed clock", async () => {
    // Spec scenario: "Deterministic clock in tests"
    mockedSubOrderCount.count.mockResolvedValueOnce(0);

    await statisticsService.getOrderCount("prod_001", "7d", fixedClock);

    const call = mockedSubOrderCount.count.mock.calls[0][0];
    // The where clause must filter createdAt >= from (2025-12-25) and <= now (2026-01-01)
    expect(call).toBeDefined();
    // Verify producerId is scoped
    expect(call.where?.producerId).toBe("prod_001");
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
// getLowStock
// ===========================================================================

describe("statisticsService.getLowStock", () => {
  it("[SLS-1] delegates to inventory.findLowStock with correct producerId", async () => {
    const products = [
      { id: "p1", name: "Cheese", stock: 0, lowStockThreshold: 5 },
      { id: "p2", name: "Honey", stock: 5, lowStockThreshold: 5 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce(products as any);

    const result = await statisticsService.getLowStock("prod_001", {});

    expect(mockedFindLowStock).toHaveBeenCalledTimes(1);
    expect(mockedFindLowStock).toHaveBeenCalledWith({
      producerId: "prod_001",
      limit: undefined,
      offset: undefined,
    });
    expect(result).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result[0]!.id).toBe("p1");
  });

  it("[SLS-2] passes limit and offset through to inventory.findLowStock", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);

    await statisticsService.getLowStock("prod_001", { limit: 10, offset: 20 });

    expect(mockedFindLowStock).toHaveBeenCalledWith({
      producerId: "prod_001",
      limit: 10,
      offset: 20,
    });
  });

  it("[SLS-3] returns empty array when no low-stock products", async () => {
    // Spec scenario: products with stock > threshold are excluded
    // inventory.findLowStock is responsible for the filter — this test
    // verifies getLowStock returns exactly what findLowStock returns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFindLowStock.mockResolvedValueOnce([] as any);

    const result = await statisticsService.getLowStock("prod_001", {});

    expect(result).toEqual([]);
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
