/**
 * Delivery-modes service — producer-scoped CRUD with delete guard.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as deliveryModesService from "@/modules/delivery-modes/services/delivery-modes.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 *
 * Key invariants:
 *   - create: validates PICKUP+pickupLocation guard BEFORE any DB write.
 *   - findAll: filters by producerId — returns only own delivery modes.
 *   - findById: findFirst({ where: { id, producerId } }) — cross-producer returns 404 (no-leak).
 *   - update: runs inside $transaction; findFirst guard before update.
 *   - hardDelete: runs inside $transaction:
 *       1. findFirst guard (404-no-leak on cross-producer)
 *       2. subOrder.count (active status filter: pending, preparing, sent)
 *       3. if count > 0 → ProducerHasActiveOrdersError (409) — reused per design §"Delivery-modes delete guard"
 *       4. if count === 0 → deliveryMode.delete
 *
 * Design references:
 *   design §"Delivery-modes delete guard": reuse ProducerHasActiveOrdersError (409)
 *   design ADR-003: no repositories/ layer
 *   spec delivery-modes §"Producer-scoped CRUD", §"PICKUP without pickupLocation rejected",
 *                        §"Cross-producer read returns 404", §"Delete blocked by active SubOrder reference"
 */
import type { DeliveryMode, SubOrderStatus } from "@prisma/client";

import {
  DeliveryModeNotFoundError,
  ProducerHasActiveOrdersError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type {
  CreateDeliveryModeBody,
  UpdateDeliveryModeBody,
} from "../dto/delivery-modes.dto";

// ---------------------------------------------------------------------------
// Active SubOrder statuses for the delete guard
// Spec: delivery-modes §"Delete blocked by active SubOrder reference"
// Design: count SubOrder rows where status IN (pending, preparing, sent)
// ---------------------------------------------------------------------------
const ACTIVE_SUBORDER_STATUSES: SubOrderStatus[] = ["pending", "preparing", "sent"];

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create a new delivery mode for a producer.
 *
 * PICKUP guard: if type === 'PICKUP' and pickupLocation is absent/empty,
 * throw ValidationFailedError (422). The test expects VALIDATION_FAILED code.
 *
 * Spec: delivery-modes §"PICKUP without pickupLocation rejected"
 */
export async function create(
  producerId: string,
  input: CreateDeliveryModeBody,
): Promise<DeliveryMode> {
  // PICKUP guard — enforced at service layer per spec/design.
  // Produces VALIDATION_FAILED (422) when PICKUP has no pickupLocation.
  if (input.type === "PICKUP" && !input.pickupLocation) {
    throw new ValidationFailedError([
      {
        path: "pickupLocation",
        message: "pickupLocation is required when type is PICKUP",
      },
    ]);
  }

  return prisma.deliveryMode.create({
    data: {
      producerId,
      type: input.type,
      cost: input.cost,
      coverageZone: input.coverageZone ?? null,
      pickupLocation: input.pickupLocation ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

/**
 * List all delivery modes owned by a producer.
 * Returns an empty array if the producer has none.
 *
 * Owner-scoping: filters strictly by `producerId` — a producer NEVER sees
 * another producer's rows. No cross-producer leakage is possible.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — list
 */
export async function findAll(producerId: string): Promise<DeliveryMode[]> {
  return prisma.deliveryMode.findMany({
    where: { producerId },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

/**
 * Get a single delivery mode by id, scoped to the producer.
 *
 * Owner-scoping: `findFirst({ where: { id, producerId } })` — cross-producer
 * access returns `DeliveryModeNotFoundError` (404) without revealing that the
 * resource exists for another producer (no-leak pattern).
 *
 * Spec: delivery-modes §"Cross-producer read returns 404"
 */
export async function findById(
  producerId: string,
  id: string,
): Promise<DeliveryMode> {
  const dm = await prisma.deliveryMode.findFirst({
    where: { id, producerId },
  });

  if (!dm) {
    throw new DeliveryModeNotFoundError("Delivery mode not found");
  }

  return dm;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * Partially update a delivery mode owned by the producer.
 * Runs inside $transaction: findFirst guard → update.
 * Cross-producer: DeliveryModeNotFoundError (404) — no-leak.
 *
 * Spec: delivery-modes §"Producer-scoped CRUD" — update
 */
export async function update(
  producerId: string,
  id: string,
  input: UpdateDeliveryModeBody,
): Promise<DeliveryMode> {
  return prisma.$transaction(async (tx) => {
    const dm = await tx.deliveryMode.findFirst({ where: { id, producerId } });

    if (!dm) {
      throw new DeliveryModeNotFoundError("Delivery mode not found");
    }

    return tx.deliveryMode.update({
      where: { id },
      data: {
        ...(input.type !== undefined && { type: input.type }),
        ...(input.cost !== undefined && { cost: input.cost }),
        ...(input.coverageZone !== undefined && { coverageZone: input.coverageZone }),
        ...(input.pickupLocation !== undefined && { pickupLocation: input.pickupLocation }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// hardDelete
// ---------------------------------------------------------------------------

/**
 * Hard-delete a delivery mode owned by the producer.
 *
 * Runs inside `$transaction` to avoid TOCTOU:
 *   1. `findFirst({ where: { id, producerId } })` — 404-no-leak on cross-producer access.
 *   2. `subOrder.count({ where: { deliveryModeId: id, status: { in: ACTIVE_SUBORDER_STATUSES } } })`
 *      — counts SubOrders in status `pending | preparing | sent` referencing this delivery mode.
 *   3. If count > 0 → throw `ProducerHasActiveOrdersError` (409, `PRODUCER_HAS_ACTIVE_ORDERS`).
 *      Design decision: reuse the canonical `ProducerHasActiveOrdersError` from
 *      `src/shared/errors/errors.ts` — the guard semantics are identical to the producer
 *      soft-delete guard and the spec only requires 409 without prescribing a new error code.
 *      See design §"Delivery-modes delete guard".
 *   4. If count === 0 → `deliveryMode.delete({ where: { id } })`.
 *
 * Transaction rationale: steps 2–4 must be atomic. Without the transaction,
 * a concurrent SubOrder creation between step 2 (count) and step 4 (delete)
 * could leave an orphaned deliveryModeId FK reference.
 *
 * Spec: delivery-modes §"Delete blocked by active SubOrder reference"
 * Design: §"Delivery-modes delete guard" — reuse ProducerHasActiveOrdersError (canonical)
 */
export async function hardDelete(
  producerId: string,
  id: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Step 1: ownership guard — 404-no-leak
    const dm = await tx.deliveryMode.findFirst({ where: { id, producerId } });

    if (!dm) {
      throw new DeliveryModeNotFoundError("Delivery mode not found");
    }

    // Step 2: count active SubOrders referencing this delivery mode
    const activeCount = await tx.subOrder.count({
      where: {
        deliveryModeId: id,
        status: { in: ACTIVE_SUBORDER_STATUSES },
      },
    });

    // Step 3: block delete if active SubOrders exist
    if (activeCount > 0) {
      throw new ProducerHasActiveOrdersError(
        "Cannot delete delivery mode: it is referenced by one or more active sub-orders",
      );
    }

    // Step 4: hard-delete
    await tx.deliveryMode.delete({ where: { id } });
  });
}
