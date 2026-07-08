/**
 * Central RFC 7807 error handler — MUST be the LAST middleware in the chain.
 *
 * Middleware composition position (per design §6):
 *   ... → notFoundHandler → errorMiddleware
 *
 * Responsibilities:
 *   1. R-5 LOCKED — Auth0 library error remapping: express-oauth2-jwt-bearer
 *      throws its own shapes (InvalidTokenError, UnauthorizedError, { status: 401 }).
 *      The single remapping branch at the top of this handler converts them to
 *      UnauthorizedError before RFC 7807 serialization — downstream code never
 *      sees library-specific shapes.
 *
 *   2. ZodError escape hatch: a raw ZodError that escapes a controller without
 *      being wrapped is converted to ValidationFailedError here.
 *
 *   3. AppError serialization: converts typed errors to RFC 7807 Problem Details
 *      with Content-Type: application/problem+json.
 *
 *   4. Fallback (500): any unknown error is logged at `error` level and returned
 *      as INTERNAL_ERROR. The raw message is NEVER echoed (PII safety, RNF-05).
 *
 * Stack traces are suppressed in all environments at the wire level — the logger
 * captures the full error object internally.
 */
import type { NextFunction, Request, Response } from "express";

import { AppError } from "@/shared/errors/AppError";
import { UnauthorizedError, ValidationFailedError } from "@/shared/errors/errors";

// ---------------------------------------------------------------------------
// ZodError shape (minimal — avoids importing zod just for the type guard).
// ---------------------------------------------------------------------------
interface ZodIssue {
  path: (string | number)[];
  message: string;
}

interface ZodErrorLike {
  name: "ZodError";
  issues: ZodIssue[];
}

function isZodError(err: unknown): err is ZodErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

// ---------------------------------------------------------------------------
// Auth0 library error shape guard (R-5 LOCKED)
// ---------------------------------------------------------------------------
function isAuth0LibraryError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; name?: unknown };
  return e.status === 401 || e.name === "InvalidTokenError" || e.name === "UnauthorizedError";
}

// ---------------------------------------------------------------------------
// Error middleware — 4-arg signature required by Express
// ---------------------------------------------------------------------------

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const instance = (req.id as string | undefined) ?? "unknown";

  // Step 1: R-5 LOCKED — remap Auth0 library errors to our UnauthorizedError.
  // This is the single canonical mapping point; nothing else in the codebase
  // should catch or inspect express-oauth2-jwt-bearer error shapes.
  let resolvedErr = err;
  if (isAuth0LibraryError(resolvedErr)) {
    // AppError's second argument IS the cause value directly (not an ES2022
    // `{ cause }` options object). Pass the original error, not a wrapper.
    resolvedErr = new UnauthorizedError("Invalid or missing token", resolvedErr);
  }

  // Step 2: ZodError escape hatch — convert to ValidationFailedError.
  if (isZodError(resolvedErr)) {
    const zodErr = resolvedErr;
    resolvedErr = new ValidationFailedError(
      zodErr.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  // Step 3: Typed AppError → RFC 7807 response.
  if (resolvedErr instanceof AppError) {
    req.log?.warn({ err: resolvedErr, code: resolvedErr.code }, "handled AppError");

    const body: Record<string, unknown> = {
      type: resolvedErr.typeSlug,
      title: resolvedErr.title,
      status: resolvedErr.status,
      detail: resolvedErr.detail,
      code: resolvedErr.code,
      instance,
    };

    if (resolvedErr instanceof ValidationFailedError) {
      body["errors"] = resolvedErr.errors;
    }

    res.status(resolvedErr.status).type("application/problem+json").json(body);
    return;
  }

  // Step 4: Fallback — unknown error; log fully, return opaque 500.
  // The raw message is intentionally NOT included in the response body (PII safety).
  req.log?.error({ err: resolvedErr }, "unhandled error");

  res.status(500).type("application/problem+json").json({
    type: "/errors/internal-error",
    title: "Internal server error",
    status: 500,
    detail: "Unexpected error",
    code: "INTERNAL_ERROR",
    instance,
  });
}
