/**
 * Auth service — handles POST /auth/sync business logic.
 *
 * syncFromClaims implements the first-sync vs re-sync branching (P-3 LOCKED):
 *
 *   First sync (no existing user):
 *     - email MUST be present in claims; missing email → ValidationFailedError.
 *     - Creates user with PENDING_ROLE, all name fields null.
 *
 *   Re-sync (user already exists):
 *     - Updates ONLY emailVerified — email, role, firstName, lastName are
 *       NEVER modified by this operation (P-3).
 *
 * The response is always the current User state (200 on both paths).
 *
 * Spec reference: user-profile §"POST /auth/sync — idempotent user upsert"
 * Design reference: §8 "Auth0 integration design"
 */
import type { User } from "@prisma/client";

import { ValidationFailedError } from "@/shared/errors/errors";
import * as userRepo from "@/shared/repositories/user.repository";

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
  const existing = await userRepo.findByAuth0Sub(claims.sub);

  if (existing) {
    // Re-sync path: update ONLY emailVerified (P-3 LOCKED).
    return userRepo.updateEmailVerified(existing.id, claims.emailVerified);
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
    email: claims.email,
    emailVerified: claims.emailVerified,
  });
}
