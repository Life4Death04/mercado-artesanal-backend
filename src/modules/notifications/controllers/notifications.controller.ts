/**
 * Notifications controller — thin HTTP layer for the owner-scoped read
 * surface + mark-as-read (Cycle 5 notifications WU3).
 *
 * No request body/query validation needed here — all routes are
 * unparameterized reads or a bodyless PATCH (`:id` is consumed as a raw
 * string, matching the `orders.controller.ts`/`sub-orders.controller.ts`
 * precedent for id params: no Zod schema). All domain errors are thrown by
 * `notifications.service` and caught by the central errorMiddleware.
 *
 * Response codes:
 *   GET   /notifications             -> 200 NotificationView[]
 *   GET   /notifications/unread-count -> 200 { count: number }
 *   PATCH /notifications/:id/read    -> 200 NotificationView, 404 unknown/unowned (no-leak)
 *
 * Auth chain (mirrors orders.routes.ts / design "notifications module
 * layout"): authenticate -> loadUser -> onboardingGate ->
 * requireRole(CONSUMER|PRODUCER|ADMIN) -> controller. The auth chain
 * guarantees req.user is populated before any handler runs.
 *
 * Spec references:
 *   sdd/notifications/spec §"List Own Notifications"
 *   sdd/notifications/spec §"Unread Count"
 *   sdd/notifications/spec §"Mark Notification As Read"
 */
import type { NextFunction, Request, Response } from "express";

import * as notificationsService from "../services/notifications.service";

/**
 * GET /api/v1/notifications
 * Returns the authenticated user's own notifications, newest first.
 */
export async function listNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const notifications = await notificationsService.listMine(req.user!.id);
    res.status(200).json(notifications);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/notifications/unread-count
 * Returns the authenticated user's own unread notification count.
 */
export async function getUnreadCount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const count = await notificationsService.unreadCount(req.user!.id);
    res.status(200).json({ count });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/notifications/:id/read
 * Marks a notification owned by the authenticated user as read. Idempotent.
 * Unknown or non-owned ids resolve to 404 (no-leak, never 403).
 */
export async function markNotificationAsRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const notification = await notificationsService.markAsRead(req.user!.id, id);
    res.status(200).json(notification);
  } catch (err) {
    next(err);
  }
}
