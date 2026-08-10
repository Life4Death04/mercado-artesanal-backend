/**
 * Admin Incidents service — ADMIN all-status inbox, safe detail, and final
 * conditional resolution (admin-incidents WU3: ADMIN Triage and Resolution).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export).
 * Tests import via:
 *   `import * as adminIncidentsService from "@/modules/incidents/services/admin-incidents.service"`.
 *
 * Architecture: no repositories/ layer — service calls prisma delegates
 * directly per ADR-003, mirroring incidents.service.ts / notifications.service.ts.
 *
 * Reuses `computeSubtotal`/`toDetailRow`/`IncidentTargetRow` from
 * `incidents.service.ts` (WU2) — the SAME target-row shape and
 * snapshot-subtotal math apply to both the consumer and ADMIN surfaces;
 * duplicating them here would be exactly the "drift/leaks" risk design
 * §"Architecture Decisions" warns against.
 *
 * `listAllIncidents` — ALL statuses, NO backend filtering (spec "ADMIN
 * inbox pagination"), `createdAt DESC, id DESC`, `{items,page,limit,total,
 * totalPages}`.
 *
 * `getIncidentDetail` — unscoped by reporter (ADMIN may read ANY incident);
 * unknown id -> `NotFoundError` (404). Adds the allowlisted
 * `reporter:{name,email}`.
 *
 * `resolveIncident` — runs inside ONE `prisma.$transaction`:
 *   1. existence check (`findUnique`) -> `NotFoundError` (404) if missing.
 *   2. conditional `updateMany` constrained to `status: "OPEN"` AND both
 *      audit fields `null` — the ONLY way an already-resolved OR
 *      concurrently-raced incident can be told apart from a fresh `OPEN`
 *      one without a read/update TOCTOU gap (design §"Architecture
 *      Decisions" — "Conditional write vs read/update").
 *   3. `count === 0` -> `IncidentAlreadyResolvedError` (409) — the
 *      transaction rolls back with NOTHING written (steps 1-2 performed no
 *      other writes), so the first resolver's audit is provably untouched.
 *   4. `count === 1` (the winner) -> re-read the now-`RESOLVED` row, notify
 *      the STORED reporter with `INCIDENT_RESOLVED` and no `data`, return
 *      `{ detail, pendingEmails }`. The CALLER
 *      (`admin-incidents.controller.ts`) dispatches `pendingEmails` via the
 *      shared `dispatchEmails` AFTER this transaction commits
 *      (fire-after-commit, best-effort — mirrors
 *      `incidents.service.ts` `createIncident`).
 *
 * Spec references:
 *   incident-management §"ADMIN inbox pagination"
 *   incident-management §"Safe ADMIN detail"
 *   incident-management §"Final conditional resolution"
 *   incident-management §"Scope exclusions" — no commercial/fulfillment side effects
 *   notifications §"Transactional incident notifications"
 *   error-handling §"Safe incident resolution conflict"
 * Design references:
 *   design §"Transactions, Errors, and Testing"
 *   design §"Architecture Decisions" — Conditional write vs read/update
 */
import type { DeliveryModeType, IncidentStatus, Prisma } from "@prisma/client";

import * as notificationsService from "@/modules/notifications/services/notifications.service";
import type { PendingEmail } from "@/modules/notifications/services/notifications.service";
import { IncidentAlreadyResolvedError, NotFoundError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

import type {
  AdminIncidentDetailRow,
  AdminIncidentDetailView,
  AdminIncidentSummaryRow,
  AdminIncidentSummaryView,
  AdminIncidentsQuery,
  PaginatedIncidents,
} from "../dto/admin-incidents.dto";
import {
  mapAdminIncidentDetailView,
  mapAdminIncidentSummaryView,
  resolveReporterName,
} from "../dto/admin-incidents.dto";

import { computeSubtotal, toDetailRow } from "./incidents.service";

type PrismaTx = Prisma.TransactionClient;
type DecimalValue = InstanceType<typeof Prisma.Decimal>;

/** Shared reporter select fragment — used by both detail and resolve. */
const reporterSelect = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
} as const;

/** Shared subOrder/target select fragment — matches `IncidentTargetRow`. */
const subOrderSelect = {
  id: true,
  producerId: true,
  status: true,
  shippingCostSnapshot: true,
  trackingNumber: true,
  deliveryMode: { select: { type: true } },
  producer: { select: { businessName: true } },
  orderLines: { select: { productId: true, quantity: true, unitPriceSnapshot: true } },
} as const;

// ---------------------------------------------------------------------------
// listAllIncidents — GET /api/v1/admin/incidents
// ---------------------------------------------------------------------------

/**
 * ALL-status ADMIN inbox, NO backend filtering, `createdAt DESC, id DESC`.
 *
 * Spec: incident-management §"ADMIN inbox pagination"
 */
export async function listAllIncidents(
  query: AdminIncidentsQuery,
): Promise<PaginatedIncidents<AdminIncidentSummaryView>> {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.incident.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
      select: {
        id: true,
        status: true,
        reportReason: true,
        createdAt: true,
        resolvedAt: true,
        reporter: { select: { name: true, firstName: true, lastName: true } },
        subOrder: {
          select: {
            id: true,
            status: true,
            producer: { select: { businessName: true } },
            orderLines: { select: { unitPriceSnapshot: true, quantity: true } },
          },
        },
      },
    }),
    prisma.incident.count(),
  ]);

  const items = rows.map((row) => {
    const summaryRow: AdminIncidentSummaryRow = {
      id: row.id,
      status: row.status,
      reportReason: row.reportReason,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      reporterName: resolveReporterName(row.reporter),
      target: {
        subOrderId: row.subOrder.id,
        producerBusinessName: row.subOrder.producer.businessName,
        subtotal: computeSubtotal(row.subOrder.orderLines),
        fulfillmentStatus: row.subOrder.status,
      },
    };
    return mapAdminIncidentSummaryView(summaryRow);
  });

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

// ---------------------------------------------------------------------------
// getIncidentDetail — GET /api/v1/admin/incidents/:id
// ---------------------------------------------------------------------------

/**
 * Unscoped ADMIN detail — ANY incident, not just the caller's own (unlike
 * the consumer surface). Unknown id -> `NotFoundError` (404). Adds the
 * allowlisted `reporter: {name, email}`.
 *
 * Spec: incident-management §"Safe ADMIN detail"
 */
export async function getIncidentDetail(incidentId: string): Promise<AdminIncidentDetailView> {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    select: {
      id: true,
      status: true,
      reportReason: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      resolutionReason: true,
      resolvedById: true,
      reporter: { select: reporterSelect },
      subOrder: { select: subOrderSelect },
    },
  });

  if (!incident) {
    throw new NotFoundError("Incident not found");
  }

  return buildAdminDetailView(incident);
}

// ---------------------------------------------------------------------------
// resolveIncident — PATCH /api/v1/admin/incidents/:id/resolve
// ---------------------------------------------------------------------------

export interface ResolveIncidentResult {
  detail: AdminIncidentDetailView;
  pendingEmails: PendingEmail[];
}

/**
 * Resolves an `OPEN` incident. Conditionally claims the row via `updateMany`
 * constrained to `status: "OPEN"` AND both audit fields `null` — a losing
 * race or a repeated call on an already-resolved incident both hit
 * `count === 0` and throw `IncidentAlreadyResolvedError` (409) with the
 * first resolver's audit left completely unchanged (no other write ever
 * happened in this transaction before the conditional claim).
 *
 * Spec: incident-management §"Final conditional resolution"
 * Spec: incident-management §"Scope exclusions" — no commercial/fulfillment/
 *   inventory/moderation/refund side effects (this function touches ONLY
 *   the Incident row + one Notification row)
 * Spec: notifications §"Resolution notifies only reporter"
 * Spec: error-handling §"Repeated resolution returns safe conflict",
 *   §"Conflict preserves first audit"
 * Design: §"Architecture Decisions" — Conditional write vs read/update
 */
export async function resolveIncident(
  adminId: string,
  incidentId: string,
  reason: string,
): Promise<ResolveIncidentResult> {
  return prisma.$transaction(async (tx: PrismaTx) => {
    // Step 1: existence check — unknown id is a plain 404, distinct from
    // the 409 conflict an existing-but-already-resolved id produces.
    const existing = await tx.incident.findUnique({
      where: { id: incidentId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundError("Incident not found");
    }

    // Step 2: conditional claim — the ONLY write path that can ever set
    // status=RESOLVED. `count === 0` means another transaction already won
    // (or this incident was never OPEN to begin with).
    const resolvedAt = new Date();
    const { count } = await tx.incident.updateMany({
      where: { id: incidentId, status: "OPEN", resolvedById: null, resolvedAt: null },
      data: { status: "RESOLVED", resolvedById: adminId, resolutionReason: reason, resolvedAt },
    });

    if (count === 0) {
      throw new IncidentAlreadyResolvedError("Incident is already resolved");
    }

    // Step 3: re-read the now-RESOLVED row (with reporter + target) to
    // build the response view and resolve the notification recipient.
    const incident = await tx.incident.findUniqueOrThrow({
      where: { id: incidentId },
      select: {
        id: true,
        status: true,
        reportReason: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        resolutionReason: true,
        resolvedById: true,
        reporter: { select: reporterSelect },
        subOrder: { select: subOrderSelect },
      },
    });

    // Step 4: reporter-only notification, no `data` — commits or rolls
    // back with the same transaction as the resolution write above.
    const pendingEmails: PendingEmail[] = [
      await notificationsService.createNotification(tx, {
        userId: incident.reporter.id,
        type: "INCIDENT_RESOLVED",
        toEmail: incident.reporter.email,
      }),
    ];

    return { detail: buildAdminDetailView(incident), pendingEmails };
  });
}

// ---------------------------------------------------------------------------
// Shared detail-row builder
// ---------------------------------------------------------------------------

/** Row shape shared by `getIncidentDetail` and `resolveIncident`'s re-read. */
interface AdminIncidentQueryRow {
  id: string;
  status: IncidentStatus;
  reportReason: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  resolvedById: string | null;
  reporter: { id: string; name: string | null; firstName: string | null; lastName: string | null; email: string };
  subOrder: {
    id: string;
    producerId: string;
    status: string;
    shippingCostSnapshot: DecimalValue;
    trackingNumber: string | null;
    deliveryMode: { type: DeliveryModeType };
    producer: { businessName: string };
    orderLines: { productId: string; quantity: number; unitPriceSnapshot: DecimalValue }[];
  };
}

/** Builds the frozen `AdminIncidentDetailView` from a query row — shared by detail read and resolve. */
function buildAdminDetailView(incident: AdminIncidentQueryRow): AdminIncidentDetailView {
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

  const adminDetailRow: AdminIncidentDetailRow = {
    ...detailRow,
    reporter: {
      name: resolveReporterName(incident.reporter),
      email: incident.reporter.email,
    },
  };

  return mapAdminIncidentDetailView(adminDetailRow);
}
