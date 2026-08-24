/**
 * Admin Incidents DTOs — ADMIN request validation + response view mapping
 * (admin-incidents WU3: ADMIN Triage and Resolution).
 *
 * `AdminIncidentsQuerySchema` is the strict query for `GET
 * /api/v1/admin/incidents`: `page` (>=1, default 1) and `limit` (1..100,
 * default 20) ONLY — no status/filter keys are accepted. `strictObject()`
 * rejects any unknown key with `VALIDATION_FAILED` (422), which is how the
 * "no backend filtering" contract is enforced at the schema boundary (spec
 * §"ADMIN inbox pagination").
 *
 * `ResolveIncidentBodySchema` is the strict body for `PATCH
 * /api/v1/admin/incidents/:id/resolve`: a trimmed, 1..2000-char `reason` —
 * mirrors `CreateIncidentSchema`'s `reason` field exactly (same bounds).
 *
 * `mapAdminIncidentSummaryView`/`mapAdminIncidentDetailView` are PURE
 * functions that COMPOSE the WU1 consumer mappers (`mapIncidentSummaryView`/
 * `mapIncidentDetailView`) and add the ADMIN-only allowlisted reporter
 * fields — explicit field reuse, per design "explicit mapping; prevents
 * drift/leaks" (design §"Architecture Decisions" — Snapshot vs broad
 * joins). No new I/O, no Prisma calls here.
 *
 * Reporter name resolution (design §"API Contracts" — "Name is `name ??
 * joined firstName/lastName ?? null`"): `resolveReporterName` is the single
 * pure helper both the summary (`reporterName`) and detail
 * (`reporter.name`) views call, so the fallback rule never drifts between
 * the two shapes.
 *
 * PII allowlist (design §"API Contracts", RNF-05): ADMIN summary adds ONLY
 * `reporterName`; ADMIN detail adds ONLY `reporter: {name, email}` — no
 * Auth0 subject, no other User field, ever reaches these views.
 *
 * Spec references:
 *   incident-management §"ADMIN inbox pagination"
 *   incident-management §"Safe ADMIN detail"
 *   incident-management §"Final conditional resolution"
 *   error-handling §"Incident validation errors"
 *   design §"API Contracts" — ADMIN summary/detail wire shapes
 */
import { z } from "zod";

import { strictObject } from "@/shared/validation/zod";

import type { IncidentDetailRow, IncidentDetailView, IncidentSummaryRow, IncidentSummaryView } from "./incidents.dto";
import { mapIncidentDetailView, mapIncidentSummaryView } from "./incidents.dto";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/incidents — strict pagination query, no filters
// ---------------------------------------------------------------------------

/**
 * Query parameters for GET /api/v1/admin/incidents.
 *   page  — integer >= 1, default 1
 *   limit — integer 1..100, default 20
 * Any other key (including a status filter) is rejected by `strictObject()`
 * with `VALIDATION_FAILED` (422) — spec "ADMIN inbox pagination" requires
 * NO backend filtering.
 */
export const AdminIncidentsQuerySchema = strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdminIncidentsQuery = z.infer<typeof AdminIncidentsQuerySchema>;

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/incidents/:id/resolve — strict resolution body
// ---------------------------------------------------------------------------

/**
 * Body for PATCH /api/v1/admin/incidents/:id/resolve.
 *   reason — trimmed, 1..2000 chars (required)
 *
 * Mirrors `CreateIncidentSchema.reason` exactly (spec error-handling
 * §"Incident validation errors").
 */
export const ResolveIncidentBodySchema = strictObject({
  reason: z
    .string()
    .trim()
    .min(1, "reason is required")
    .max(2000, "reason must be at most 2000 characters"),
});

export type ResolveIncidentBody = z.infer<typeof ResolveIncidentBodySchema>;

// ---------------------------------------------------------------------------
// Reporter name resolution — shared by summary/detail views
// ---------------------------------------------------------------------------

/** Minimal shape `resolveReporterName` needs from a User row. */
export interface ReporterNameSource {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Resolves the ADMIN-facing reporter display name: `name` if set, else the
 * joined `firstName`/`lastName` (space-separated, trimmed), else `null` if
 * neither is available.
 *
 * Design: §"API Contracts" — "Name is `name ?? joined firstName/lastName ??
 * null`".
 */
export function resolveReporterName(user: ReporterNameSource): string | null {
  if (user.name) {
    return user.name;
  }

  const joined = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return joined.length > 0 ? joined : null;
}

// ---------------------------------------------------------------------------
// Pagination envelope — GET /api/v1/admin/incidents response
// ---------------------------------------------------------------------------

export interface PaginatedIncidents<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// AdminIncidentSummaryView — IncidentSummaryView + reporterName
// ---------------------------------------------------------------------------

export interface AdminIncidentSummaryView extends IncidentSummaryView {
  reporterName: string | null;
}

export interface AdminIncidentSummaryRow extends IncidentSummaryRow {
  reporterName: string | null;
}

/**
 * Maps an `AdminIncidentSummaryRow` to the frozen `AdminIncidentSummaryView`
 * wire shape. Pure function — composes `mapIncidentSummaryView` and adds
 * `reporterName`.
 *
 * Spec: incident-management §"ADMIN inbox pagination"
 * Design: §"API Contracts" — ADMIN summary additionally has `reporterName`
 */
export function mapAdminIncidentSummaryView(row: AdminIncidentSummaryRow): AdminIncidentSummaryView {
  return {
    ...mapIncidentSummaryView(row),
    reporterName: row.reporterName,
  };
}

// ---------------------------------------------------------------------------
// AdminIncidentDetailView — IncidentDetailView + reporter{name,email}
// ---------------------------------------------------------------------------

export interface AdminIncidentReporterView {
  name: string | null;
  email: string;
}

export interface AdminIncidentDetailView extends IncidentDetailView {
  reporter: AdminIncidentReporterView;
}

export interface AdminIncidentDetailRow extends IncidentDetailRow {
  reporter: AdminIncidentReporterView;
}

/**
 * Maps an `AdminIncidentDetailRow` to the frozen `AdminIncidentDetailView`
 * wire shape. Pure function — composes `mapIncidentDetailView` (explicit
 * field reuse) and adds the allowlisted `reporter: {name, email}`.
 *
 * Spec: incident-management §"Safe ADMIN detail"
 * Design: §"API Contracts" — ADMIN detail additionally has `reporter:{name,email}`
 */
export function mapAdminIncidentDetailView(row: AdminIncidentDetailRow): AdminIncidentDetailView {
  return {
    ...mapIncidentDetailView(row),
    reporter: row.reporter,
  };
}
