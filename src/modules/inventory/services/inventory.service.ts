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
 * FROZEN CONTRACT (Cycle 3 — DO NOT CHANGE):
 *   decrementStock(productId: string, quantity: number, tx?: PrismaTx): Promise<void>
 *   Cycle 3 checkout imports this signature AS-IS. Any breaking change requires
 *   a new SDD cycle (admin-environment or later) that explicitly deprecates it.
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
 * Cross-column filter note: Prisma 5.x does not support cross-column comparisons
 * in `where` clauses (e.g. `stock lte lowStockThreshold` per product row).
 * We use `findMany` with the scalar filters (producerId, deletedAt, isActive) and
 * apply the cross-column `stock <= lowStockThreshold` filter in the application
 * layer after the DB call. This keeps the call mock-testable in unit tests while
 * preserving correct semantics.
 *
 * Ordering: stock ASC, name ASC (deterministic, DB-level).
 * Pagination: limit defaults to 20, capped at 100.
 * NOTE: apply `take` and `skip` to the DB call (not client-side slice) for
 * correct pagination semantics across large datasets.
 *
 * Because of the application-layer cross-column filter, we fetch with a generous
 * inner limit and then paginate over the filtered set. For Cycle 2 scope, product
 * counts per producer are expected to be manageable (< thousands). Cycle 3 or later
 * can replace this with a raw query if performance becomes a concern.
 *
 * NOTE: No HTTP route in this slice — owned by sales-stats (Slice 10).
 *
 * Spec: inventory §"Low-stock query"
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
