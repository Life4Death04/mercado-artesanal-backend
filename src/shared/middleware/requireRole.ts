/**
 * Role-based authorization middleware factory.
 *
 * MUST run AFTER `authenticate`, `loadUser`, and `onboardingGate`.
 * Returns a middleware that checks req.user.role against the allowed roles.
 *
 * Rules (per rbac spec §"requireRole middleware"):
 *   - req.user.role in roles → call next()
 *   - req.user.role NOT in roles → ForbiddenError (403)
 *   - req.user missing → UnauthorizedError (401) [defensive; normally caught by authenticate]
 *
 * Usage:
 *   router.get("/addresses", authenticate, loadUser, onboardingGate, requireRole("CONSUMER", "PRODUCER"), handler);
 *
 * Spec reference: rbac §"requireRole middleware"
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { ForbiddenError, UnauthorizedError } from "@/shared/errors/errors";

/**
 * Factory that creates a role-checking middleware.
 *
 * @param roles - One or more allowed roles. If req.user.role matches any of
 *   them the request proceeds; otherwise 403 FORBIDDEN is returned.
 */
export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }

    if (roles.includes(req.user.role)) {
      next();
      return;
    }

    next(new ForbiddenError("Role not permitted for this resource"));
  };
}
