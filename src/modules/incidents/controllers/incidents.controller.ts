/**
 * Incidents controller — thin HTTP layer for the consumer reporting/read
 * surface (admin-incidents WU2).
 *
 * Response codes:
 *   POST /incidencias      -> 201 IncidentDetailView, 404 opaque (unknown/unowned/
 *                              unpaid/cancelled target), 422 VALIDATION_FAILED
 *   GET  /incidencias      -> 200 IncidentSummaryView[]
 *   GET  /incidencias/:id  -> 200 IncidentDetailView, 404 unknown/unowned (no-leak)
 *
 * Auth chain (design §"API Contracts"):
 *   authenticate -> loadUser -> onboardingGate -> requireRole("CONSUMER") -> controller
 *
 * `createIncident` dispatches `pendingEmails` via the shared `dispatchEmails`
 * AFTER `incidentsService.createIncident` resolves — i.e. AFTER its
 * `$transaction` has committed (fire-after-commit, best-effort — a dispatch
 * failure never surfaces as a controller error). Mirrors
 * `sub-orders.controller.ts` `patchSubOrder`.
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 *   notifications §"Report notifies current administrators"
 * Design: §"API Contracts"
 */
import type { NextFunction, Request, Response } from "express";

import { dispatchEmails } from "@/shared/email/email-provider";
import { validateBody } from "@/shared/validation/zod";

import { CreateIncidentSchema } from "../dto/incidents.dto";
import * as incidentsService from "../services/incidents.service";

/**
 * POST /api/v1/incidencias
 * Creates an OPEN incident for a sub-order the caller owns, paid, and not
 * cancelled. Reporter is derived from `req.user.id` — never client-settable.
 */
export async function createIncident(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = validateBody(CreateIncidentSchema, req.body);
    const { detail, pendingEmails } = await incidentsService.createIncident(req.user!.id, body);

    await dispatchEmails(pendingEmails);

    res.status(201).json(detail);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/incidencias
 * Returns the authenticated user's own incidents, `createdAt DESC, id DESC`.
 */
export async function listIncidents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const incidents = await incidentsService.listIncidents(req.user!.id);
    res.status(200).json(incidents);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/incidencias/:id
 * Returns the nested detail for an incident owned by the authenticated user.
 * Unknown or non-owned ids resolve to 404 (no-leak, never 403).
 */
export async function getIncidentDetail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const incident = await incidentsService.getIncidentDetail(req.user!.id, id);
    res.status(200).json(incident);
  } catch (err) {
    next(err);
  }
}
