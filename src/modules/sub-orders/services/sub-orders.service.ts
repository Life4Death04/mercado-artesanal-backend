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
 *     (b) trackingNumber present && delivery mode does not require tracking
 *         → ValidationFailedError (422)
 *     (c) trackingNumber present && current.trackingNumber !== null (immutable)
 *         → ValidationFailedError (422)
 *     (d) trackingNumber absent && entering sent && type=SHIPPING_FLAT_RATE
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
 *   spec order-fulfillment §"Producer public reference responses" (order-public-numbers Phase 4)
 */
import { Prisma as PrismaValue } from "@prisma/client";

import { requiresTrackingNumber } from "@/modules/delivery-modes/delivery-mode.policy";
import * as notificationsService from "@/modules/notifications/services/notifications.service";
import type { PendingEmail } from "@/modules/notifications/services/notifications.service";
import {
  InvalidOrderTransitionError,
  NotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type {
  ListSubOrdersQuery,
  PatchSubOrderBody,
  SubOrderListItemView,
  SubOrderStatusValue,
  SubOrderView,
} from "../dto/sub-orders.dto";

type DecimalValue = InstanceType<typeof PrismaValue.Decimal>;

/**
 * `transition()`'s return contract (Cycle 5 notifications design "Emission
 * wiring", Phase 5). `subOrder` is the SAME frozen `SubOrder` row this
 * function always returned; `pendingEmails` is the fire-after-commit
 * dispatch intent for every Notification written during THIS call (empty on
 * the step-3 idempotent no-op path — a same-status PATCH emits nothing, so
 * it has nothing to dispatch). The CALLER (`sub-orders.controller.ts`) is
 * responsible for invoking `dispatchEmails` from `@/shared/email/email-provider`
 * AFTER this transaction commits (fire-after-commit, best-effort).
 */
export interface TransitionSubOrderResult {
  subOrder: SubOrderView;
  pendingEmails: PendingEmail[];
}

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
// Internal row shapes (nested Prisma includes) — mapping helpers only
// order-public-numbers Phase 4 (PR 3): explicit response mapping, replacing
// the previous raw-Prisma-row passthrough. Mirrors the `orders.service.ts`
// `ExistingSubOrderRow`/`mapSubOrderView` convention.
// ---------------------------------------------------------------------------

interface SubOrderScalarRow {
  id: string;
  orderId: string;
  producerId: string;
  deliveryModeId: string;
  status: string;
  shippingCostSnapshot: DecimalValue;
  trackingNumber: string | null;
  shipToLine1: string | null;
  shipToLine2: string | null;
  shipToCity: string | null;
  shipToPostalCode: string | null;
  shipToProvince: string | null;
  shipToCountry: string | null;
  subOrderNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

interface SubOrderLineRow {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: DecimalValue;
}

/**
 * Maps a scalar SubOrder row + its separately-resolved `orderNumber` to the
 * frozen `SubOrderView` wire shape. Deliberately takes `orderNumber` as its
 * own parameter (not a nested `order` relation) so `order.userId` — read
 * separately by `transition()` for the notification recipient — can NEVER
 * flow into this mapper's output (design "Interfaces / Contracts": "exactly
 * order: { orderNumber: number }").
 *
 * Spec: order-fulfillment §"Producer public reference responses" (ADDED)
 */
function mapSubOrderView(row: SubOrderScalarRow, orderNumber: number): SubOrderView {
  return {
    id: row.id,
    orderId: row.orderId,
    producerId: row.producerId,
    deliveryModeId: row.deliveryModeId,
    status: row.status as SubOrderStatusValue,
    shippingCostSnapshot: row.shippingCostSnapshot.toFixed(2),
    trackingNumber: row.trackingNumber,
    shipToLine1: row.shipToLine1,
    shipToLine2: row.shipToLine2,
    shipToCity: row.shipToCity,
    shipToPostalCode: row.shipToPostalCode,
    shipToProvince: row.shipToProvince,
    shipToCountry: row.shipToCountry,
    subOrderNumber: row.subOrderNumber,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    order: { orderNumber },
  };
}

function mapSubOrderLineView(line: SubOrderLineRow): {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: string;
} {
  return {
    id: line.id,
    productId: line.productId,
    quantity: line.quantity,
    unitPriceSnapshot: line.unitPriceSnapshot.toFixed(2),
  };
}

/** `findAll`/`findById` list/detail mapping — adds `deliveryMode.type` and `orderLines`. */
function mapSubOrderListItemView(
  row: SubOrderScalarRow & {
    deliveryMode: { type: string };
    orderLines: SubOrderLineRow[];
    order: { orderNumber: number };
  },
): SubOrderListItemView {
  return {
    ...mapSubOrderView(row, row.order.orderNumber),
    deliveryMode: row.deliveryMode,
    orderLines: row.orderLines.map(mapSubOrderLineView),
  };
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
): Promise<SubOrderListItemView[]> {
  const page = query?.page ?? 1;
  const limit = Math.min(query?.limit ?? 20, 100);
  const skip = (page - 1) * limit;

  const subOrders = await prisma.subOrder.findMany({
    where: {
      producerId,
      ...(query?.status !== undefined && { status: query.status }),
    },
    include: {
      orderLines: true,
      deliveryMode: { select: { type: true } },
      order: { select: { orderNumber: true } },
    },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });

  return subOrders.map(mapSubOrderListItemView);
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
export async function findById(producerId: string, id: string): Promise<SubOrderListItemView> {
  const subOrder = await prisma.subOrder.findFirst({
    where: { id, producerId },
    include: {
      orderLines: true,
      deliveryMode: { select: { type: true } },
      order: { select: { orderNumber: true } },
    },
  });

  if (!subOrder) {
    throw new NotFoundError("SubOrder not found");
  }

  return mapSubOrderListItemView(subOrder);
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
 *
 * Cycle 5 notifications (design "Emission wiring", Phase 5) — emitted AFTER
 * the step-5 update only, never on the step-3 no-op early-return (free-rides
 * that existing guard, zero new idempotency logic, mirrors the payments/orders
 * seam): SUBORDER_STATUS_CHANGED always, plus TRACKING_ASSIGNED when this
 * PATCH also set a trackingNumber (`input.trackingNumber !== undefined`,
 * which the step-2 gate already guarantees only ever happens on the PATCH
 * entering `sent`). Both go to the order's owning Consumer (`order.userId`)
 * with base copy — no audience override, this seam has a single recipient
 * role (maintainer decision sdd/notifications/copy-audience-decision).
 * Returns `{ subOrder, pendingEmails }`; the CALLER dispatches
 * `pendingEmails` via the shared `dispatchEmails` AFTER this transaction
 * commits.
 *
 * Spec: notifications §"Sub-order status change and tracking notify the consumer"
 * Spec: notifications §"Replayed event does not duplicate" (no-op path)
 * Spec: order-fulfillment §"Producer public reference responses" (order-public-numbers
 *   Phase 4) — scenario "Transition returns the same contract": both the
 *   idempotent no-op and the successful-update path return the SAME explicit
 *   `SubOrderView` (`subOrderNumber` + `order.orderNumber`), and `order.userId`
 *   (read below ONLY for the notification recipient) never reaches the response.
 */
export async function transition(
  producerId: string,
  id: string,
  input: PatchSubOrderBody,
): Promise<TransitionSubOrderResult> {
  return prisma.$transaction(async (tx) => {
    // Step 1: ownership guard — 404-no-leak; include deliveryMode.type for the
    // gate, order.userId (Cycle 5 notifications) for the emission recipient,
    // and order.orderNumber (order-public-numbers Phase 4) for the response
    // view — order.userId is read here but MUST NOT reach mapSubOrderView.
    const current = await tx.subOrder.findFirst({
      where: { id, producerId },
      include: {
        deliveryMode: { select: { type: true } },
        order: { select: { userId: true, orderNumber: true } },
      },
    });

    if (!current) {
      throw new NotFoundError("SubOrder not found");
    }

    const target = input.status;
    const isEnteringSent = target === "sent" && current.status !== "sent";
    const trackingRequired = requiresTrackingNumber(current.deliveryMode.type);

    // Step 2: trackingNumber gate — MUST run before the no-op early-return.
    // Spec: order-fulfillment §"Tracking number on shipment" (MODIFIED)
    if (input.trackingNumber !== undefined) {
      // (a) trackingNumber is only accepted on the PATCH that transitions a
      //     SubOrder INTO "sent"; rejects any other target AND a same-status
      //     "sent → sent" no-op (spec scenario "Same-status no-op cannot set
      //     trackingNumber").
      if (!isEnteringSent) {
        throw new ValidationFailedError(
          [
            {
              path: "trackingNumber",
              message: "trackingNumber is only accepted when transitioning to 'sent'",
            },
          ],
          "trackingNumber is only accepted when transitioning to 'sent'",
        );
      }
      // (b) Only carrier shipping sub-orders accept a trackingNumber.
      if (!trackingRequired) {
        throw new ValidationFailedError(
          [
            {
              path: "trackingNumber",
              message: `${current.deliveryMode.type} sub-orders cannot have a trackingNumber`,
            },
          ],
          `${current.deliveryMode.type} sub-orders cannot have a trackingNumber`,
        );
      }
      // (c) Immutability — a non-null trackingNumber cannot be overwritten.
      if (current.trackingNumber !== null) {
        throw new ValidationFailedError(
          [
            {
              path: "trackingNumber",
              message: "trackingNumber is already set and cannot be overwritten",
            },
          ],
          "trackingNumber is already set and cannot be overwritten",
        );
      }
    } else if (isEnteringSent && trackingRequired) {
      // (d) Carrier shipping sub-orders MUST provide a trackingNumber to enter "sent".
      throw new ValidationFailedError(
        [
          {
            path: "trackingNumber",
            message: "trackingNumber is required for shipping sub-orders entering 'sent'",
          },
        ],
        "trackingNumber is required for shipping sub-orders entering 'sent'",
      );
    }

    // Step 3: idempotent no-op — if already in target state, return current row unchanged.
    // Decision #3: no UPDATE is issued; updatedAt is untouched. (Cycle 5 notifications:
    // a no-op emits NO notification — pendingEmails stays empty, free-riding this
    // existing early-return exactly like the payments/orders seam's step-0 replay guard.)
    // Spec: "The service MUST NOT issue any UPDATE to the row; updatedAt MUST remain unchanged."
    if (current.status === target) {
      return {
        subOrder: mapSubOrderView(current, current.order.orderNumber),
        pendingEmails: [],
      };
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
    const updated = await tx.subOrder.update({
      where: { id },
      data: {
        status: target,
        ...(input.trackingNumber !== undefined && { trackingNumber: input.trackingNumber }),
      },
    });

    // Step 5a (Cycle 5 notifications, design "Emission wiring"): emit AFTER
    // the write above — a throw in any EARLIER step never reaches here, so
    // no notification is ever created for a transition that didn't happen.
    // `Order.userId` is intentionally a BARE column with no Prisma relation
    // to `User` (money-webhook exception, prisma pitfall #1 — same
    // deviation documented for the payments/orders seam), so the recipient
    // email cannot be nested-included on the step-1 `order` select; one
    // extra in-tx `user.findUnique` resolves it instead.
    const owner = await tx.user.findUnique({
      where: { id: current.order.userId },
      select: { email: true },
    });
    // `order.userId` is FK-guaranteed, so this is a "cannot happen" guard — but
    // resolve it as a controlled NotFoundError rather than a raw non-null
    // assertion, so a missing row never becomes an uncaught TypeError mid-tx.
    if (!owner) {
      throw new NotFoundError("Order owner not found");
    }
    const pendingEmails: PendingEmail[] = [];
    pendingEmails.push(
      await notificationsService.createNotification(tx, {
        userId: current.order.userId,
        type: "SUBORDER_STATUS_CHANGED",
        toEmail: owner.email,
      }),
    );
    if (input.trackingNumber !== undefined) {
      pendingEmails.push(
        await notificationsService.createNotification(tx, {
          userId: current.order.userId,
          type: "TRACKING_ASSIGNED",
          toEmail: owner.email,
        }),
      );
    }

    return {
      subOrder: mapSubOrderView(updated, current.order.orderNumber),
      pendingEmails,
    };
  });
}
