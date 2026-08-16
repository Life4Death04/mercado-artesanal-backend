/**
 * Incidents routes — mounted at /api/v1 in src/modules/api.router.ts
 * (admin-incidents WU2: Consumer APIs).
 *
 * Effective paths:
 *   POST /api/v1/incidencias
 *   GET  /api/v1/incidencias
 *   GET  /api/v1/incidencias/:id
 *
 * Auth chain (design §"API Contracts" — buyer guard):
 *   authenticate -> loadUser -> onboardingGate ->
 *   requireRole("CONSUMER", "PRODUCER") -> controller
 *
 * Reporter is `req.user.id`. PENDING_ROLE users are blocked by
 * onboardingGate (403 ONBOARDING_REQUIRED) — /incidencias is NOT in the
 * onboarding allow-list.
 *
 * Mount path: /api/v1/incidencias (mounted without prefix in api.router.ts)
 *
 * Spec references:
 *   incident-management §"Eligible single-target creation"
 *   incident-management §"Owner-scoped consumer views"
 * Design: §"API Contracts" — consumer guard chain
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as incidentsController from "../controllers/incidents.controller";

export const incidentsRouter: Router = Router();

// Guard chain for consumer-area access by users acting as buyers.
const incidentsGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("CONSUMER", "PRODUCER"),
];

// ---------------------------------------------------------------------------
// Incidents routes
// ---------------------------------------------------------------------------

incidentsRouter.post("/incidencias", ...incidentsGuard, incidentsController.createIncident);
incidentsRouter.get("/incidencias", ...incidentsGuard, incidentsController.listIncidents);
incidentsRouter.get("/incidencias/:id", ...incidentsGuard, incidentsController.getIncidentDetail);
