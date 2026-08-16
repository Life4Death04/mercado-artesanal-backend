/**
 * Admin routes — mounted at /api/v1 in src/modules/api.router.ts.
 *
 * Effective paths:
 *   GET    /api/v1/admin/products?moderationStatus=<value>  — moderation queue (ADMIN)
 *   GET    /api/v1/admin/products/:id                       — moderation/detail projection (ADMIN)
 *   PATCH  /api/v1/admin/products/:id/moderation             — apply moderation transition (ADMIN)
 *   GET    /api/v1/admin/categories                         — list incl. inactive, with productCount (ADMIN)
 *   POST   /api/v1/admin/categories                         — create (auto-slug) (ADMIN)
 *   PATCH  /api/v1/admin/categories/:id                      — update name/description/isActive (ADMIN)
 *   DELETE /api/v1/admin/categories/:id                      — deactivate (soft-delete) (ADMIN)
 *   GET    /api/v1/admin/incidents?page=&limit=              — all-status inbox, paginated, no filters (ADMIN)
 *   GET    /api/v1/admin/incidents/:id                       — safe detail, reporter name/email allowlisted (ADMIN)
 *   PATCH  /api/v1/admin/incidents/:id/resolve                — final OPEN -> RESOLVED transition (ADMIN)
 *   GET    /api/v1/admin/users?page=&search=&role=&status=    — deterministic page-8 discovery (ADMIN)
 *   GET    /api/v1/admin/users/:id                            — detail + activity summary (ADMIN)
 *   PATCH  /api/v1/admin/users/:id/activate                   — idempotent DEACTIVATED->ACTIVE (ADMIN)
 *   PATCH  /api/v1/admin/users/:id/deactivate                 — idempotent ACTIVE->DEACTIVATED (ADMIN)
 *   DELETE /api/v1/admin/users/:id                            — irreversible tombstone deletion (ADMIN)
 *
 * Auth chain (per design — Data Flow):
 *   authenticate → loadUser → requireRole('ADMIN') → onboardingGate
 *
 * The guard is applied via `router.use("/admin", ...adminGuard)` so it runs
 * before every matching admin operation registered on this router — the
 * admin-incidents WU3 and admin-user-management WU2-WU4 routes below reuse
 * this SAME centralized guard, no second/competing admin guard is created.
 *
 * Spec references:
 *   admin-catalog §"Admin-only catalog surface"
 *   incident-management §"ADMIN inbox pagination", §"Safe ADMIN detail",
 *     §"Final conditional resolution"
 *   admin-user-management §"Deterministic user discovery",
 *     §"User detail and activity definitions", §"Guarded lifecycle actions"
 *   design — Data Flow, API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as adminIncidentsController from "../../incidents/controllers/admin-incidents.controller";
import * as adminUsersController from "../controllers/admin-users.controller";
import * as adminController from "../controllers/admin.controller";

export const adminRouter: Router = Router();

// Admin-scoped guard — applied to every /admin/* route on this router.
const adminGuard = [authenticate, loadUser, requireRole("ADMIN"), onboardingGate];

adminRouter.use("/admin", ...adminGuard);

// ---------------------------------------------------------------------------
// Moderation routes
// ---------------------------------------------------------------------------

adminRouter.get("/admin/products", adminController.getModerationQueue);

adminRouter.get("/admin/products/:id", adminController.getProductDetail);

adminRouter.patch("/admin/products/:id/moderation", adminController.moderateProduct);

// ---------------------------------------------------------------------------
// Category admin routes
// ---------------------------------------------------------------------------

adminRouter.get("/admin/categories", adminController.listCategories);

adminRouter.post("/admin/categories", adminController.createCategory);

adminRouter.patch("/admin/categories/:id", adminController.updateCategory);

adminRouter.delete("/admin/categories/:id", adminController.deactivateCategory);

// ---------------------------------------------------------------------------
// Incident triage/resolution routes (admin-incidents WU3)
// ---------------------------------------------------------------------------

adminRouter.get("/admin/incidents", adminIncidentsController.listIncidents);

adminRouter.get("/admin/incidents/:id", adminIncidentsController.getIncidentDetail);

adminRouter.patch("/admin/incidents/:id/resolve", adminIncidentsController.resolveIncident);

// ---------------------------------------------------------------------------
// Admin user discovery/lifecycle routes (admin-user-management WU2-WU4)
// ---------------------------------------------------------------------------

adminRouter.get("/admin/users", adminUsersController.listUsers);

adminRouter.get("/admin/users/:id", adminUsersController.getUserDetail);

adminRouter.patch("/admin/users/:id/activate", adminUsersController.activateUser);

adminRouter.patch("/admin/users/:id/deactivate", adminUsersController.deactivateUser);

adminRouter.delete("/admin/users/:id", adminUsersController.deleteUser);
