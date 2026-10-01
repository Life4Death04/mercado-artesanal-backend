/**
 * Demo policy guard middleware.
 *
 * Positioned after `loadUser` in the per-route auth chain — enforces the
 * public demo/guest environment's mutation allow-list. A demo account
 * (`req.user.isDemo === true`) keeps every read (GET/HEAD/OPTIONS) and every
 * allow-listed mutation; every other mutating request is denied so the demo
 * cannot be permanently altered by a visitor.
 *
 * Rules (demo-guest-environment plan v2, WU2):
 *   1. Safe/idempotent methods (GET, HEAD, OPTIONS) always pass through —
 *      this guard never restricts reads.
 *   2. req.user missing, null, or isDemo !== true → pass through — this
 *      guard only restricts demo accounts, and owns no auth/onboarding
 *      semantics of its own (that belongs to loadUser/onboardingGate).
 *   3. A mutating request (POST, PUT, PATCH, DELETE) from a demo account is
 *      allowed only when method+path matches an entry in
 *      DEMO_MUTATION_ALLOW_LIST (":param" segments match any single
 *      non-empty path segment) — otherwise DemoReadOnlyError (403).
 *
 * Allow-list (WU2, 14 entries — demo-guest-environment plan v2 design):
 *   POST   /api/v1/auth/sync                        (MANDATORY — login dies without it)
 *   POST   /api/v1/carrito/items
 *   PATCH  /api/v1/carrito/items/:itemId
 *   DELETE /api/v1/carrito/items/:itemId
 *   DELETE /api/v1/carrito
 *   POST   /api/v1/users/me/addresses
 *   POST   /api/v1/incidencias
 *   POST   /api/v1/products/:id/report
 *   POST   /api/v1/pagos/intent
 *   PATCH  /api/v1/admin/products/:id/moderation
 *   PATCH  /api/v1/admin/incidents/:id/resolve
 *   PATCH  /api/v1/admin/users/:id/activate
 *   POST   /api/v1/producers/me/products/:id/images/presign  (TEMPORARY — demo S3 pipeline smoke test, revert after validation)
 *   POST   /api/v1/producers/me/products/:id/images/confirm  (TEMPORARY — demo S3 pipeline smoke test, revert after validation)
 *
 * NOT mounted on any route yet — that is WU3 (blocked on a separate mount
 * strategy decision). This module is self-contained and independently
 * testable.
 */
import type { NextFunction, Request, Response } from "express";

import { DemoReadOnlyError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// Allow-list — WU2. Exact method match; path segments starting with ":" match
// any single non-empty path segment, everything else must be a literal exact
// match, and total segment count must match exactly.
//
// MATCHING CONTRACT (load-bearing — read before adding entries):
//   - Compared against `req.method` (already uppercase per Express) and
//     `req.originalUrl` (falls back to `req.path` for unit tests that pass a
//     plain object without `originalUrl`), query string stripped.
//   - Register paths exactly as they are mounted under `/api/v1`.
//   - This guard is ONLY evaluated for mutating methods (see
//     MUTATING_METHODS below) — GET/HEAD/OPTIONS never reach the allow-list.
// ---------------------------------------------------------------------------
export const DEMO_MUTATION_ALLOW_LIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/v1/auth/sync" },
  { method: "POST", path: "/api/v1/carrito/items" },
  { method: "PATCH", path: "/api/v1/carrito/items/:itemId" },
  { method: "DELETE", path: "/api/v1/carrito/items/:itemId" },
  { method: "DELETE", path: "/api/v1/carrito" },
  { method: "POST", path: "/api/v1/users/me/addresses" },
  { method: "POST", path: "/api/v1/incidencias" },
  { method: "POST", path: "/api/v1/products/:id/report" },
  { method: "POST", path: "/api/v1/pagos/intent" },
  { method: "PATCH", path: "/api/v1/admin/products/:id/moderation" },
  { method: "PATCH", path: "/api/v1/admin/incidents/:id/resolve" },
  { method: "PATCH", path: "/api/v1/admin/users/:id/activate" },
  { method: "POST", path: "/api/v1/producers/me/products/:id/images/presign" },
  { method: "POST", path: "/api/v1/producers/me/products/:id/images/confirm" },
];

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Matches a single allow-list entry's path pattern against an actual request
 * path. ":param" segments match any single non-empty segment; every other
 * segment must match literally; segment counts must match exactly.
 */
function matchesPattern(pattern: string, actualPath: string): boolean {
  const patternSegments = pattern.split("/");
  const actualSegments = actualPath.split("/");
  if (patternSegments.length !== actualSegments.length) return false;
  return patternSegments.every((segment, i) => {
    const actual = actualSegments[i];
    if (segment.startsWith(":")) return actual !== undefined && actual.length > 0;
    return segment === actual;
  });
}

function isAllowListed(method: string, path: string): boolean {
  return DEMO_MUTATION_ALLOW_LIST.some(
    (entry) => entry.method === method && matchesPattern(entry.path, path),
  );
}

export function demoPolicyGuard(req: Request, _res: Response, next: NextFunction): void {
  if (req.user === undefined || req.user === null || req.user.isDemo !== true) {
    next();
    return;
  }

  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const fullPath = req.originalUrl ?? req.path;
  const requestPath = fullPath.split("?")[0] ?? fullPath;

  if (isAllowListed(req.method, requestPath)) {
    next();
    return;
  }

  next(new DemoReadOnlyError());
}
