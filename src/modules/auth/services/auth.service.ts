/**
 * Auth service — handles POST /auth/sync business logic.
 *
 * syncFromClaims implements the first-sync vs re-sync branching (P-3 LOCKED),
 * extended by admin-user-management to deny lifecycle-inactive matches:
 *
 *   Tombstoned or deactivated match (admin-user-management delta):
 *     - `findByAuth0SubAny` looks up the subject INCLUDING tombstones — a
 *       deleted or deactivated match MUST receive the stable lifecycle
 *       denial and MUST NOT be updated, recreated, or treated as absent.
 *
 *   First sync (no existing user of ANY lifecycle state):
 *     - email MUST be present in claims; missing email → ValidationFailedError.
 *     - Creates user with PENDING_ROLE, all name fields null.
 *
 *   Re-sync (an ACTIVE user already exists):
 *     - Updates ONLY emailVerified — email, role, firstName, lastName are
 *       NEVER modified by this operation (P-3).
 *
 * The response is always the current User state (200 on both paths).
 *
 * Note: for a DEACTIVATED subject, `loadUser` middleware (which runs before
 * this controller/service on the `/auth/sync` route) already throws
 * `AccountInactiveError` and halts the chain — this function's own lifecycle
 * check exists for the DELETED case, where `loadUser` intentionally sets
 * `req.user = null` (treating a tombstone as "absent" for the general auth
 * chain) and the request still reaches this service.
 *
 * Spec reference: user-profile §"POST /auth/sync — idempotent user upsert"
 * Design reference: §8 "Auth0 integration design"
 */
import type { User } from "@prisma/client";

import { isAccountActive } from "@/shared/account-lifecycle";
import { AccountInactiveError, ValidationFailedError } from "@/shared/errors/errors";
import * as userRepo from "@/shared/repositories/user.repository";
import { normalizeEmail } from "@/shared/utils/normalize-email";

export interface AuthClaims {
  sub: string;
  email?: string;
  emailVerified: boolean;
}

/**
 * Idempotent user sync from Auth0 JWT claims.
 *
 * @param claims - Normalized Auth0 claims extracted from req.auth.payload.
 * @returns The current (created or updated) User row.
 */
export async function syncFromClaims(claims: AuthClaims): Promise<User> {
  // Tombstone-inclusive lookup (admin-user-management delta) — distinguishes
  // "no user yet" from "a lifecycle-inactive match exists" so a deleted
  // subject can never be silently recreated.
  const existingAny = await userRepo.findByAuth0SubAny(claims.sub);

  if (existingAny) {
    if (!isAccountActive(existingAny)) {
      throw new AccountInactiveError();
    }
    // Re-sync path: update ONLY emailVerified (P-3 LOCKED).
    return userRepo.updateEmailVerified(existingAny.id, claims.emailVerified);
  }

  // First-sync path: email is required.
  if (!claims.email) {
    throw new ValidationFailedError(
      [{ path: "email", message: "Required on first sync" }],
      "Validation failed",
    );
  }

  return userRepo.create({
    auth0Sub: claims.sub,
    email: normalizeEmail(claims.email),
    emailVerified: claims.emailVerified,
  });
}
