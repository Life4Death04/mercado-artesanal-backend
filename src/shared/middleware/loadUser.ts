/**
 * User loader middleware — populates req.user from the authenticated JWT subject.
 *
 * Runs AFTER `authenticate` and BEFORE `onboardingGate`. Performs a synchronous
 * (awaited) DB lookup keyed on `req.auth.payload.sub` and attaches the minimal
 * user projection { id, role, email, producerId? } to the request.
 *
 * Outcomes:
 *   - User found (PRODUCER):  req.user = { id, role, email, producerId }; next().
 *   - User found (other role): req.user = { id, role, email, producerId: undefined }; next().
 *   - User not found: req.user = null; next() is called.
 *     (Only POST /auth/sync and GET /users/me accept a null user — they are
 *      in the onboarding allow-list and handle the null case internally.)
 *   - User found but soft-deleted (`deletedAt` set): req.user = null; next().
 *     A tombstoned identity MUST NOT be authorized as its former role
 *     (admin-bootstrap §"Soft-deleted users cannot be authorized" — "Deleted
 *     identity presents a valid token").
 *   - User found but deactivated (`deactivatedAt` set, not deleted):
 *     next(AccountInactiveError) — the stable lifecycle denial (403
 *     ACCOUNT_INACTIVE), request halts here (admin-bootstrap §"Deactivated
 *     identity presents a valid token"; account-lifecycle §"Backend-wide
 *     lifecycle denial").
 *   - req.auth missing: next(UnauthorizedError) — authenticate should have run first.
 *
 * Cycle 2 extension (Decision #8): when role === 'PRODUCER', the query also
 * selects `producer { id }` (single indexed lookup, sub-ms overhead) and
 * populates `req.user.producerId`. Every producer-scoped service reads this
 * field instead of issuing a per-request producerId lookup.
 *
 * Spec reference: rbac §"Middleware composition order" + design §8 (Decision #8).
 * Spec reference: admin-bootstrap §"Soft-deleted users cannot be authorized".
 */
import type { NextFunction, Request, Response } from "express";

import { deriveAccountState } from "@/shared/account-lifecycle";
import { AccountInactiveError, UnauthorizedError } from "@/shared/errors/errors";
import { prisma } from "@/shared/utils/prisma";

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth?.payload.sub) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }

    const sub = req.auth.payload.sub;

    // No `deletedAt: null` filter here — the loader MUST evaluate lifecycle
    // state itself (admin-bootstrap delta), not rely on a query-level
    // exclusion that would make a tombstoned row indistinguishable from
    // "no user yet".
    const row = await prisma.user.findUnique({
      where: { auth0Sub: sub },
      select: {
        id: true,
        role: true,
        email: true,
        deletedAt: true,
        deactivatedAt: true,
        // Cycle 2: fetch linked Producer row so PRODUCER-scoped services can
        // read req.user.producerId without a second DB round-trip.
        producer: { select: { id: true } },
      },
    });

    if (!row) {
      // No DB record yet — allowed on first sync.
      req.user = null;
      next();
      return;
    }

    const state = deriveAccountState(row);

    if (state === "DELETED") {
      // A tombstoned identity is never authorized as its former role — treat
      // it as absent, exactly like a first-sync (admin-bootstrap scenario
      // "Deleted identity presents a valid token").
      req.user = null;
      next();
      return;
    }

    if (state === "DEACTIVATED") {
      // Stable lifecycle denial — halts the chain before onboarding/RBAC
      // ever runs (admin-bootstrap scenario "Deactivated identity presents
      // a valid token"; account-lifecycle §"Backend-wide lifecycle denial").
      next(new AccountInactiveError());
      return;
    }

    req.user = {
      id: row.id,
      role: row.role,
      email: row.email,
      // Populate producerId only for PRODUCER role; undefined for all others.
      producerId: row.role === "PRODUCER" ? (row.producer?.id ?? undefined) : undefined,
    };

    next();
  } catch (err) {
    next(err);
  }
}
