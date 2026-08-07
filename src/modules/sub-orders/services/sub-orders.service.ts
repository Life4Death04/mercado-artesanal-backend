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
 *       1. findFirst guard (404-no-leak on cross-producer) — includes deliveryMode.type
 *       2. trackingNumber gate (order-fulfillment MODIFIED) — BEFORE the no-op
 *          early-return (design Decision #3); throws ValidationFailedError (422)
 *       3. if current.status === target → early return (idempotent no-op)
 *       4. validate transition against state machine table
 *       5. if invalid → InvalidOrderTransitionError (409)
 *       6. if valid → subOrder.update({ status: target, trackingNumber? })
 *          (trackingNumber only ever persisted on entry into `sent`)
 *
 * State machine (from design.md):
 *   pending   → preparing | cancelled
 *   preparing → sent | cancelled
 *   sent      → delivered
 *   delivered → (terminal)
 *   cancelled → (terminal)
 *
 * trackingNumber gate (order-fulfillment MODIFIED — "Tracking number on shipment"):
 *   trackingNumber is only legal on the PATCH that transitions a SubOrder INTO
 *   `sent` from a non-`sent` status. Given that:
 *     (a) trackingNumber present && NOT entering sent (target !== "sent", OR
 *         current.status is already "sent" — covers the "sent → sent" no-op)
 *         → ValidationFailedError (422)
 *     (b) trackingNumber present && deliveryMode.type === "PICKUP"
 *         → ValidationFailedError (422)
 *     (c) trackingNumber present && current.trackingNumber !== null (immutable)
 *         → ValidationFailedError (422)
 *     (d) trackingNumber absent && entering sent && shipping (non-PICKUP)
 *         → ValidationFailedError (422) — mandatory for shipping
 *
 * Design references:
 *   design §"State machine (SubOrder)"
 *   design Architecture Decision #1: tracking rules enforced in the service, not the DTO
 *   design Architecture Decision #3: idempotent PATCH — early return before update
 *   design Architecture Decision #3 (extended): tracking gate runs before the no-op
 *   spec order-fulfillment §"Producer read of own SubOrders"
 *   spec order-fulfillment §"State machine"
 *   spec order-fulfillment §"Idempotent transitions"
 *   spec order-fulfillment §"Tracking number on shipment" (MODIFIED)
 */
import type { SubOrder, SubOrderStatus } from "@prisma/client";

import { InvalidOrderTransitionError, NotFoundError, ValidationFailedError } from "@/shared/errors/errors";
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
      deliveryMode: { select: { type: true } },
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
    include: { orderLines: true, deliveryMode: { select: { type: true } } },
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
 *   1. findFirst({ where: { id, producerId } }) — 404-no-leak on cross-producer;
 *      includes `deliveryMode.type` for the trackingNumber gate.
 *   2. trackingNumber gate (order-fulfillment MODIFIED) — runs BEFORE the
 *      idempotent no-op early-return. Throws ValidationFailedError (422) on
 *      any rule violation. See module-level doc for the (a)-(d) rule order.
 *   3. Idempotent no-op: if current.status === target, return current WITHOUT
 *      calling update (Decision #3 — updatedAt must not change on retries).
 *   4. Validate transition against ALLOWED_TRANSITIONS table.
 *      If invalid → throw InvalidOrderTransitionError (409).
 *   5. If valid → tx.subOrder.update({ status: target, trackingNumber? }).
 *      trackingNumber is only included in the update payload when entering
 *      `sent` (the gate guarantees it cannot reach here otherwise).
 *
 * Spec: order-fulfillment §"State machine"
 * Spec scenario: "Valid transition succeeds"
 * Spec scenario: "Invalid transition rejected"
 * Spec: order-fulfillment §"Idempotent transitions"
 * Spec scenario: "Idempotent no-op does not touch the row"
 * Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
 * Design Architecture Decision #1 — tracking rules enforced in the service.
 * Design Architecture Decision #3 — idempotent PATCH: early return before update;
 *   extended so the tracking gate runs before that early return too.
 */
export async function transition(
  producerId: string,
  id: string,
  input: PatchSubOrderBody,
): Promise<SubOrder> {
  return prisma.$transaction(async (tx) => {
    // Step 1: ownership guard — 404-no-leak; include deliveryMode.type for the gate.
    const current = await tx.subOrder.findFirst({
      where: { id, producerId },
      include: { deliveryMode: { select: { type: true } } },
    });

    if (!current) {
      throw new NotFoundError("SubOrder not found");
    }

    const target = input.status as SubOrderStatusValue;
    const isEnteringSent = target === "sent" && current.status !== "sent";
    const isPickup = current.deliveryMode.type === "PICKUP";

    // Step 2: trackingNumber gate — MUST run before the no-op early-return.
    // Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
    if (input.trackingNumber !== undefined) {
      // (a) trackingNumber is only accepted on the PATCH that transitions a
      //     SubOrder INTO "sent"; rejects any other target AND a same-status
      //     "sent → sent" no-op (spec scenario "Same-status no-op cannot set
      //     trackingNumber").
      if (!isEnteringSent) {
        throw new ValidationFailedError(
          [{ path: "trackingNumber", message: "trackingNumber is only accepted when transitioning to 'sent'" }],
          "trackingNumber is only accepted when transitioning to 'sent'",
        );
      }
      // (b) PICKUP sub-orders reject any trackingNumber.
      if (isPickup) {
        throw new ValidationFailedError(
          [{ path: "trackingNumber", message: "PICKUP sub-orders cannot have a trackingNumber" }],
          "PICKUP sub-orders cannot have a trackingNumber",
        );
      }
      // (c) Immutability — a non-null trackingNumber cannot be overwritten.
      if (current.trackingNumber !== null) {
        throw new ValidationFailedError(
          [{ path: "trackingNumber", message: "trackingNumber is already set and cannot be overwritten" }],
          "trackingNumber is already set and cannot be overwritten",
        );
      }
    } else if (isEnteringSent && !isPickup) {
      // (d) Shipping (non-PICKUP) sub-orders MUST provide a trackingNumber to enter "sent".
      throw new ValidationFailedError(
        [{ path: "trackingNumber", message: "trackingNumber is required for shipping sub-orders entering 'sent'" }],
        "trackingNumber is required for shipping sub-orders entering 'sent'",
      );
    }

    // Step 3: idempotent no-op — if already in target state, return current row unchanged.
    // Decision #3: no UPDATE is issued; updatedAt is untouched.
    // Spec: "The service MUST NOT issue any UPDATE to the row; updatedAt MUST remain unchanged."
    if (current.status === target) {
      return current;
    }

    // Step 4: validate transition
    const allowedTargets = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!allowedTargets.includes(target)) {
      throw new InvalidOrderTransitionError(
        `Transition from '${current.status}' to '${target}' is not allowed`,
      );
    }

    // Step 5: valid transition — update the row.
    // trackingNumber is only ever defined here when isEnteringSent was true (gate guarantees it).
    return tx.subOrder.update({
      where: { id },
      data: {
        status: target as SubOrderStatus,
        ...(input.trackingNumber !== undefined && { trackingNumber: input.trackingNumber }),
      },
    });
  });
}
