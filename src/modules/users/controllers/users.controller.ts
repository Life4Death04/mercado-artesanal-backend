/**
 * Users controller — handles GET /api/v1/users/me.
 *
 * Uses req.user.id (set by loadUser) to fetch the full profile via the service.
 *
 * Edge cases:
 *   - req.user is null (JWT valid but no DB row yet): returns 404 NOT_FOUND
 *     per user-profile spec §"No user row yet" scenario.
 *   - req.user is undefined: authenticate/loadUser did not run — defensive 401.
 *
 * Auth chain for this route:
 *   authenticate → loadUser → onboardingGate(allow-listed) → controller
 *
 * Spec reference: user-profile §"GET /users/me — read current user"
 */
import type { NextFunction, Request, Response } from "express";

import { NotFoundError, UnauthorizedError } from "@/shared/errors/errors";

import * as usersService from "../services/users.service";

/**
 * GET /api/v1/users/me
 *
 * Returns the full user profile. 404 if no DB row exists for the JWT sub.
 */
export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // loadUser sets req.user to null when there is no DB record.
    if (req.user === undefined) {
      throw new UnauthorizedError("Authentication required");
    }

    if (req.user === null) {
      throw new NotFoundError("User not found");
    }

    const meView = await usersService.getMe(req.user.id);

    if (!meView) {
      throw new NotFoundError("User not found");
    }

    res.status(200).json(meView);
  } catch (err) {
    next(err);
  }
}
