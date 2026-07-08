/**
 * Onboarding gate middleware.
 *
 * Positioned between `loadUser` and `requireRole` in the per-route auth chain:
 *   authenticate → loadUser → onboardingGate → requireRole → handler
 *
 * Rules (per rbac spec §"Onboarding gate middleware"):
 *   1. If req.user is missing → UnauthorizedError (loadUser should have run).
 *   2. If req.user.role !== PENDING_ROLE → pass through (call next()).
 *   3. If req.user.role === PENDING_ROLE AND path+method is in the allow-list → pass through.
 *   4. If req.user.role === PENDING_ROLE AND path+method is NOT in the allow-list
 *      → OnboardingRequiredError (403).
 *
 * Allow-list (Cycle 1, exact method+path matches):
 *   POST  /api/v1/auth/sync
 *   GET   /api/v1/users/me
 *   POST  /api/v1/users/me/onboarding/consumer
 *   POST  /api/v1/users/me/onboarding/producer
 *
 * Public paths (/health, /health/ready) are NOT here — they bypass the auth
 * chain entirely and never reach this middleware.
 *
 * Spec reference: rbac §"Onboarding gate middleware"
 */
import type { NextFunction, Request, Response } from "express";

import { OnboardingRequiredError, UnauthorizedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// Allow-list — Cycle 1 exact matches.
//
// MATCHING CONTRACT (load-bearing — read before adding entries):
//   - Compared against `req.method` (already uppercase per Express) and
//     `req.path` (Express-normalized path WITHOUT query string; distinct
//     from `req.originalUrl`).
//   - Comparison is exact string equality — NO trailing slash, NO case
//     normalization, NO mount-path prefix handling. Register paths exactly
//     as they will be mounted under `/api/v1`.
//   - If a route is later mounted at a different prefix, update this list
//     AND the spec (rbac §"Onboarding gate middleware").
//
// Extend this list when new wizard-accessible routes are added.
// ---------------------------------------------------------------------------
export const ONBOARDING_ALLOW_LIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/v1/auth/sync" },
  { method: "GET", path: "/api/v1/users/me" },
  { method: "POST", path: "/api/v1/users/me/onboarding/consumer" },
  { method: "POST", path: "/api/v1/users/me/onboarding/producer" },
];

const PENDING_ROLE = "PENDING_ROLE";

export function onboardingGate(req: Request, _res: Response, next: NextFunction): void {
  if (req.user === undefined) {
    next(new UnauthorizedError("Authentication required before onboarding gate"));
    return;
  }

  // null user (no DB record yet) is only valid on allow-listed paths.
  // Treat null user as PENDING_ROLE for gate purposes — the route handler
  // is responsible for handling the null case. Note: the `undefined` case
  // was already handled above, so only `null` or a real user reach here.
  const role = req.user === null ? PENDING_ROLE : req.user.role;

  if (role !== PENDING_ROLE) {
    next();
    return;
  }

  const isAllowed = ONBOARDING_ALLOW_LIST.some(
    (entry) => entry.method === req.method && entry.path === req.path,
  );

  if (isAllowed) {
    next();
    return;
  }

  next(new OnboardingRequiredError("Complete onboarding to access this resource"));
}
