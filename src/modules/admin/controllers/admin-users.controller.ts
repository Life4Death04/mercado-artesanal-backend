/**
 * Admin Users controller — thin HTTP layer for `/admin/users/*` discovery
 * and lifecycle administration (admin-user-management WU2-WU4).
 *
 * Response codes:
 *   GET    /admin/users             -> 200 PaginatedUsers<UserSummaryView>,
 *                                       422 VALIDATION_FAILED (bad query)
 *   GET    /admin/users/:id         -> 200 UserDetailView, 404 NOT_FOUND
 *   PATCH  /admin/users/:id/activate   -> 200 UserDetailView, 404 NOT_FOUND,
 *                                          409 ACCOUNT_DELETED
 *   PATCH  /admin/users/:id/deactivate -> 200 UserDetailView, 404 NOT_FOUND
 *   DELETE /admin/users/:id         -> 204 (no body), 404 NOT_FOUND,
 *                                       409 ACCOUNT_DELETED, 409 USER_HAS_ACTIVE_ORDERS
 *
 * Auth chain (mounted under `adminRouter`'s centralized guard in
 * `admin.routes.ts`): authenticate -> loadUser -> requireRole("ADMIN") ->
 * onboardingGate -> controller.
 *
 * `activateUser` dispatches `pendingEmails` via the shared `dispatchEmails`
 * AFTER `adminUsersService.activateUser` resolves — i.e. AFTER its
 * `$transaction` has committed (fire-after-commit, best-effort). Mirrors
 * `admin-incidents.controller.ts` `resolveIncident`.
 *
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 *   admin-user-management §"Guarded lifecycle actions"
 *   email-provider §"Activation email follows committed notification"
 * Design: §"Interfaces / Contracts"
 */
import type { NextFunction, Request, Response } from "express";

import { dispatchEmails } from "@/shared/email/email-provider";
import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { ListUsersQuerySchema } from "../dto/admin-users.dto";
import * as adminUsersService from "../services/admin-users.service";

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
 * GET /api/v1/admin/users
 * Deterministic, page-8 discovery over CONSUMER/PRODUCER accounts only.
 */
export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireAdminId(req);

    const query = validateBody(ListUsersQuerySchema, req.query);
    const result = await adminUsersService.listUsers(query);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/admin/users/:id
 * Actionable-user detail + derived lifecycle status + activity summary.
 */
export async function getUserDetail(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const detail = await adminUsersService.getUserDetail(id);

    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/users/:id/activate
 * Idempotent DEACTIVATED -> ACTIVE transition. Dispatches the
 * `ACCOUNT_ACTIVATED` email AFTER the transition transaction commits
 * (best-effort — a provider failure never affects the response).
 */
export async function activateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const { detail, pendingEmails } = await adminUsersService.activateUser(id);

    await dispatchEmails(pendingEmails);

    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/v1/admin/users/:id/deactivate
 * Idempotent ACTIVE -> DEACTIVATED transition.
 */
export async function deactivateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    const detail = await adminUsersService.deactivateUser(id);

    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/admin/users/:id
 * Irreversible tombstone deletion, guarded by an active-order check.
 * Returns 204 with no body — mirrors the project-wide DELETE convention
 * (`admin.controller.ts` `deactivateCategory`).
 */
export async function deleteUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);

    const { id } = req.params as { id: string };
    await adminUsersService.deleteUser(id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
