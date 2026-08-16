/**
 * Admin Users controller — thin HTTP layer for `/admin/users/*` discovery
 * and lifecycle administration (admin-user-management WU2-WU4).
 *
 * Response codes:
 *   GET    /admin/users             -> 200 PaginatedUsers<UserSummaryView>,
 *                                       422 VALIDATION_FAILED (bad query)
 *   GET    /admin/users/:id         -> 200 UserDetailView, 404 NOT_FOUND
 * Auth chain (mounted under `adminRouter`'s centralized guard in
 * `admin.routes.ts`): authenticate -> loadUser -> requireRole("ADMIN") ->
 * onboardingGate -> controller.
 * Spec references:
 *   admin-user-management §"Deterministic user discovery"
 *   admin-user-management §"User detail and activity definitions"
 * Design: §"Interfaces / Contracts"
 */
import type { NextFunction, Request, Response } from "express";

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
