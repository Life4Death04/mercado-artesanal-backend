/**
 * Notifications routes — mounted at /api/v1 in src/modules/api.router.ts
 * (Cycle 5 notifications WU3).
 *
 * Effective paths:
 *   GET   /api/v1/notifications
 *   GET   /api/v1/notifications/unread-count
 *   PATCH /api/v1/notifications/:id/read
 *
 * Auth chain (mirrors orders.routes.ts — verified precedent in
 * cart.routes.ts:39): authenticate -> loadUser -> onboardingGate ->
 * requireRole(CONSUMER, PRODUCER, ADMIN) -> controller.
 *
 * Owner is `req.user.id`. Any onboarded user with a completed role may
 * read or mark-read their own notifications. PENDING_ROLE users are
 * blocked by onboardingGate (403 ONBOARDING_REQUIRED) — /notifications is
 * NOT in the onboarding allow-list.
 *
 * No path ordering conflict between the two GET routes: Express matches
 * each on its own EXACT literal path (`/notifications` vs
 * `/notifications/unread-count`), not a shared param segment.
 *
 * Spec references:
 *   sdd/notifications/spec — "List Own Notifications", "Unread Count",
 *     "Mark Notification As Read"
 *   sdd/notifications/design — "notifications module" file changes,
 *     guard chain mirrors orders.routes.ts
 */
import { Router } from "express";

import { authenticate } from "@/shared/middleware/authenticate";
import { loadUser } from "@/shared/middleware/loadUser";
import { onboardingGate } from "@/shared/middleware/onboardingGate";
import { requireRole } from "@/shared/middleware/requireRole";

import * as notificationsController from "../controllers/notifications.controller";

export const notificationsRouter: Router = Router();

// Guard chain — matches orders.routes.ts / cart.routes.ts:39 pattern
const notificationsGuard = [
  authenticate,
  loadUser,
  onboardingGate,
  requireRole("CONSUMER", "PRODUCER", "ADMIN"),
];

// ---------------------------------------------------------------------------
// Notifications routes
// ---------------------------------------------------------------------------

notificationsRouter.get(
  "/notifications",
  ...notificationsGuard,
  notificationsController.listNotifications,
);
notificationsRouter.get(
  "/notifications/unread-count",
  ...notificationsGuard,
  notificationsController.getUnreadCount,
);
notificationsRouter.patch(
  "/notifications/:id/read",
  ...notificationsGuard,
  notificationsController.markNotificationAsRead,
);
