/**
 * Sub-orders service — producer-scoped read + state-machine transition.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as subOrdersService from "@/modules/sub-orders/services/sub-orders.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma.* directly
 * per ADR-003 (architecture/repository-layer-policy).
 * NOTE: tasks.md line 89 references a `repositories/` folder, but ADR-003
 * (enforced in Slices 3–7) forbids it. design.md is the authoritative source.
 * Decision: follow design.md, no repositories/ layer. See apply-progress §"ADR-003 decision".
 *
 * Key invariants:
 *   - findAll: filters by producerId; optional status filter forwarded to DB.
 *     Ordered by createdAt DESC, paginated (default 20, cap 100).
 *   - findById: findFirst({ where: { id, producerId } }) with orderLines include
 *     — cross-producer returns NotFoundError (404, no-leak).
 *   - transition: runs inside $transaction:
 *       1. findFirst guard (404-no-leak on cross-producer)
 *       2. if current.status === target → early return (idempotent no-op, Decision #3)
 *       3. validate transition against state machine table
 *       4. if invalid → InvalidOrderTransitionError (409)
 *       5. if valid → subOrder.update({ status: target })
 *
 * State machine (from design.md):
 *   pending   → preparing | cancelled
 *   preparing → sent | cancelled
 *   sent      → delivered
 *   delivered → (terminal)
 *   cancelled → (terminal)
 *
 * Design references:
 *   design §"State machine (SubOrder)"
 *   design Architecture Decision #3: idempotent PATCH — early return before update
 *   spec order-fulfillment §"Producer read of own SubOrders"
 *   spec order-fulfillment §"State machine"
 *   spec order-fulfillment §"Idempotent transitions"
 *   spec order-fulfillment §"Tracking number deferred" — trackingNumber stays null
 */
import type { SubOrder, SubOrderStatus } from "@prisma/client";

import { InvalidOrderTransitionError, NotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type { ListSubOrdersQuery, PatchSubOrderBody, SubOrderStatusValue } from "../dto/sub-orders.dto";

// ---------------------------------------------------------------------------
// State machine definition
// Spec: order-fulfillment §"State machine" — allowed transitions table
// ---------------------------------------------------------------------------

/**
 * Allowed state machine transitions.
 * Key: current status. Value: set of valid target statuses.
 *
 * Terminal states (delivered, cancelled) have no valid targets — missing
 * from this map means "no transitions allowed".
 *
 * Spec: order-fulfillment §"State machine"
 *   pending   → preparing | cancelled
 *   preparing → sent | cancelled
 *   sent      → delivered
 *   delivered → (terminal — no further transitions)
 *   cancelled → (terminal — no further transitions)
 */
const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly SubOrderStatusValue[]>> = {
  pending: ["preparing", "cancelled"],
  preparing: ["sent", "cancelled"],
  sent: ["delivered"],
  // delivered and cancelled intentionally absent — terminal states have no allowed targets.
  // A missing key in this map triggers InvalidOrderTransitionError (allowedTargets = []).
} as const;

/**
 * Returns true if the given status is a terminal state (no transitions possible).
 * Pure function — useful for callers (e.g., Cycle 9 producer soft-delete guard).
 *
 * Spec: order-fulfillment §"State machine" — terminal states: delivered, cancelled.
 */
export function isTerminalStatus(status: SubOrderStatusValue): boolean {
  return !(status in ALLOWED_TRANSITIONS);
}

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

/**
 * List SubOrders owned by a producer with optional status filter.
 *
 * Producer-scoping: filters strictly by `producerId` — a producer NEVER
 * sees another producer's SubOrders.
 *
 * Pagination: default 20 rows per page, cap 100.
 * Ordering: createdAt DESC (most recent first).
 *
 * Spec: order-fulfillment §"Producer read of own SubOrders"
 *   - list where producerId = req.user.producer.id
 *   - filterable by status
 *   - paginated (default 20, cap 100)
 *   - ordered createdAt DESC
 */
export async function findAll(
  producerId: string,
  query?: Partial<Pick<ListSubOrdersQuery, "status" | "page" | "limit">>,
): Promise<SubOrder[]> {
  const page = query?.page ?? 1;
  const limit = Math.min(query?.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  return prisma.subOrder.findMany({
    where: {
      producerId,
      ...(query?.status !== undefined && { status: query.status as SubOrderStatus }),
    },
    include: {
      orderLines: true,
    },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

/**
 * Get a single SubOrder by id, scoped to the producer.
 * Includes orderLines so the caller receives the full SubOrder + lines view.
 *
 * Owner-scoping: `findFirst({ where: { id, producerId } })` — cross-producer
 * access returns `NotFoundError` (404) without revealing that the resource
 * exists for another producer (no-leak pattern).
 *
 * Spec: order-fulfillment §"Producer read of own SubOrders"
 *   - GET /producers/me/sub-orders/:id — single SubOrder with its OrderLines
 *   - Cross-producer reads MUST return 404
 * Spec scenario: "Cross-producer read returns 404"
 */
export async function findById(
  producerId: string,
  id: string,
): Promise<SubOrder & { orderLines: unknown[] }> {
  const subOrder = await prisma.subOrder.findFirst({
    where: { id, producerId },
    include: { orderLines: true },
  });

  if (!subOrder) {
    throw new NotFoundError("SubOrder not found");
  }

  return subOrder as SubOrder & { orderLines: unknown[] };
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

/**
 * Transition a SubOrder's status via the producer state machine.
 *
 * Runs inside `$transaction` to prevent TOCTOU between the read and write:
 *   1. findFirst({ where: { id, producerId } }) — 404-no-leak on cross-producer.
 *   2. Idempotent no-op: if current.status === target, return current WITHOUT
 *      calling update (Decision #3 — updatedAt must not change on retries).
 *   3. Validate transition against ALLOWED_TRANSITIONS table.
 *      If invalid → throw InvalidOrderTransitionError (409).
 *   4. If valid → tx.subOrder.update({ status: target }).
 *
 * Spec: order-fulfillment §"State machine"
 * Spec scenario: "Valid transition succeeds"
 * Spec scenario: "Invalid transition rejected"
 * Spec: order-fulfillment §"Idempotent transitions"
 * Spec scenario: "Idempotent no-op does not touch the row"
 * Design Architecture Decision #3 — idempotent PATCH: early return before update.
 */
export async function transition(
  producerId: string,
  id: string,
  input: PatchSubOrderBody,
): Promise<SubOrder> {
  return prisma.$transaction(async (tx) => {
    // Step 1: ownership guard — 404-no-leak
    const current = await tx.subOrder.findFirst({
      where: { id, producerId },
    });

    if (!current) {
      throw new NotFoundError("SubOrder not found");
    }

    const target = input.status as SubOrderStatusValue;

    // Step 2: idempotent no-op — if already in target state, return current row unchanged.
    // Decision #3: no UPDATE is issued; updatedAt is untouched.
    // Spec: "The service MUST NOT issue any UPDATE to the row; updatedAt MUST remain unchanged."
    if (current.status === target) {
      return current;
    }

    // Step 3: validate transition
    const allowedTargets = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowedTargets.includes(target)) {
      throw new InvalidOrderTransitionError(
        `Transition from '${current.status}' to '${target}' is not allowed`,
      );
    }

    // Step 4: valid transition — update the row
    return tx.subOrder.update({
      where: { id },
      data: { status: target as SubOrderStatus },
    });
  });
}
