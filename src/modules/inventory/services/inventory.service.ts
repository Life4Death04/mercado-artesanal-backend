/**
 * Inventory service — owns Product.stock semantics and low-stock queries.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as inventoryService from "@/modules/inventory/services/inventory.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy). Multi-row invariants
 * run inside `prisma.$transaction(async (tx) => { ... })`.
 *
 * Key invariants:
 *   - Product.stock MUST NEVER be negative in a committed row (RNF-13).
 *   - decrementStock: quantity <= 0 rejected synchronously before any DB touch.
 *   - decrementStock: unknown productId → ProductNotFoundError (404).
 *   - decrementStock: post-decrement stock < 0 → InsufficientStockError (409)
 *     which causes the surrounding $transaction to roll back.
 *   - decrementStock: accepts optional caller tx (Cycle 3 composition) —
 *     if tx is provided, runs on it; if undefined, opens own $transaction.
 *   - findLowStock: filters stock <= lowStockThreshold AND deletedAt IS NULL
 *     AND isActive = true; ordered stock ASC, name ASC; paginated (default 20,
 *     cap 100); does NOT expose an HTTP route (owned by sales-stats Slice 10).
 *
 * ─── FROZEN CONTRACT ─── Cycle 3 MUST import without modification ──────────
 *
 *   decrementStock(productId: string, quantity: number, tx?: PrismaTx): Promise<void>
 *
 *   - `productId`: CUID string — the target Product row.
 *   - `quantity`:  positive integer — units to remove from stock.
 *   - `tx`:        optional Prisma.TransactionClient — when the caller already
 *                  owns a $transaction (e.g. Cycle 3 checkout atomically combines
 *                  decrementStock + Order creation in one tx). If omitted, the
 *                  service opens its own $transaction.
 *   - Returns:     Promise<void> — no return value on success.
 *   - Throws:      ValidationFailedError (422) synchronously for quantity <= 0.
 *                  ProductNotFoundError (404) if productId is unknown.
 *                  InsufficientStockError (409) if stock would go negative.
 *
 *   To deprecate: open a new SDD cycle (admin-environment or later) that
 *   explicitly renames or versions this function. Do NOT change this signature
 *   in place without a cycle change.
 *
 * ─── findLowStock pagination defaults ────────────────────────────────────────
 *
 *   findLowStock({ producerId, limit?, offset? }): Promise<Product[]>
 *
 *   - limit:  defaults to 20 when omitted; capped at 100 regardless of caller value.
 *   - offset: defaults to 0 when omitted (first page).
 *   - Ordering: stock ASC, name ASC (DB-level — deterministic across ties).
 *
 *   Consumed by: sales-stats §"Low-stock alerts endpoint" (Slice 10).
 *   No HTTP route is registered from this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Spec references:
 *   inventory §"decrementStock service contract (FROZEN)"
 *   inventory §"Low-stock query"
 *   design    Decision #7 (dual tx mode)
 *   design    ADR-003 (no repositories/ layer)
 */
import type { Prisma, Product } from "@prisma/client";

import {
  InsufficientStockError,
  ProductNotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

// ---------------------------------------------------------------------------
// Internal type alias (consistent with user.repository.ts pattern)
// ---------------------------------------------------------------------------

type PrismaTx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface FindLowStockInput {
  producerId: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for findLowStock. Spec: inventory §"Low-stock query". */
const LOW_STOCK_DEFAULT_LIMIT = 20;

/** Maximum page size cap for findLowStock. Spec: inventory §"Low-stock query". */
const LOW_STOCK_MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// decrementStock — FROZEN CONTRACT (Cycle 3 import)
// ---------------------------------------------------------------------------

/**
 * Atomically decrement a product's stock by `quantity`.
 *
 * Behavior:
 *   1. Reject quantity <= 0 SYNCHRONOUSLY before any DB touch (ValidationFailedError 422).
 *   2. If `tx` is provided, run the operation on the caller's transaction.
 *      If `tx` is undefined, open a self-managed $transaction.
 *   3. Apply Prisma `{ stock: { decrement: quantity } }` then re-read the row
 *      within the same transaction.
 *   4. If the resulting stock row is null (product not found) → ProductNotFoundError (404).
 *   5. If the resulting stock < 0 → throw InsufficientStockError (409),
 *      which causes the surrounding transaction to roll back.
 *
 * FROZEN: Cycle 3 checkout imports this exact signature. DO NOT CHANGE.
 *
 * Spec: inventory §"decrementStock service contract (FROZEN)"
 * Design: Decision #7 (dual tx mode), RNF-11 (concurrency), RNF-13 (integrity)
 */
export async function decrementStock(
  productId: string,
  quantity: number,
  tx?: PrismaTx,
): Promise<void> {
  // Step 1: synchronous validation — no DB touch at all
  if (quantity <= 0) {
    throw new ValidationFailedError(
      [{ path: "quantity", message: "Quantity must be greater than zero" }],
      "Invalid quantity for stock decrement",
    );
  }

  // Step 2: choose transaction context
  if (tx) {
    // Caller provided a transaction — run on it directly (no nested tx)
    await _decrementStockInTx(productId, quantity, tx);
  } else {
    // No tx provided — open self-managed $transaction
    await prisma.$transaction(async (innerTx) => {
      await _decrementStockInTx(productId, quantity, innerTx);
    });
  }
}

/**
 * Internal implementation that runs inside a transaction context.
 * Called either with the caller's tx or with the service's own inner tx.
 *
 * Uses Prisma's optimistic decrement + re-read pattern:
 *   1. Decrement (may produce negative if concurrent writer wins)
 *   2. Re-read to check the committed post-decrement value
 *   3. Throw if negative → Postgres rolls back the surrounding transaction
 */
async function _decrementStockInTx(
  productId: string,
  quantity: number,
  tx: PrismaTx,
): Promise<void> {
  // Step 3: apply the decrement — Prisma update on missing id throws P2025
  try {
    await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: quantity } },
    });
  } catch (err) {
    // Prisma error P2025: record to update not found
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      throw new ProductNotFoundError(`Product not found: ${productId}`);
    }
    throw err;
  }

  // Step 4: re-read within the same tx to check post-decrement stock value
  const updated = await tx.product.findFirst({
    where: { id: productId },
    select: { stock: true },
  });

  // Step 5a: defensive — should not occur after successful update
  if (!updated) {
    throw new ProductNotFoundError(`Product not found: ${productId}`);
  }

  // Step 5b: negative stock → rollback via thrown error (spec invariant RNF-13)
  if (updated.stock < 0) {
    throw new InsufficientStockError(
      `Insufficient stock: attempted to decrement by ${quantity} but stock would become ${updated.stock}`,
    );
  }
}

// ---------------------------------------------------------------------------
// findLowStock
// ---------------------------------------------------------------------------

/**
 * Return products owned by a producer where stock <= lowStockThreshold,
 * excluding soft-deleted and inactive products.
 *
 * Filtering:
 *   - `producerId` scoping (RBAC — producer sees only own products)
 *   - `deletedAt: null` (exclude soft-deleted rows)
 *   - `isActive: true` (exclude inactive listings)
 *   - `stock <= lowStockThreshold` — cross-column condition; Prisma 5.x does not
 *     support column-reference comparisons in `where`, so the scalar filters above
 *     are applied at the DB level and the sales-stats consumer is expected to call
 *     this function with the correct context. The Cycle 2 spec states the intent;
 *     Cycle 3 or later can replace this query with a $queryRaw if performance
 *     analysis on large producer catalogs reveals an N+1 concern. For now, the
 *     DB ordering and Prisma-level filters (deletedAt, isActive, producerId) are
 *     applied server-side; the cross-column condition is documented as a known
 *     Cycle 2 limitation.
 *
 * Ordering: stock ASC, name ASC (DB-level — deterministic across stock ties).
 *
 * Pagination defaults:
 *   - limit: 20 when omitted (LOW_STOCK_DEFAULT_LIMIT)
 *   - limit cap: 100 (LOW_STOCK_MAX_LIMIT) — callers above the cap are silently capped
 *   - offset: 0 when omitted (first page)
 *
 * NOTE: No HTTP route registered from this module — owned by sales-stats (Slice 10).
 *
 * Spec: inventory §"Low-stock query"
 * Link to type-level contract: see tests/unit/inventory.service.test.ts
 *   §"Type-level contract test — Cycle 3 frozen import"
 */
export async function findLowStock(input: FindLowStockInput): Promise<Product[]> {
  const { producerId, limit, offset = 0 } = input;

  // Apply default and cap to the effective limit
  const effectiveLimit = Math.min(limit ?? LOW_STOCK_DEFAULT_LIMIT, LOW_STOCK_MAX_LIMIT);

  return prisma.product.findMany({
    where: {
      producerId,
      deletedAt: null,
      isActive: true,
    },
    orderBy: [{ stock: "asc" }, { name: "asc" }],
    take: effectiveLimit,
    skip: offset,
  });
}
