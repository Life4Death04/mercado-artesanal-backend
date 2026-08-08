/**
 * Orders service — atomic checkout write contract + Order.status derivation.
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as ordersService from "@/modules/orders/services/orders.service"`.
 *
 * WU2 (Checkout Write Contract) implements: `deriveOrderStatus`, `createOrderFromPayment`.
 * WU3 (Read Surface) implements: `listOrders`, `getOrderDetail`. `listOrders`
 * delegates response formatting to the PURE `mapOrderSummaryView` in
 * `orders.dto.ts`; `getOrderDetail` reuses the existing `mapExistingOrderDetailView`.
 * WU4 (Cancellation) will add `cancelOrder` in this same file.
 *
 * Architecture: no repositories/ layer — service calls prisma delegates directly
 * per ADR-003. `orders` creates `SubOrder` rows via `tx.subOrder.create()` directly
 * (never importing the frozen sub-orders service, per spec Guardrails).
 *
 * Key invariants (design Decision 2 + Decision 4, spec §ADDED requirements):
 *   - `deriveOrderStatus` is the SOLE authority for `Order.status` on every read.
 *     The persisted `Order.status` column is NEVER read for business logic and
 *     NEVER written by this slice (see schema.prisma doc comment on Order.status).
 *   - `deriveOrderStatus([])` THROWS — every Order is invariant-guaranteed to
 *     have >= 1 SubOrder at creation; an empty array indicates a data-integrity
 *     bug, not a legitimate state.
 *   - `createOrderFromPayment` runs ENTIRELY on the caller's `tx` — it never
 *     opens its own `$transaction` and never catches a bubbled P2002 internally
 *     (recovery is a CALLER contract — see design Decision 4, "Recovery is a
 *     CALLER contract, not an in-tx catch").
 *   - Idempotency pre-check via `Payment.providerRef` (unique, WU1) runs FIRST,
 *     before any write, and is itself the idempotent no-op path.
 *   - Availability is re-validated LIVE inside `tx` (snapshot fast-fail is a
 *     cheap short-circuit only) — completeness is checked BEFORE availability,
 *     since a missing row would otherwise pass a rows-only check vacuously.
 *   - Delivery mode resolution is ONE batched query (never per-item loop);
 *     validation sources exclusively from the resolved rows, never the bare
 *     input, and builds `shippingByProducer`/`deliveryModeByProducer` maps
 *     reused by later steps instead of re-querying or referencing rows that
 *     don't exist yet.
 *   - Totals are computed EXCLUSIVELY with `Prisma.Decimal` from the cart
 *     snapshot (`cartView.items`), BEFORE any create call.
 *   - `OrderLine.unitPriceSnapshot` is copied AS-IS from `cartView.items`
 *     (the frozen cart snapshot), never re-read from a live row.
 *   - Cart clearing is snapshot-scoped (`checkoutedCartItemIds`), NOT
 *     userId-scoped — items added mid-window must survive.
 *
 * Spec references:
 *   orders §"createOrderFromPayment writes the order aggregate atomically"
 *   orders §"Checkout enforces all-or-nothing availability"
 *   orders §"Order snapshots are immutable at creation"
 *   orders §"Order.status is derived, never set directly"
 *   orders §"Duplicate webhook must not double-create an order"
 *   design Decision 2 (status derivation writer), Decision 4 (internals, atomic step order)
 */
import type { Prisma } from "@prisma/client";
import { Prisma as PrismaValue } from "@prisma/client";

import type { CartForCheckout, CartItemForCheckout } from "@/modules/cart/services/cart.service";
import { requiresDestinationAddress } from "@/modules/delivery-modes/delivery-mode.policy";
import { decrementStock, restockProduct } from "@/modules/inventory/services/inventory.service";
import {
  CartItemNotAvailableError,
  EmptyCartCheckoutError,
  InvalidOrderTransitionError,
  NotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type { OrderSummaryView } from "../dto/orders.dto";
import { mapOrderSummaryView } from "../dto/orders.dto";

// ---------------------------------------------------------------------------
// Internal type alias (consistent with inventory.service.ts pattern)
// ---------------------------------------------------------------------------

type PrismaTx = Prisma.TransactionClient;
type DecimalValue = InstanceType<typeof PrismaValue.Decimal>;

// ---------------------------------------------------------------------------
// Response types — frozen by spec §Response Shapes
// ---------------------------------------------------------------------------

export type OrderStatusValue = "PENDING" | "PARTIAL" | "FULFILLED" | "CANCELLED";
export type SubOrderStatusValue = "pending" | "preparing" | "sent" | "delivered" | "cancelled";
export type PaymentStatusValue = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUNDED";
export type DeliveryModeTypeValue = "PERSONAL_DELIVERY" | "PICKUP" | "SHIPPING_FLAT_RATE";

export interface DeliverySelection {
  producerId: string;
  deliveryModeId: string;
}

export interface OrderLineView {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: string;
}

export interface SubOrderView {
  id: string;
  producerId: string;
  status: SubOrderStatusValue;
  shippingCostSnapshot: string;
  deliveryModeId: string;
  trackingNumber: string | null;
  deliveryMode: { type: DeliveryModeTypeValue };
  orderLines: OrderLineView[];
}

export interface OrderDetailView {
  id: string;
  createdAt: string;
  totalAmount: string;
  status: OrderStatusValue;
  payment: { status: PaymentStatusValue };
  subOrders: SubOrderView[];
}

// ---------------------------------------------------------------------------
// deriveOrderStatus — design Decision 2 (compute-on-read, sole authority)
// ---------------------------------------------------------------------------

/**
 * Derives `Order.status` from its `SubOrder[].status` array. This is the SOLE
 * authority for `Order.status` — no endpoint or service outside this function
 * MUST write it, and the persisted column is never read for business logic.
 *
 * Branches (spec §"Order.status is derived, never set directly"):
 *   - all `pending`   -> PENDING
 *   - all `delivered` -> FULFILLED
 *   - all `cancelled` -> CANCELLED
 *   - else (mixed, incl. all-preparing/all-sent in-progress states,
 *     which the frozen 4-value OrderStatus enum has no dedicated value
 *     for) -> PARTIAL
 *
 * `deriveOrderStatus([])` THROWS rather than silently defaulting — every
 * Order is invariant-guaranteed to have >= 1 SubOrder at creation (the D4
 * group-by-producer step always runs before any read path can observe the
 * order), so an empty array indicates a data-integrity bug.
 *
 * Spec: orders §"Order.status is derived, never set directly"
 * Design: Decision 2
 */
export function deriveOrderStatus(statuses: SubOrderStatusValue[]): OrderStatusValue {
  if (statuses.length === 0) {
    throw new Error(
      "deriveOrderStatus: cannot derive status from an empty SubOrder array — every Order must have at least one SubOrder",
    );
  }

  if (statuses.every((s) => s === "pending")) {
    return "PENDING";
  }
  if (statuses.every((s) => s === "delivered")) {
    return "FULFILLED";
  }
  if (statuses.every((s) => s === "cancelled")) {
    return "CANCELLED";
  }
  return "PARTIAL";
}

// ---------------------------------------------------------------------------
// Internal row shapes (nested Prisma includes) — mapping helpers only
// ---------------------------------------------------------------------------

interface ExistingOrderLineRow {
  id: string;
  productId: string;
  quantity: number;
  unitPriceSnapshot: DecimalValue;
}

interface ExistingSubOrderRow {
  id: string;
  producerId: string;
  status: string;
  shippingCostSnapshot: DecimalValue;
  deliveryModeId: string;
  trackingNumber: string | null;
  deliveryMode: { type: DeliveryModeTypeValue };
  orderLines: ExistingOrderLineRow[];
}

interface ExistingOrderRow {
  id: string;
  createdAt: Date;
  totalAmount: DecimalValue;
  subOrders: ExistingSubOrderRow[];
}

function mapOrderLineView(line: ExistingOrderLineRow): OrderLineView {
  return {
    id: line.id,
    productId: line.productId,
    quantity: line.quantity,
    unitPriceSnapshot: line.unitPriceSnapshot.toFixed(2),
  };
}

function mapSubOrderView(subOrder: ExistingSubOrderRow): SubOrderView {
  return {
    id: subOrder.id,
    producerId: subOrder.producerId,
    status: subOrder.status as SubOrderStatusValue,
    shippingCostSnapshot: subOrder.shippingCostSnapshot.toFixed(2),
    deliveryModeId: subOrder.deliveryModeId,
    trackingNumber: subOrder.trackingNumber,
    deliveryMode: subOrder.deliveryMode,
    orderLines: subOrder.orderLines.map(mapOrderLineView),
  };
}

/** Maps an existing (already-committed) Order row to the frozen OrderDetailView shape. */
function mapExistingOrderDetailView(
  order: ExistingOrderRow,
  paymentStatus: string,
): OrderDetailView {
  const subOrders = order.subOrders.map(mapSubOrderView);
  return {
    id: order.id,
    createdAt: order.createdAt.toISOString(),
    totalAmount: order.totalAmount.toFixed(2),
    status: deriveOrderStatus(subOrders.map((s) => s.status)),
    payment: { status: paymentStatus as PaymentStatusValue },
    subOrders,
  };
}

// ---------------------------------------------------------------------------
// createOrderFromPayment — design Decision 4 (atomic step order)
// ---------------------------------------------------------------------------

/**
 * Writes the order aggregate atomically on the caller's `tx` (no self-managed
 * transaction — see "Recovery is a CALLER contract" below).
 *
 * Step order (design Decision 4, MUST NOT be reordered):
 *   0. Idempotency pre-check on `Payment.providerRef` — if found, RETURN the
 *      existing `OrderDetailView` (idempotent no-op), no writes.
 *   1. Reject an empty cart -> `EmptyCartCheckoutError` (422).
 *   2. Live availability re-check: snapshot fast-fail, then a SINGLE batched
 *      `cartItem.findMany`, asserting COMPLETENESS before availability
 *      (a missing row would otherwise pass a rows-only check vacuously) ->
 *      `CartItemNotAvailableError` (409) on any failure, all-or-nothing.
 *   3. Resolve `deliverySelections` via ONE batched `deliveryMode.findMany`.
 *   3a. Validate EXCLUSIVELY from the resolved rows (bijection, resolution,
 *       FK match, isActive) -> `ValidationFailedError` (422); build and
 *       retain `shippingByProducer`/`deliveryModeByProducer` maps.
 *   4. Compute totals with `Prisma.Decimal`, from the cart snapshot + the
 *       step-3a maps, BEFORE any create call.
 *   5. `payment.create` then `order.create`, both persisting the step-4 total.
 *   5b. (checkout-contracts BE-3, design Fork 4 — ADDITIVE, does not reorder
 *       0-9 above) ONE `pendingCheckout.findUnique({ providerRef })` read —
 *       the immutable address snapshot `payments.service.ts` wrote at
 *       intent-creation time. `null` when no matching row exists (all-pickup
 *       checkout, or a webhook-only caller with no prior intent).
 *   6. Group items by producer -> one `subOrder.create` each, copying the
 *       step-5b snapshot into `shipTo*` for `SHIPPING_FLAT_RATE` producers
 *       only (PICKUP stays null), retaining each created id in
 *       `subOrderIdByProducer`.
 *   7. One `orderLine.create` per item, `unitPriceSnapshot` copied AS-IS from
 *       the cart snapshot, `subOrderId` resolved via `subOrderIdByProducer`.
 *   8. `decrementStock(productId, quantity, tx)` per line (frozen contract).
 *   9. Snapshot-scoped `cartItem.deleteMany` (NOT userId-scoped).
 *
 * Any throw rolls back the caller's `tx`. A P2002 from step 5's
 * `payment.create` (webhook idempotency backstop, `Payment.providerRef @unique`)
 * is INTENTIONALLY left uncaught — Postgres aborts the whole transaction on a
 * unique-constraint violation, so no further statement can run on this SAME
 * `tx`; recovery is the CALLER's responsibility (open a FRESH `$transaction`
 * and re-invoke this function, whose step-0 pre-check will then find the
 * now-committed row).
 *
 * Spec: orders §"createOrderFromPayment writes the order aggregate atomically"
 * Design: Decision 4
 */
export async function createOrderFromPayment(
  stripeIntentId: string,
  cartView: CartForCheckout,
  deliverySelections: DeliverySelection[],
  tx: PrismaTx,
): Promise<OrderDetailView> {
  // Step 0: idempotency pre-check — FIRST, before any write.
  const existingPayment = await tx.payment.findUnique({
    where: { providerRef: stripeIntentId },
    include: {
      order: {
        include: {
          subOrders: {
            include: { orderLines: true, deliveryMode: { select: { type: true } } },
          },
        },
      },
    },
  });

  if (existingPayment?.order) {
    return mapExistingOrderDetailView(existingPayment.order, existingPayment.status);
  }

  // Step 1: empty cart rejection.
  if (cartView.items.length === 0) {
    throw new EmptyCartCheckoutError("Cannot checkout an empty cart");
  }

  // Derived once, reused by the live re-check (step 2) and the cart clear (step 9).
  const checkoutedCartItemIds = cartView.items.map((item) => item.cartItemId);

  // Step 2a: snapshot fast-fail — cheap short-circuit before paying for a query.
  if (cartView.items.some((item) => !item.isAvailable)) {
    throw new CartItemNotAvailableError("One or more cart items are no longer available");
  }

  // Step 2b: live re-check — ONE batched query, never a per-item loop.
  const liveItems = await tx.cartItem.findMany({
    where: { id: { in: checkoutedCartItemIds } },
    include: { product: { include: { producer: true } } },
    relationLoadStrategy: "join",
  });

  // Step 2c: completeness FIRST — a rows-only check would pass vacuously if a
  // snapshotted item was removed before webhook delivery.
  if (liveItems.length !== checkoutedCartItemIds.length) {
    throw new CartItemNotAvailableError("One or more cart items are no longer available");
  }
  const liveItemsById = new Map(liveItems.map((item) => [item.id, item]));
  for (const id of checkoutedCartItemIds) {
    if (!liveItemsById.has(id)) {
      throw new CartItemNotAvailableError("One or more cart items are no longer available");
    }
  }

  // Step 2d: live availability, all-or-nothing.
  for (const item of liveItems) {
    const { product } = item;
    const isAvailable =
      product.deletedAt === null && product.isActive && product.producer.deletedAt === null;
    if (!isAvailable) {
      throw new CartItemNotAvailableError("One or more cart items are no longer available");
    }
  }

  // Step 3: resolve delivery mode selections — ONE batched query.
  const selectedModes = await tx.deliveryMode.findMany({
    where: { id: { in: deliverySelections.map((s) => s.deliveryModeId) } },
  });
  const modesById = new Map(selectedModes.map((mode) => [mode.id, mode]));

  // Step 3a: validate EXCLUSIVELY from the resolved rows; build the maps reused below.
  const cartProducerIds = new Set(cartView.items.map((item) => item.producerId));
  const shippingByProducer = new Map<string, DecimalValue>();
  const deliveryModeByProducer = new Map<string, string>();

  for (const selection of deliverySelections) {
    if (!cartProducerIds.has(selection.producerId)) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: `Unknown producerId: ${selection.producerId}` }],
        "Invalid delivery selections",
      );
    }
    if (deliveryModeByProducer.has(selection.producerId)) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: `Duplicate producerId: ${selection.producerId}` }],
        "Invalid delivery selections",
      );
    }

    const mode = modesById.get(selection.deliveryModeId);
    if (!mode) {
      throw new ValidationFailedError(
        [
          {
            path: "deliverySelections",
            message: `Unknown deliveryModeId: ${selection.deliveryModeId}`,
          },
        ],
        "Invalid delivery selections",
      );
    }
    if (mode.producerId !== selection.producerId) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: "deliveryModeId does not belong to producerId" }],
        "Invalid delivery selections",
      );
    }
    if (!mode.isActive) {
      throw new ValidationFailedError(
        [{ path: "deliverySelections", message: "deliveryMode is not active" }],
        "Invalid delivery selections",
      );
    }

    shippingByProducer.set(selection.producerId, mode.cost);
    deliveryModeByProducer.set(selection.producerId, mode.id);
  }

  // Bijection completeness — every cart producerId MUST have exactly one selection.
  if (deliveryModeByProducer.size !== cartProducerIds.size) {
    throw new ValidationFailedError(
      [
        {
          path: "deliverySelections",
          message: "Missing a deliverySelection for one or more cart producers",
        },
      ],
      "Invalid delivery selections",
    );
  }

  // Step 4: compute totals with Prisma.Decimal, BEFORE any create call.
  let total = new PrismaValue.Decimal(0);
  for (const item of cartView.items) {
    const lineTotal = new PrismaValue.Decimal(item.unitPriceSnapshot).times(item.quantity);
    total = total.plus(lineTotal);
  }
  for (const producerId of cartProducerIds) {
    total = total.plus(shippingByProducer.get(producerId)!);
  }

  // Step 5: Payment then Order, both persisting the SAME computed total.
  const payment = await tx.payment.create({
    data: {
      providerRef: stripeIntentId,
      status: "SUCCEEDED",
      amount: total,
    },
  });
  const order = await tx.order.create({
    data: {
      userId: cartView.userId,
      paymentId: payment.id,
      totalAmount: total,
    },
  });

  // Step 5b (checkout-contracts BE-3, design Fork 4): resolve the immutable
  // address snapshot ONCE — looked up by `providerRef` (set by
  // `payments.service.ts` right after Stripe returns the PaymentIntent id,
  // BEFORE this transaction ever runs). `null` when no matching row exists
  // (an all-pickup checkout never needed one, or this is a webhook-only
  // test double with no prior intent-creation call) — Step 6 below then
  // writes no `shipTo*` content for any producer, matching PICKUP behavior.
  // The mutable `Address` row is NEVER read here (assumption #4) — only
  // this durable, pre-webhook snapshot.
  const pendingCheckout = await tx.pendingCheckout.findUnique({
    where: { providerRef: stripeIntentId },
  });

  // Step 6: group items by producer -> one SubOrder each; retain created ids.
  const itemsByProducer = new Map<string, CartItemForCheckout[]>();
  for (const item of cartView.items) {
    const list = itemsByProducer.get(item.producerId) ?? [];
    list.push(item);
    itemsByProducer.set(item.producerId, list);
  }

  const subOrderIdByProducer = new Map<string, string>();
  const subOrderStatusByProducer = new Map<string, SubOrderStatusValue>();
  for (const producerId of itemsByProducer.keys()) {
    const deliveryModeId = deliveryModeByProducer.get(producerId)!;
    // Snapshot flows to delivery modes that require a destination address.
    // PICKUP SubOrders leave every
    // `shipTo*` column null, matching the schema default.
    const modeType = modesById.get(deliveryModeId)!.type;
    const needsDestinationAddress = requiresDestinationAddress(modeType);
    const subOrder = await tx.subOrder.create({
      data: {
        orderId: order.id,
        producerId,
        deliveryModeId,
        shippingCostSnapshot: shippingByProducer.get(producerId)!,
        ...(needsDestinationAddress && pendingCheckout
          ? {
              shipToLine1: pendingCheckout.addressLine1,
              shipToLine2: pendingCheckout.addressLine2,
              shipToCity: pendingCheckout.addressCity,
              shipToPostalCode: pendingCheckout.addressPostalCode,
              shipToProvince: pendingCheckout.addressProvince,
              shipToCountry: pendingCheckout.addressCountry,
            }
          : {}),
      },
    });
    subOrderIdByProducer.set(producerId, subOrder.id);
    subOrderStatusByProducer.set(producerId, subOrder.status);
  }

  // Step 7: one OrderLine per item, snapshot copied AS-IS, subOrderId resolved via the step-6 map.
  const orderLinesByProducer = new Map<string, OrderLineView[]>();
  for (const item of cartView.items) {
    const line = await tx.orderLine.create({
      data: {
        subOrderId: subOrderIdByProducer.get(item.producerId)!,
        productId: item.productId,
        quantity: item.quantity,
        unitPriceSnapshot: new PrismaValue.Decimal(item.unitPriceSnapshot),
      },
    });
    const list = orderLinesByProducer.get(item.producerId) ?? [];
    list.push(mapOrderLineView(line));
    orderLinesByProducer.set(item.producerId, list);
  }

  // Step 8: decrementStock per line (frozen contract).
  for (const item of cartView.items) {
    await decrementStock(item.productId, item.quantity, tx);
  }

  // Step 9: snapshot-scoped cart clear — NOT userId-scoped.
  await tx.cartItem.deleteMany({ where: { id: { in: checkoutedCartItemIds } } });

  const subOrders: SubOrderView[] = [...itemsByProducer.keys()].map((producerId) => {
    const deliveryModeId = deliveryModeByProducer.get(producerId)!;
    return {
      id: subOrderIdByProducer.get(producerId)!,
      producerId,
      status: subOrderStatusByProducer.get(producerId)!,
      shippingCostSnapshot: shippingByProducer.get(producerId)!.toFixed(2),
      deliveryModeId,
      // A freshly created SubOrder never has a trackingNumber yet — it is
      // only ever set later by a producer transition() into "sent" (see
      // sub-orders.service.ts trackingNumber gate).
      trackingNumber: null,
      deliveryMode: { type: modesById.get(deliveryModeId)!.type },
      orderLines: orderLinesByProducer.get(producerId) ?? [],
    };
  });

  return {
    id: order.id,
    createdAt: order.createdAt.toISOString(),
    totalAmount: total.toFixed(2),
    status: deriveOrderStatus(subOrders.map((s) => s.status)),
    payment: { status: payment.status },
    subOrders,
  };
}

// ---------------------------------------------------------------------------
// listOrders / getOrderDetail — WU3 (Read Surface)
// ---------------------------------------------------------------------------

/**
 * GET /pedidos — owner-scoped summary history for `req.user.id`.
 *
 * Issues ONE `prisma.order.findMany` scoped to `userId`, newest first,
 * selecting only the nested `SubOrder.status` needed to derive `Order.status`
 * (design Decision 2, the SOLE authority — never the persisted column) and
 * to compute `producerCount` (= `subOrders.length`; each `SubOrder` is
 * created for exactly one distinct producer at checkout time, design
 * Decision 4 step 6). Mapping to the wire shape is delegated to the PURE
 * `mapOrderSummaryView` (orders.dto.ts) — this function only derives status
 * and count, then hands off formatting.
 *
 * Spec: orders §"GET /pedidos returns owner-scoped summary history"
 * Design: Decision 2, Data Flow ("GET /pedidos[/:id] -> ordersService ->
 *   deriveOrderStatus(subStatuses) -> View")
 */
export async function listOrders(userId: string): Promise<OrderSummaryView[]> {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      totalAmount: true,
      subOrders: { select: { status: true } },
    },
  });

  return orders.map((order) => {
    const statuses = order.subOrders.map((s) => s.status);
    return mapOrderSummaryView({
      id: order.id,
      createdAt: order.createdAt,
      totalAmount: order.totalAmount,
      status: deriveOrderStatus(statuses),
      producerCount: order.subOrders.length,
    });
  });
}

/**
 * GET /pedidos/:id — nested detail for the caller's own order only.
 *
 * Ownership is enforced at the QUERY level (`where: { id, userId }`), so an
 * unknown OR non-owned id resolves to the SAME `null` result and the SAME
 * `NotFoundError` (404) — no-leak, never `403` (spec §"GET /pedidos/:id
 * returns nested detail with no-leak 404").
 *
 * Reuses `mapExistingOrderDetailView` (the same mapper the WU2 idempotency
 * pre-check path already uses) so the detail shape is identical whichever
 * code path produced it.
 *
 * Spec: orders §"GET /pedidos/:id returns nested detail with no-leak 404"
 * Design: Decision 6 (owner = req.user.id, no-leak 404)
 */
export async function getOrderDetail(userId: string, orderId: string): Promise<OrderDetailView> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      payment: { select: { status: true } },
      subOrders: {
        include: { orderLines: true, deliveryMode: { select: { type: true } } },
      },
    },
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return mapExistingOrderDetailView(order, order.payment.status);
}

// ---------------------------------------------------------------------------
// cancelOrder — WU4 (Cancellation), design Decision 3 (TOCTOU guard)
// ---------------------------------------------------------------------------

/**
 * PATCH /pedidos/:id/cancelar — cancels a consumer order ONLY when it is
 * still `PENDING`, restoring stock per `OrderLine` inside the same
 * transaction as the cancellation write.
 *
 * Step order (design Decision 3, MUST NOT be reordered):
 *   1. In-tx read, ownership-scoped: `tx.order.findFirst({ where: { id, userId } })` ->
 *      no-leak `NotFoundError` (404) if null (same as `getOrderDetail`).
 *   2. Cheap pre-check: derive status from the just-read `SubOrder[].status`
 *      via the SOLE `deriveOrderStatus` authority -> `InvalidOrderTransitionError`
 *      (409) if not `PENDING`. This is a fast-fail optimization ONLY — it
 *      does NOT provide the actual concurrency guarantee (see step 4).
 *   3. Restock every `OrderLine` via `restockProduct(productId, quantity, tx)`
 *      (frozen sibling of `decrementStock`) — runs BEFORE step 4 so a later
 *      guard failure rolls back the restock too (same tx, any throw reverts
 *      all writes).
 *   4. CONDITIONAL claim + count guard — the ACTUAL atomic guard:
 *      `tx.subOrder.updateMany({ where: { orderId, status: "pending" }, data: { status: "cancelled" } })`.
 *      Assert `count === subOrders.length` (captured in step 1) — a mismatch
 *      means a concurrent producer `transition()` flipped a row away from
 *      `pending` between step 1's read and this write (the classic TOCTOU
 *      race: a plain SELECT under Postgres READ COMMITTED takes no row
 *      lock). On mismatch, throw `InvalidOrderTransitionError` (409) and let
 *      the transaction roll back (reverting the step-3 restock too).
 *
 * ACCEPTED, DOCUMENTED RESIDUAL RACE (design Decision 3, "Known constraint"):
 * this guard makes cancel's OWN update correct against a concurrent producer
 * `transition()`, but the FROZEN `sub-orders.transition()` performs an
 * UNCONDITIONAL `update({ where: { id } })` with no status predicate. If a
 * consumer's cancel commits FIRST and a producer's `transition()` call was
 * already mid-flight against the pre-cancel status, that `transition()` will
 * still unconditionally overwrite the row after cancel committed — an
 * orphaned restock (stock was returned, but the SubOrder is active again).
 * This is NOT fixable from within `orders` without modifying the frozen
 * `sub-orders` module, which is explicitly out of scope here (maintainer
 * decision) — see design Decision 3 for the full analysis. This function
 * makes NO attempt to eliminate that reverse-direction race.
 *
 * `Order.status` is NEVER written here (or anywhere in this slice, design
 * Decision 2) — the response below reflects the now-`cancelled` SubOrders
 * purely via `deriveOrderStatus`, reusing `mapExistingOrderDetailView`.
 *
 * Spec: orders §"PATCH /pedidos/:id/cancelar cancels only at PENDING and restores stock"
 * Design: Decision 3
 */
export async function cancelOrder(userId: string, orderId: string): Promise<OrderDetailView> {
  return prisma.$transaction(async (tx) => {
    // Step 1: in-tx read, ownership-scoped (no-leak — same predicate as getOrderDetail).
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      include: {
        payment: { select: { status: true } },
        subOrders: {
          include: { orderLines: true, deliveryMode: { select: { type: true } } },
        },
      },
    });

    if (!order) {
      throw new NotFoundError("Order not found");
    }

    // Step 2: cheap pre-check via the SOLE deriveOrderStatus authority — a
    // fast-fail short-circuit only, NOT the concurrency guard (see step 4).
    const statuses = order.subOrders.map((s) => s.status);
    if (deriveOrderStatus(statuses) !== "PENDING") {
      throw new InvalidOrderTransitionError("Order is not in a cancellable state");
    }

    // Step 3: restock every line, BEFORE the guarded claim — if step 4 fails,
    // the surrounding transaction rolls back this restock too (any throw
    // reverts the whole tx).
    for (const subOrder of order.subOrders) {
      for (const line of subOrder.orderLines) {
        await restockProduct(line.productId, line.quantity, tx);
      }
    }

    // Step 4: the ACTUAL atomic guard — conditional claim + count assertion.
    // Only rows still "pending" at write time are claimed; a concurrent
    // producer transition() already moved a row away from "pending" is
    // excluded from this UPDATE, producing a count mismatch below.
    const { count } = await tx.subOrder.updateMany({
      where: { orderId, status: "pending" },
      data: { status: "cancelled" },
    });

    if (count !== order.subOrders.length) {
      throw new InvalidOrderTransitionError("Order is not in a cancellable state");
    }

    // Order.status is NEVER written (design Decision 2) — map the response
    // via deriveOrderStatus over the now-cancelled SubOrders in memory.
    const cancelledOrder: ExistingOrderRow = {
      ...order,
      subOrders: order.subOrders.map((s) => ({ ...s, status: "cancelled" })),
    };

    return mapExistingOrderDetailView(cancelledOrder, order.payment.status);
  });
}
