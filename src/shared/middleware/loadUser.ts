/**
 * User loader middleware — populates req.user from the authenticated JWT subject.
 *
 * Runs AFTER `authenticate` and BEFORE `onboardingGate`. Performs a synchronous
 * (awaited) DB lookup keyed on `req.auth.payload.sub` and attaches the minimal
 * user projection { id, role, email } to the request.
 *
 * Outcomes:
 *   - User found:     req.user = { id, role, email }; next() is called.
 *   - User not found: req.user = null; next() is called.
 *     (Only POST /auth/sync and GET /users/me accept a null user — they are
 *      in the onboarding allow-list and handle the null case internally.)
 *   - req.auth missing: next(UnauthorizedError) — authenticate should have run first.
 *
 * Spec reference: rbac §"Middleware composition order" + design §5 (loadUser note).
 */
import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth?.payload.sub) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }

    const sub = req.auth.payload.sub;

    const user = await prisma.user.findUnique({
      where: { auth0Sub: sub },
      select: { id: true, role: true, email: true },
    });

    // Attach projection (null means no DB record yet — allowed on first sync).
    req.user = user ?? null;

    next();
  } catch (err) {
    next(err);
  }
}
