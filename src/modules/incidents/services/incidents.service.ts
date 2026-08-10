/**
 * Incidents service — consumer creation + owner-scoped read surface
 * (admin-incidents WU2: Consumer APIs).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as incidentsService from "@/modules/incidents/services/incidents.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma delegates
 * directly per ADR-003, mirroring orders.service.ts / notifications.service.ts.
 *
 * `createIncident` runs the ENTIRE eligibility check + write inside ONE
 * `prisma.$transaction` (design "Creation executes one `SubOrder.findFirst`
 * predicate"): the eligibility read is the transaction's first statement,
 * so there is no TOCTOU gap between checking eligibility and creating the
 * Incident + ADMIN notifications — a stricter reading of the design's data
 * flow (`eligibility query -> tx: incident + ADMIN notifications`) than a
 * separate pre-tx read would give, while still issuing exactly ONE
 * `SubOrder.findFirst` call. It returns `{ detail, pendingEmails }`; the
 * CALLER (`incidents.controller.ts`) dispatches `pendingEmails` via the
 * shared `dispatchEmails` AFTER the transaction commits (fire-after-commit,
 * best-effort — mirrors `orders.service.ts` / `sub-orders.service.ts`).
 *
 * `listIncidents`/`getIncidentDetail` are owner-scoped reads: ownership is
 * enforced at the QUERY level (`where: { reporterId }` / `where: { id,
 * reporterId }`), so an unknown OR non-owned id resolves to the SAME
 * `NotFoundError` (404, no-leak) — mirrors `orders.service.ts`
 * `getOrderDetail`.
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 *   notifications §"Transactional incident notifications"
 *   error-handling §"Incident validation errors"
 * Design references:
 *   design §"Data Flow" — eligibility query -> tx: incident + ADMIN notifications
 *   design §"Architecture Decisions" — Snapshot vs broad joins
 */
import type { Prisma } from "@prisma/client";
import { Prisma as PrismaValue } from "@prisma/client";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import type { PendingEmail } from "@/modules/notifications/services/notifications.service";
import { NotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type {
  CreateIncidentBody,
  IncidentDetailRow,
  IncidentDetailView,
  IncidentSummaryRow,
  IncidentSummaryView,
} from "../dto/incidents.dto";
import { mapIncidentDetailView, mapIncidentSummaryView } from "../dto/incidents.dto";

type PrismaTx = Prisma.TransactionClient;
type DecimalValue = InstanceType<typeof PrismaValue.Decimal>;

// ---------------------------------------------------------------------------
// Shared row shapes — the eligibility findFirst / list / detail queries all
// select the SAME nested target shape, so a single internal row interface
// (a superset of what any single caller needs) avoids three near-duplicate
// Prisma select literals drifting out of sync.
// ---------------------------------------------------------------------------

/**
 * Exported (not just module-internal) so `admin-incidents.service.ts` (WU3)
 * can reuse the SAME target/subtotal row-building logic instead of a
 * near-duplicate copy — the eligibility/list/detail queries here and the
 * ADMIN inbox/detail/resolve queries there select the identical nested
 * target shape, and drift between two copies is exactly what design
 * §"Snapshot vs broad joins" ("explicit mapping; prevents drift/leaks")
 * warns against.
 */
export interface IncidentTargetRow {
  subOrderId: string;
  producerId: string;
  producer: { businessName: string };
  status: string;
  shippingCostSnapshot: DecimalValue;
  trackingNumber: string | null;
  deliveryMode: { type: IncidentDetailRow["target"]["deliveryModeType"] };
  orderLines: { productId: string; quantity: number; unitPriceSnapshot: DecimalValue }[];
}

/**
 * Sums `unitPriceSnapshot * quantity` across order lines — the frozen
 * subtotal snapshot. Exported for reuse by `admin-incidents.service.ts`
 * (WU3) — see `IncidentTargetRow` doc above.
 */
export function computeSubtotal(
  lines: { unitPriceSnapshot: DecimalValue; quantity: number }[],
): DecimalValue {
  return lines.reduce(
    (sum, line) => sum.plus(line.unitPriceSnapshot.times(line.quantity)),
    new PrismaValue.Decimal(0),
  );
}

/**
 * Exported for reuse by `admin-incidents.service.ts` (WU3) — see
 * `IncidentTargetRow` doc above.
 */
export function toDetailRow(incident: {
  id: string;
  status: IncidentSummaryRow["status"];
  reportReason: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  resolvedById: string | null;
  subOrder: IncidentTargetRow;
}): IncidentDetailRow {
  return {
    id: incident.id,
    status: incident.status,
    reportReason: incident.reportReason,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    resolvedAt: incident.resolvedAt,
    resolution:
      incident.resolvedAt && incident.resolvedById
        ? {
            reason: incident.resolutionReason ?? "",
            resolvedAt: incident.resolvedAt,
            resolvedById: incident.resolvedById,
          }
        : null,
    target: {
      subOrderId: incident.subOrder.subOrderId,
      producerBusinessName: incident.subOrder.producer.businessName,
      subtotal: computeSubtotal(incident.subOrder.orderLines),
      fulfillmentStatus: incident.subOrder.status as IncidentSummaryRow["target"]["fulfillmentStatus"],
      shippingCost: incident.subOrder.shippingCostSnapshot,
      lines: incident.subOrder.orderLines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPriceSnapshot: line.unitPriceSnapshot,
      })),
      trackingNumber: incident.subOrder.trackingNumber,
      deliveryModeType: incident.subOrder.deliveryMode.type,
    },
  };
}

// ---------------------------------------------------------------------------
// createIncident — POST /api/v1/incidencias
// ---------------------------------------------------------------------------

export interface CreateIncidentResult {
  detail: IncidentDetailView;
  pendingEmails: PendingEmail[];
}

/**
 * Creates an `OPEN` incident for a sub-order the caller owns, paid
 * (`Payment.status = SUCCEEDED`), and not cancelled (`SubOrder.status !=
 * cancelled`) — verified by ONE `SubOrder.findFirst` predicate, as the
 * transaction's first statement. Any predicate failure (unknown id, unowned,
 * unpaid, or cancelled) resolves to the SAME opaque `NotFoundError` (404) —
 * never revealing which predicate failed (spec scenario "Ineligible target
 * is opaque").
 *
 * Transactionally notifies every non-deleted ADMIN with `INCIDENT_REPORTED`
 * and no `data` (spec "Report notifies current administrators") — a losing
 * transaction (e.g. a thrown error before commit) emits neither the Incident
 * row nor any notification (spec "Transaction failure emits nothing").
 *
 * Spec: incident-management §"Eligible single-target creation"
 * Spec: notifications §"Report notifies current administrators"
 * Design: §"Data Flow", §"API Contracts"
 */
export async function createIncident(
  reporterId: string,
  body: CreateIncidentBody,
): Promise<CreateIncidentResult> {
  return prisma.$transaction(async (tx: PrismaTx) => {
    // ONE predicate — id, non-cancelled, owner-scoped, paid. Includes every
    // field the response mapper needs, so no second query is required.
    const subOrder = await tx.subOrder.findFirst({
      where: {
        id: body.subOrderId,
        status: { not: "cancelled" },
        order: { userId: reporterId, payment: { status: "SUCCEEDED" } },
      },
      select: {
        id: true,
        producerId: true,
        status: true,
        shippingCostSnapshot: true,
        trackingNumber: true,
        deliveryMode: { select: { type: true } },
        producer: { select: { businessName: true } },
        orderLines: { select: { productId: true, quantity: true, unitPriceSnapshot: true } },
      },
    });

    if (!subOrder) {
      throw new NotFoundError("Sub-order not found");
    }

    const incident = await tx.incident.create({
      data: {
        reporterId,
        subOrderId: subOrder.id,
        producerId: subOrder.producerId,
        reportReason: body.reason,
      },
    });

    // Non-deleted ADMIN fan-out — informational only, no identifiers in `data`.
    const admins = await tx.user.findMany({
      where: { role: "ADMIN", deletedAt: null },
      select: { id: true, email: true },
    });

    const pendingEmails: PendingEmail[] = [];
    for (const admin of admins) {
      pendingEmails.push(
        await notificationsService.createNotification(tx, {
          userId: admin.id,
          type: "INCIDENT_REPORTED",
          toEmail: admin.email,
        }),
      );
    }

    const detailRow = toDetailRow({
      id: incident.id,
      status: incident.status,
      reportReason: incident.reportReason,
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt,
      resolvedAt: incident.resolvedAt,
      resolutionReason: incident.resolutionReason,
      resolvedById: incident.resolvedById,
      subOrder: {
        subOrderId: subOrder.id,
        producerId: subOrder.producerId,
        producer: subOrder.producer,
        status: subOrder.status,
        shippingCostSnapshot: subOrder.shippingCostSnapshot,
        trackingNumber: subOrder.trackingNumber,
        deliveryMode: subOrder.deliveryMode,
        orderLines: subOrder.orderLines,
      },
    });

    return { detail: mapIncidentDetailView(detailRow), pendingEmails };
  });
}

// ---------------------------------------------------------------------------
// listIncidents — GET /api/v1/incidencias
// ---------------------------------------------------------------------------

/**
 * Owner-scoped incident list, `createdAt DESC, id DESC` (design §"API
 * Contracts"). No pagination (spec "Consumer-list pagination is NOT
 * required").
 *
 * Spec: incident-management §"Owner-scoped consumer views"
 */
export async function listIncidents(reporterId: string): Promise<IncidentSummaryView[]> {
  const rows = await prisma.incident.findMany({
    where: { reporterId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      reportReason: true,
      createdAt: true,
      resolvedAt: true,
      subOrder: {
        select: {
          id: true,
          status: true,
          producer: { select: { businessName: true } },
          orderLines: { select: { unitPriceSnapshot: true, quantity: true } },
        },
      },
    },
  });

  return rows.map((row) =>
    mapIncidentSummaryView({
      id: row.id,
      status: row.status,
      reportReason: row.reportReason,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      target: {
        subOrderId: row.subOrder.id,
        producerBusinessName: row.subOrder.producer.businessName,
        subtotal: computeSubtotal(row.subOrder.orderLines),
        fulfillmentStatus: row.subOrder.status,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// getIncidentDetail — GET /api/v1/incidencias/:id
// ---------------------------------------------------------------------------

/**
 * Owner-scoped incident detail. Ownership is enforced at the QUERY level
 * (`where: { id, reporterId }`), so an unknown OR non-owned id resolves to
 * the SAME `NotFoundError` (404) — no-leak, never `403` (spec scenario
 * "Consumer cannot probe another incident").
 *
 * Spec: incident-management §"Owner-scoped consumer views"
 */
export async function getIncidentDetail(
  reporterId: string,
  incidentId: string,
): Promise<IncidentDetailView> {
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, reporterId },
    select: {
      id: true,
      status: true,
      reportReason: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      resolutionReason: true,
      resolvedById: true,
      subOrder: {
        select: {
          id: true,
          producerId: true,
          status: true,
          shippingCostSnapshot: true,
          trackingNumber: true,
          deliveryMode: { select: { type: true } },
          producer: { select: { businessName: true } },
          orderLines: { select: { productId: true, quantity: true, unitPriceSnapshot: true } },
        },
      },
    },
  });

  if (!incident) {
    throw new NotFoundError("Incident not found");
  }

  const detailRow = toDetailRow({
    id: incident.id,
    status: incident.status,
    reportReason: incident.reportReason,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    resolvedAt: incident.resolvedAt,
    resolutionReason: incident.resolutionReason,
    resolvedById: incident.resolvedById,
    subOrder: {
      subOrderId: incident.subOrder.id,
      producerId: incident.subOrder.producerId,
      producer: incident.subOrder.producer,
      status: incident.subOrder.status,
      shippingCostSnapshot: incident.subOrder.shippingCostSnapshot,
      trackingNumber: incident.subOrder.trackingNumber,
      deliveryMode: incident.subOrder.deliveryMode,
      orderLines: incident.subOrder.orderLines,
    },
  });

  return mapIncidentDetailView(detailRow);
}
