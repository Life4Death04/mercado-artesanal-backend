/**
 * Statistics DTOs — Zod schemas for stats endpoint query validation.
 *
 * All Cycle 2 DTOs use `strictObject()` to enforce the strict DTO policy
 * (rejects unknown keys with VALIDATION_FAILED 422 via global errorMap).
 *
 * Spec references:
 *   sales-stats §"Window parameter contract" — exactly 7d | 30d | 90d | 1y allowed
 *   sales-stats scenario "Unknown window rejected" — 422 VALIDATION_FAILED
 *   sales-stats §"Low-stock alerts endpoint" — pagination limit/offset
 *   design — Architecture Decision #1 (strictObject project-wide)
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

// ---------------------------------------------------------------------------
// Window value enum — exact values allowed by spec
// Spec: sales-stats §"Window parameter contract"
// ---------------------------------------------------------------------------

/**
 * Allowed window values for windowed stats endpoints.
 * Any other value MUST be rejected with VALIDATION_FAILED (422).
 *
 * Spec: sales-stats §"Window parameter contract"
 *   EXACTLY these values: 7d, 30d, 90d, 1y
 */
export const WindowSchema = z.enum(["7d", "30d", "90d", "1y"]);

export type WindowValue = z.infer<typeof WindowSchema>;

// ---------------------------------------------------------------------------
// Window query — used by revenue and order-count endpoints
// ---------------------------------------------------------------------------

/**
 * Query parameters for windowed stats endpoints.
 *
 * `window` is required — omitting it returns 422 VALIDATION_FAILED.
 *
 * Spec: sales-stats §"Window parameter contract"
 */
export const WindowQuerySchema = strictObject({
  window: WindowSchema,
});

export type WindowQuery = z.infer<typeof WindowQuerySchema>;

// ---------------------------------------------------------------------------
// Low-stock pagination query
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /producers/me/stats/low-stock.
 *
 * Both `limit` and `offset` are optional; defaults applied in inventory.findLowStock
 * (default 20, cap 100 for limit; default 0 for offset).
 *
 * Spec: sales-stats §"Low-stock alerts endpoint"
 *   Pagination: limit default 20, cap 100
 */
export const LowStockQuerySchema = strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type LowStockQuery = z.infer<typeof LowStockQuerySchema>;
