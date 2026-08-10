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
 *
 * Auth chain (per design — Data Flow):
 *   authenticate → loadUser → onboardingGate → requireRole('ADMIN')
 *
 * The guard is applied via `router.use("/admin", ...adminGuard)` so it runs
 * before every matching admin operation registered on this router.
 *
 * Spec references:
 *   admin-catalog §"Admin-only catalog surface"
 *   design — Data Flow, API surface table
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as adminController from "../controllers/admin.controller";

export const adminRouter: Router = Router();

// Admin-scoped guard — applied to every /admin/* route on this router.
const adminGuard = [authenticate, loadUser, onboardingGate, requireRole("ADMIN")];

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
