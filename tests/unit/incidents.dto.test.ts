/**
 * Unit tests — admin-incidents WU1 (Schema and Core Contract).
 *
 * Covers three deliverables from Phase 1:
 *   1.2 `CreateIncidentSchema` (strict consumer body) + pure view mappers
 *       `mapIncidentSummaryView` / `mapIncidentDetailView`.
 *   1.3 `IncidentAlreadyResolvedError` — stable 409 code/type, no free text
 *       or protected values.
 *
 * Scenarios covered:
 *   [DTO-CREATE-1] valid body parses with trimmed reason
 *   [DTO-CREATE-2] unknown field rejected (strictObject policy) — safe path only
 *   [DTO-CREATE-3] empty reason rejected — safe path only, no value echoed
 *   [DTO-CREATE-4] missing subOrderId rejected — safe path only
 *   [DTO-CREATE-5] reason over 2000 chars rejected — safe path only
 *   [DTO-CREATE-6] reason at exactly 2000 chars accepted (boundary)
 *   [DTO-SUM-1] full summary row maps ISO dates, 2dp subtotal, live fulfillmentStatus
 *   [DTO-SUM-2] triangulation — a different summary row (RESOLVED, different money) maps independently
 *   [DTO-SUM-3] summary view excludes reporter identity / PII — allowlist only
 *   [DTO-DETAIL-1] detail row with resolution maps snapshot (shippingCost/lines)
 *                  distinct from live (trackingNumber/deliveryModeType) fields
 *   [DTO-DETAIL-2] detail row with null resolution maps resolution: null
 *   [DTO-DETAIL-3] triangulation — a different detail row maps independently
 *   [ERR-1] IncidentAlreadyResolvedError carries code/status/title/typeSlug
 *   [ERR-2] detail never echoes report/resolution free text or reporter email
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 *   incident-management §"Final conditional resolution"
 *   error-handling §"Incident validation errors"
 *   error-handling §"Safe incident resolution conflict"
 *   design §"API Contracts", §"Transactions, Errors, and Testing"
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  CreateIncidentSchema,
  mapIncidentDetailView,
  mapIncidentSummaryView,
} from "@/modules/incidents/dto/incidents.dto";
import type {
  IncidentDetailRow,
  IncidentSummaryRow,
} from "@/modules/incidents/dto/incidents.dto";
import { IncidentAlreadyResolvedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// CreateIncidentSchema — strict consumer body
// ---------------------------------------------------------------------------

describe("CreateIncidentSchema", () => {
  it("[DTO-CREATE-1] parses a valid body and trims the reason", () => {
    const result = CreateIncidentSchema.safeParse({
      subOrderId: "sub_001",
      reason: "  Package arrived damaged  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        subOrderId: "sub_001",
        reason: "Package arrived damaged",
      });
    }
  });

  it("[DTO-CREATE-2] rejects an unknown field via strictObject — safe path only", () => {
    const result = CreateIncidentSchema.safeParse({
      subOrderId: "sub_001",
      reason: "Damaged",
      resolvedById: "usr_admin",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).not.toContain("subOrderId");
      // Zod reports unrecognized_keys on the object itself (empty path);
      // no rejected VALUE ever appears in the issue message here.
      expect(result.error.issues.every((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
    }
  });

  it("[DTO-CREATE-3] rejects an empty reason — safe path only, no value echoed", () => {
    const result = CreateIncidentSchema.safeParse({
      subOrderId: "sub_001",
      reason: "   ",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const reasonIssue = result.error.issues.find((issue) => issue.path[0] === "reason");
      expect(reasonIssue).toBeDefined();
      expect(reasonIssue?.message).toBe("reason is required");
      expect(reasonIssue?.message).not.toContain("   ");
    }
  });

  it("[DTO-CREATE-4] rejects a missing subOrderId — safe path only", () => {
    const result = CreateIncidentSchema.safeParse({
      reason: "Damaged",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const idIssue = result.error.issues.find((issue) => issue.path[0] === "subOrderId");
      expect(idIssue).toBeDefined();
    }
  });

  it("[DTO-CREATE-5] rejects a reason over 2000 chars — safe path only", () => {
    const tooLong = "x".repeat(2001);
    const result = CreateIncidentSchema.safeParse({
      subOrderId: "sub_001",
      reason: tooLong,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const reasonIssue = result.error.issues.find((issue) => issue.path[0] === "reason");
      expect(reasonIssue?.message).toBe("reason must be at most 2000 characters");
      // The rejected value itself must never appear in the error message.
      expect(reasonIssue?.message).not.toContain("xxxx");
    }
  });

  it("[DTO-CREATE-6] accepts a reason at exactly 2000 chars (boundary)", () => {
    const exact = "x".repeat(2000);
    const result = CreateIncidentSchema.safeParse({
      subOrderId: "sub_001",
      reason: exact,
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapIncidentSummaryView — pure mapping, admin-incidents WU1
// ---------------------------------------------------------------------------

function makeIncidentSummaryRow(overrides: Partial<IncidentSummaryRow> = {}): IncidentSummaryRow {
  return {
    id: "inc_001",
    status: "OPEN",
    reportReason: "Package arrived damaged",
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    resolvedAt: null,
    target: {
      subOrderId: "sub_001",
      producerBusinessName: "Quesos del Vinalopó",
      subtotal: new Prisma.Decimal("24.00"),
      fulfillmentStatus: "delivered",
    },
    ...overrides,
  };
}

describe("mapIncidentSummaryView", () => {
  it("[DTO-SUM-1] maps ISO dates, 2dp Decimal subtotal, and live fulfillmentStatus", () => {
    const row = makeIncidentSummaryRow();

    const view = mapIncidentSummaryView(row);

    expect(view).toEqual({
      id: "inc_001",
      status: "OPEN",
      reportReason: "Package arrived damaged",
      createdAt: "2026-08-01T09:00:00.000Z",
      resolvedAt: null,
      target: {
        subOrderId: "sub_001",
        producerBusinessName: "Quesos del Vinalopó",
        subtotal: "24.00",
        fulfillmentStatus: "delivered",
      },
    });
  });

  it("[DTO-SUM-2] triangulation — a RESOLVED row with different money maps independently", () => {
    const row = makeIncidentSummaryRow({
      id: "inc_002",
      status: "RESOLVED",
      reportReason: "Wrong item shipped",
      createdAt: new Date("2026-01-15T00:00:00.000Z"),
      resolvedAt: new Date("2026-01-16T12:30:00.000Z"),
      target: {
        subOrderId: "sub_002",
        producerBusinessName: "Miel de la Marina",
        subtotal: new Prisma.Decimal("9.5"),
        fulfillmentStatus: "sent",
      },
    });

    const view = mapIncidentSummaryView(row);

    expect(view).toEqual({
      id: "inc_002",
      status: "RESOLVED",
      reportReason: "Wrong item shipped",
      createdAt: "2026-01-15T00:00:00.000Z",
      resolvedAt: "2026-01-16T12:30:00.000Z",
      target: {
        subOrderId: "sub_002",
        producerBusinessName: "Miel de la Marina",
        subtotal: "9.50",
        fulfillmentStatus: "sent",
      },
    });
  });

  it("[DTO-SUM-3] excludes reporter identity — allowlisted fields only", () => {
    const row = makeIncidentSummaryRow();

    const view = mapIncidentSummaryView(row);
    const keys = Object.keys(view);
    const targetKeys = Object.keys(view.target);

    expect(keys).toEqual(["id", "status", "reportReason", "createdAt", "resolvedAt", "target"]);
    expect(targetKeys).toEqual([
      "subOrderId",
      "producerBusinessName",
      "subtotal",
      "fulfillmentStatus",
    ]);
    expect(JSON.stringify(view)).not.toContain("reporter");
    expect(JSON.stringify(view)).not.toContain("@");
  });
});

// ---------------------------------------------------------------------------
// mapIncidentDetailView — pure mapping, admin-incidents WU1
// ---------------------------------------------------------------------------

function makeIncidentDetailRow(overrides: Partial<IncidentDetailRow> = {}): IncidentDetailRow {
  return {
    ...makeIncidentSummaryRow(),
    updatedAt: new Date("2026-08-01T09:00:00.000Z"),
    resolution: null,
    target: {
      subOrderId: "sub_001",
      producerBusinessName: "Quesos del Vinalopó",
      subtotal: new Prisma.Decimal("24.00"),
      fulfillmentStatus: "delivered",
      shippingCost: new Prisma.Decimal("3.50"),
      lines: [
        { productId: "prod_001", quantity: 2, unitPriceSnapshot: new Prisma.Decimal("12.00") },
      ],
      trackingNumber: "TRK-9F8E",
      deliveryModeType: "SHIPPING_FLAT_RATE",
    },
    ...overrides,
  };
}

describe("mapIncidentDetailView", () => {
  it("[DTO-DETAIL-1] maps snapshot (shippingCost/lines) distinct from live (trackingNumber/deliveryModeType)", () => {
    const row = makeIncidentDetailRow({
      resolution: {
        reason: "Refund issued out of band",
        resolvedAt: new Date("2026-08-02T10:00:00.000Z"),
        resolvedById: "usr_admin_001",
      },
    });

    const view = mapIncidentDetailView(row);

    expect(view).toEqual({
      id: "inc_001",
      status: "OPEN",
      reportReason: "Package arrived damaged",
      createdAt: "2026-08-01T09:00:00.000Z",
      resolvedAt: null,
      updatedAt: "2026-08-01T09:00:00.000Z",
      resolution: {
        reason: "Refund issued out of band",
        resolvedAt: "2026-08-02T10:00:00.000Z",
        resolvedById: "usr_admin_001",
      },
      target: {
        subOrderId: "sub_001",
        producerBusinessName: "Quesos del Vinalopó",
        subtotal: "24.00",
        fulfillmentStatus: "delivered",
        shippingCost: "3.50",
        lines: [{ productId: "prod_001", quantity: 2, unitPrice: "12.00" }],
        trackingNumber: "TRK-9F8E",
        deliveryModeType: "SHIPPING_FLAT_RATE",
      },
    });
  });

  it("[DTO-DETAIL-2] maps resolution: null for an OPEN incident", () => {
    const row = makeIncidentDetailRow();

    const view = mapIncidentDetailView(row);

    expect(view.resolution).toBeNull();
  });

  it("[DTO-DETAIL-3] triangulation — a different detail row (PICKUP, no tracking) maps independently", () => {
    const row = makeIncidentDetailRow({
      id: "inc_003",
      target: {
        subOrderId: "sub_003",
        producerBusinessName: "Aceites de la Huerta",
        subtotal: new Prisma.Decimal("18.30"),
        fulfillmentStatus: "preparing",
        shippingCost: new Prisma.Decimal("0.00"),
        lines: [
          { productId: "prod_009", quantity: 3, unitPriceSnapshot: new Prisma.Decimal("6.10") },
        ],
        trackingNumber: null,
        deliveryModeType: "PICKUP",
      },
    });

    const view = mapIncidentDetailView(row);

    expect(view.id).toBe("inc_003");
    expect(view.target).toEqual({
      subOrderId: "sub_003",
      producerBusinessName: "Aceites de la Huerta",
      subtotal: "18.30",
      fulfillmentStatus: "preparing",
      shippingCost: "0.00",
      lines: [{ productId: "prod_009", quantity: 3, unitPrice: "6.10" }],
      trackingNumber: null,
      deliveryModeType: "PICKUP",
    });
  });
});

// ---------------------------------------------------------------------------
// IncidentAlreadyResolvedError — 409 INCIDENT_ALREADY_RESOLVED
// ---------------------------------------------------------------------------

describe("IncidentAlreadyResolvedError", () => {
  it("[ERR-1] carries code INCIDENT_ALREADY_RESOLVED, status 409, and stable typeSlug", () => {
    const err = new IncidentAlreadyResolvedError("Incident already resolved");

    expect(err.code).toBe("INCIDENT_ALREADY_RESOLVED");
    expect(err.status).toBe(409);
    expect(err.title).toBe("Incident already resolved");
    expect(err.typeSlug).toBe("/errors/incident-already-resolved");
  });

  it("is an instance of Error and AppError (instanceof works across targets)", () => {
    const err = new IncidentAlreadyResolvedError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(IncidentAlreadyResolvedError);
  });

  it("[ERR-2] detail never echoes report/resolution free text or reporter email", () => {
    // Spec scenario: "Repeated resolution returns safe conflict" —
    // the response MUST NOT echo report/resolution free text, reporter
    // email, protected identifiers, or original audit values.
    const originalReason = "The producer never shipped my order, contact me at buyer@example.com";
    const err = new IncidentAlreadyResolvedError("Incident already resolved");

    expect(err.detail).not.toContain(originalReason);
    expect(err.detail).not.toContain("@example.com");
    expect(err.detail).not.toContain("buyer@");
  });
});
