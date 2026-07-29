/**
 * Orders DTOs — response view mapping for the read surface (WU3).
 *
 * Unlike cart/sub-orders DTOs (request-body Zod schemas only), the orders
 * read surface has NO request body or query params to validate — both
 * `GET /pedidos` and `GET /pedidos/:id` are unparameterized reads scoped to
 * `req.user.id` (route param `:id` is a raw string, matching the
 * `sub-orders.controller.ts` precedent for id params: no Zod schema).
 *
 * This file instead hosts the `OrderSummaryView` response shape (frozen by
 * spec §Response Shapes) and its PURE mapping function, kept separate from
 * `orders.service.ts` deliberately so it is testable with ZERO Prisma mocks
 * (strict-tdd "Pure Function Preference" + "Extract-Before-Mock Rule").
 *
 * `status` and `producerCount` are passed in ALREADY COMPUTED by the caller
 * (`orders.service.ts`) rather than derived here — `deriveOrderStatus` stays
 * the SOLE authority for `Order.status` (design Decision 2); duplicating
 * that derivation in this file would violate that invariant AND introduce a
 * runtime circular import between `dto.ts` and `service.ts`. This keeps
 * `mapOrderSummaryView` a true pure function: given the same row, it always
 * returns the same view, with no dependency on `orders.service.ts` beyond a
 * type-only import (erased at compile time, zero runtime coupling).
 *
 * Spec references:
 *   orders §"Response Shapes" — OrderSummaryView
 *   orders §"GET /pedidos returns owner-scoped summary history"
 *   design Decision 2 (deriveOrderStatus sole authority), Decision 6 (module layout)
 */
import { Prisma } from "@prisma/client";

import type { OrderStatusValue } from "../services/orders.service";

type DecimalValue = InstanceType<typeof Prisma.Decimal>;

// ---------------------------------------------------------------------------
// OrderSummaryView — frozen by spec §Response Shapes
// ---------------------------------------------------------------------------

export interface OrderSummaryView {
  id: string;
  createdAt: string;
  totalAmount: string;
  status: OrderStatusValue;
  producerCount: number;
}

/**
 * Internal row shape consumed by `mapOrderSummaryView`. `status` and
 * `producerCount` are pre-computed by the caller (`orders.service.ts`):
 *   - `status` via the single `deriveOrderStatus` authority (design Decision 2).
 *   - `producerCount` as `subOrders.length` — each `SubOrder` is created for
 *     exactly one distinct producer at checkout time (design Decision 4,
 *     step 6 groups `cartView.items` by `producerId`), so the count of
 *     `SubOrder` rows under an `Order` IS the distinct producer count.
 */
export interface OrderSummaryRow {
  id: string;
  createdAt: Date;
  totalAmount: DecimalValue;
  status: OrderStatusValue;
  producerCount: number;
}

/**
 * Maps an `OrderSummaryRow` to the frozen `OrderSummaryView` wire shape.
 * Pure function — no I/O, no Prisma calls, no derivation logic. Given the
 * same input it always returns the same output.
 *
 * Spec: orders §"Response Shapes" — OrderSummaryView
 * Spec: orders §"Summary reports derived status and producer count"
 */
export function mapOrderSummaryView(row: OrderSummaryRow): OrderSummaryView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    totalAmount: row.totalAmount.toFixed(2),
    status: row.status,
    producerCount: row.producerCount,
  };
}
