/**
 * Statistics service — producer sales dashboard (Slice 10).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as statisticsService from "@/modules/statistics/services/statistics.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 * NOTE: tasks.md Commit A GREEN references `repositories/` folder, but ADR-003
 * (enforced in Slices 3–9) forbids it. design.md is the authoritative source.
 *
 * Key invariants (spec: sales-stats §Invariants):
 *   1. Every monetary aggregate MUST be serialized as a decimal string (never number).
 *   2. Clock MUST be injected — NEVER call `new Date()` directly inside this service.
 *      Use the injected `clock` parameter (defaults to `systemClock`).
 *
 * Window → date range: [now - window, now] where `now` comes from the injected clock.
 *   7d  → 7 * 24 * 60 * 60 * 1000 ms
 *   30d → 30 * 24 * 60 * 60 * 1000 ms
 *   90d → 90 * 24 * 60 * 60 * 1000 ms
 *   1y  → 365 * 24 * 60 * 60 * 1000 ms
 *
 * Revenue aggregation uses prisma.$queryRaw (consistent with inventory.findLowStock
 * precedent from Slice 5). Postgres SUM returns NUMERIC; coerced to decimal string
 * via String() — NOT parseFloat() to avoid precision loss.
 *
 * Spec references:
 *   sales-stats §"Window parameter contract"
 *   sales-stats §"Revenue window endpoint"
 *   sales-stats §"Order count endpoint"
 *   sales-stats §"Low-stock alerts endpoint"
 *   sales-stats §Invariants
 *   design §"Sales-stats clock injection"
 *   design ADR-003 (no repositories/ layer)
 */
import { Prisma } from "@prisma/client";
import type { Product } from "@prisma/client";

import { findLowStock } from "@/modules/inventory/services/inventory.service";
import { prisma } from "@/shared/utils/prisma";
import { systemClock } from "@/shared/utils/clock";
import type { Clock } from "@/shared/utils/clock";
import type { WindowValue, LowStockQuery } from "../dto/statistics.dto";

// ---------------------------------------------------------------------------
// Window → milliseconds map
// Spec: sales-stats §"Window parameter contract"
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<WindowValue, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Internal helper — compute [from, to] date range from window + clock
// ---------------------------------------------------------------------------

/**
 * Compute the [from, to] date range for a window using the injected clock.
 *
 * - `to` = clock() (injected current time)
 * - `from` = to - windowMs
 *
 * NEVER calls `new Date()` directly — uses the injected clock exclusively.
 *
 * Spec scenario: "Deterministic clock in tests"
 *   GIVEN now = 2026-01-01T00:00:00Z and window = "7d"
 *   THEN from = 2025-12-25T00:00:00Z
 */
function computeDateRange(window: WindowValue, clock: Clock): { from: Date; to: Date } {
  const to = clock();
  const from = new Date(to.getTime() - WINDOW_MS[window]);
  return { from, to };
}

// ---------------------------------------------------------------------------
// Revenue aggregate row shape returned by $queryRaw
// ---------------------------------------------------------------------------

interface RevenueRow {
  total: string | null;
}

// ---------------------------------------------------------------------------
// getRevenue
// ---------------------------------------------------------------------------

/**
 * Aggregate revenue for a producer within the given window.
 *
 * Implementation:
 *   - Uses $queryRaw to perform SUM(quantity * unit_price_snapshot) at the DB level.
 *   - Filters: producerId, status IN ('sent', 'delivered'), createdAt IN [from, to].
 *   - Shipping cost is NOT counted (spec: "shipping cost MUST NOT be counted as revenue").
 *   - NULL result (no rows) → "0.00" (decimal string, not 0).
 *   - totalRevenue MUST be a decimal string — never a JS number (spec invariant).
 *
 * Spec: sales-stats §"Revenue window endpoint"
 * Spec scenario: "Cancelled SubOrders excluded"
 * Spec scenario: "Empty window returns zero"
 * Spec invariant: "totalRevenue MUST be serialized as a decimal string"
 *
 * @param producerId - The producer's ID (from req.user.producerId after requireRole).
 * @param window     - One of "7d" | "30d" | "90d" | "1y".
 * @param clock      - Injectable clock (default: systemClock). Tests inject a fixed clock.
 */
export async function getRevenue(
  producerId: string,
  window: WindowValue,
  clock: Clock = systemClock,
): Promise<{ window: WindowValue; totalRevenue: string; currency: "EUR"; from: Date; to: Date }> {
  const { from, to } = computeDateRange(window, clock);

  // $queryRaw: SUM(quantity * unit_price_snapshot) for all non-cancelled SubOrders.
  // Cancelled SubOrders (status = 'cancelled') are EXCLUDED per spec.
  // Only 'sent' and 'delivered' statuses are revenue-generating.
  // Joins SubOrder → OrderLine for the line-level aggregation.
  const rows = await prisma.$queryRaw<RevenueRow[]>(
    Prisma.sql`
      SELECT
        COALESCE(
          SUM(ol.quantity * ol.unit_price_snapshot)::text,
          '0.00'
        ) AS total
      FROM sub_orders so
      JOIN order_lines ol ON ol.sub_order_id = so.id
      WHERE
        so.producer_id = ${producerId}
        AND so.status IN ('sent', 'delivered')
        AND so.created_at >= ${from}
        AND so.created_at <= ${to}
    `,
  );

  const rawTotal = rows[0]?.total ?? null;

  // Spec invariant: totalRevenue MUST be a decimal string (never a JS number).
  // Use String() coercion, NOT parseFloat(), to preserve full precision.
  const totalRevenue = rawTotal == null || rawTotal === "" ? "0.00" : String(rawTotal);

  return { window, totalRevenue, currency: "EUR", from, to };
}

// ---------------------------------------------------------------------------
// getOrderCount
// ---------------------------------------------------------------------------

/**
 * Count distinct SubOrders for a producer within the given window.
 *
 * Filters:
 *   - producerId = req.user.producerId
 *   - status IN ('pending', 'preparing', 'sent', 'delivered') — cancelled EXCLUDED
 *   - createdAt IN [from, to]
 *
 * Spec: sales-stats §"Order count endpoint"
 * Spec scenario: "Count excludes cancelled"
 *
 * @param producerId - The producer's ID.
 * @param window     - One of "7d" | "30d" | "90d" | "1y".
 * @param clock      - Injectable clock (default: systemClock). Tests inject a fixed clock.
 */
export async function getOrderCount(
  producerId: string,
  window: WindowValue,
  clock: Clock = systemClock,
): Promise<{ window: WindowValue; count: number; from: Date; to: Date }> {
  const { from, to } = computeDateRange(window, clock);

  const count = await prisma.subOrder.count({
    where: {
      producerId,
      // Spec scenario: "Count excludes cancelled"
      // Include only non-cancelled statuses: pending, preparing, sent, delivered
      status: {
        notIn: ["cancelled"],
      },
      createdAt: {
        gte: from,
        lte: to,
      },
    },
  });

  return { window, count, from, to };
}

// ---------------------------------------------------------------------------
// getLowStock
// ---------------------------------------------------------------------------

/**
 * Return low-stock products for a producer.
 *
 * Thin delegate to `inventory.findLowStock` — this service does NOT
 * own the low-stock query logic. The `statistics` module provides the
 * HTTP surface; the `inventory` module owns the query.
 *
 * Spec: sales-stats §"Low-stock alerts endpoint"
 * Spec scenario: "Returns products at or below threshold"
 *
 * @param producerId - The producer's ID.
 * @param pagination - Optional limit and offset (inventory defaults: limit=20, offset=0).
 */
export async function getLowStock(
  producerId: string,
  pagination: Pick<LowStockQuery, "limit" | "offset">,
): Promise<Product[]> {
  return findLowStock({
    producerId,
    limit: pagination.limit,
    offset: pagination.offset,
  });
}
