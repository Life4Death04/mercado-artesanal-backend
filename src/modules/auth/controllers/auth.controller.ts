/**
 * Auth controller — handles POST /api/v1/auth/sync.
 *
 * Extracts normalized Auth0 claims from req.auth.payload and delegates to
 * auth.service.syncFromClaims. Returns the resulting User as 200 JSON.
 *
 * The controller MUST NOT:
 *   - Inspect req.auth.payload directly beyond claim extraction.
 *   - Modify role or any fields beyond what the service contract allows.
 *   - Call next(err) on success (the service throws typed AppErrors on failure;
 *     errorMiddleware catches them automatically).
 *
 * Auth chain for this route:
 *   authenticate → loadUser → onboardingGate(allow-listed) → controller
 *
 * Spec reference: user-profile §"POST /auth/sync — idempotent user upsert"
 */
import type { NextFunction, Request, Response } from "express";

import { env } from "@/shared/utils/env";

import * as authService from "../services/auth.service";

const auth0ClaimNamespace = env.AUTH0_AUDIENCE.replace(/\/$/, "");

function stringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function booleanClaim(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function namespacedClaimKey(claim: string): string {
  return `${auth0ClaimNamespace}/${claim}`;
}

/**
 * POST /api/v1/auth/sync
 *
 * Normalizes JWT claims from req.auth.payload, delegates to auth service,
 * and returns the User row as 200.
 */
export async function sync(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = req.auth?.payload;

    // authenticate middleware guarantees req.auth is present; defensive guard.
    if (!payload) {
      throw new Error("authenticate middleware must run before auth.controller.sync");
    }

    // express-oauth2-jwt-bearer guarantees sub is present on every valid token.
    // The TypeScript type is string | undefined per the ambient declaration; we
    // guard defensively and fall back to a 401 if somehow missing.
    if (!payload.sub) {
      throw new Error("JWT sub claim is missing after authentication");
    }

    const email =
      stringClaim(payload, "email") ?? stringClaim(payload, namespacedClaimKey("email"));
    const emailVerified =
      booleanClaim(payload, "email_verified") ??
      booleanClaim(payload, namespacedClaimKey("email_verified")) ??
      false;

    const claims = {
      sub: payload.sub,
      email,
      emailVerified,
    };

    const user = await authService.syncFromClaims(claims);

    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
}
