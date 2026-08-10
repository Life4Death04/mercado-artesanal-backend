/**
 * Admin Incidents controller — thin HTTP layer for the ADMIN triage/
 * resolution surface (admin-incidents WU3).
 *
 * Response codes:
 *   GET   /admin/incidents             -> 200 PaginatedIncidents<AdminIncidentSummaryView>,
 *                                          422 VALIDATION_FAILED (bad/unknown query keys)
 *   GET   /admin/incidents/:id         -> 200 AdminIncidentDetailView, 404 unknown id
 *   PATCH /admin/incidents/:id/resolve -> 200 AdminIncidentDetailView, 404 unknown id,
 *                                          409 INCIDENT_ALREADY_RESOLVED, 422 VALIDATION_FAILED
 *
 * Auth chain (mounted under `adminRouter`'s centralized guard in
 * `admin.routes.ts`): authenticate -> loadUser -> requireRole("ADMIN") ->
 * onboardingGate -> controller.
 *
 * `resolveIncident` dispatches `pendingEmails` via the shared
 * `dispatchEmails` AFTER `adminIncidentsService.resolveIncident` resolves —
 * i.e. AFTER its `$transaction` has committed (fire-after-commit,
 * best-effort). Mirrors `incidents.controller.ts` `createIncident`.
 *
 * Spec references:
 *   incident-management §"ADMIN inbox pagination"
 *   incident-management §"Safe ADMIN detail"
 *   incident-management §"Final conditional resolution"
 * Design: §"API Contracts"
 */
import type { NextFunction, Request, Response } from "express";

import { dispatchEmails } from "@/shared/email/email-provider";
import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { AdminIncidentsQuerySchema, ResolveIncidentBodySchema } from "../dto/admin-incidents.dto";
import * as adminIncidentsService from "../services/admin-incidents.service";

/**
 * Every handler in this module runs behind `adminRouter`'s centralized
 * `requireRole("ADMIN")` guard — `req.user` is guaranteed non-null there.
 * This guard is defensive-only (mirrors `admin.controller.ts`'s
 * `requireAdminId`) and should never trigger in production.
 */
function requireAdminId(req: Request): string {
  if (!req.user) throw new UnauthorizedError("Admin user not found for this request");
  return req.user.id;
}

/**
 * GET /api/v1/admin/incidents
 * Returns the ALL-status ADMIN inbox, paginated, `createdAt DESC, id DESC`,
 * no backend filtering. Strict query — an unknown/filter key returns 422.
 */
export async function listIncidents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const query = validateBody(AdminIncidentsQuerySchema, req.query);
    const result = await adminIncidentsService.listAllIncidents(query);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/incidents/:id
 * Returns the ADMIN detail view for ANY incident (unscoped by reporter).
 * Unknown id returns 404 NOT_FOUND.
 */
export async function getIncidentDetail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const incident = await adminIncidentsService.getIncidentDetail(id);

    res.status(200).json(incident);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/incidents/:id/resolve
 * Resolves an `OPEN` incident. Resolver is derived from `req.user.id` —
 * never client-settable. Returns 409 INCIDENT_ALREADY_RESOLVED for an
 * already-resolved or raced-and-lost incident (audit left unchanged).
 */
export async function resolveIncident(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = requireAdminId(req);

    const { id } = req.params as { id: string };
    const { reason } = validateBody(ResolveIncidentBodySchema, req.body);
    const { detail, pendingEmails } = await adminIncidentsService.resolveIncident(
      adminId,
      id,
      reason,
    );

    await dispatchEmails(pendingEmails);

    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
}
