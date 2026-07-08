/**
 * JWT authentication middleware.
 *
 * Built on `express-oauth2-jwt-bearer`. Validates every incoming request
 * against Auth0-issued RS256 JWTs, using JWKS caching with automatic key
 * rotation (10-minute TTL, refetch on unknown `kid`).
 *
 * On success: populates `req.auth` with the decoded JWT payload.
 * On failure: calls next(err) with a library-specific error shape, which
 *   errorMiddleware remaps to UnauthorizedError (R-5 LOCKED in design §8).
 *
 * Env vars consumed (Zod-validated at boot via env.ts):
 *   AUTH0_AUDIENCE   — API identifier registered in Auth0
 *   AUTH0_DOMAIN     — Tenant domain (no scheme, no trailing slash)
 *
 * Spec reference: auth-jwt §"JWT validation middleware"
 *
 * IMPORTANT: This middleware must NEVER be placed on public routes
 * (/health, /health/ready). It belongs only on private /api/v1/* routes,
 * wired per-route-file (not globally in app.ts).
 */
import { auth } from "express-oauth2-jwt-bearer";

import { env } from "@/shared/utils/env";

/**
 * Drop-in Express middleware.
 *
 * Usage in a route file:
 *   router.post("/auth/sync", authenticate, loadUser, onboardingGate, controller);
 *
 * The JWKS cache and rotation behaviour is the library default:
 *   - In-memory LRU cache, 10-minute TTL.
 *   - On unknown `kid`, the middleware refetches the JWKS once before
 *     rejecting the request — no server restart needed for key rotation.
 */
export const authenticate = auth({
  audience: env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${env.AUTH0_DOMAIN}/`,
  tokenSigningAlg: "RS256",
});
