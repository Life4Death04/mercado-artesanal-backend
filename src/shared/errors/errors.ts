/**
 * Concrete AppError subclasses — one per registry code.
 *
 * Each subclass sets the `code`, `status`, and `title` as per the
 * error-handling spec registry. The `detail` message is passed by the
 * caller; the wire serializer (errorMiddleware) MUST NOT expose raw
 * Error.message to prevent PII leakage (RNF-05).
 *
 * Adding a new error condition MUST add a row to the spec registry AND
 * a matching class here — failing to do either breaks the invariant.
 */

import { AppError } from "./AppError";

// ---------------------------------------------------------------------------
// 401 — Missing, malformed, or invalid JWT
// ---------------------------------------------------------------------------

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly status = 401;
  readonly title = "Unauthorized";
}

// ---------------------------------------------------------------------------
// 403 — Authenticated but role is not allowed
// ---------------------------------------------------------------------------

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly status = 403;
  readonly title = "Forbidden";
}

// ---------------------------------------------------------------------------
// 403 — PENDING_ROLE user hits a non-allow-list route
// ---------------------------------------------------------------------------

export class OnboardingRequiredError extends AppError {
  readonly code = "ONBOARDING_REQUIRED" as const;
  readonly status = 403;
  readonly title = "Onboarding required";
}

// ---------------------------------------------------------------------------
// 404 — Resource does not exist or is soft-deleted
// ---------------------------------------------------------------------------

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly status = 404;
  readonly title = "Not found";
}

// ---------------------------------------------------------------------------
// 409 — Onboarding retried on a non-PENDING user
// ---------------------------------------------------------------------------

export class RoleAlreadySetError extends AppError {
  readonly code = "ROLE_ALREADY_SET" as const;
  readonly status = 409;
  readonly title = "Role already set";
}

// ---------------------------------------------------------------------------
// 409 — Producer wizard NIF collides with existing Producer
// ---------------------------------------------------------------------------

export class NifAlreadyRegisteredError extends AppError {
  readonly code = "NIF_ALREADY_REGISTERED" as const;
  readonly status = 409;
  readonly title = "NIF already registered";
}

// ---------------------------------------------------------------------------
// 422 — Zod body/query/params validation error
// ---------------------------------------------------------------------------

export class ValidationFailedError extends AppError {
  readonly code = "VALIDATION_FAILED" as const;
  readonly status = 422;
  readonly title = "Validation failed";
  readonly errors: Array<{ path: string; message: string }>;

  constructor(errors: Array<{ path: string; message: string }>, detail = "Validation failed") {
    super(detail);
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// 422 — Producer wizard references a categorySlug not in seed
// ---------------------------------------------------------------------------

export class UnknownCategoryError extends AppError {
  readonly code = "UNKNOWN_CATEGORY" as const;
  readonly status = 422;
  readonly title = "Unknown category";
}

// ---------------------------------------------------------------------------
// 422 — Consumer tries to demote current default address without promoting another
// ---------------------------------------------------------------------------

export class InvalidDefaultTransitionError extends AppError {
  readonly code = "INVALID_DEFAULT_TRANSITION" as const;
  readonly status = 422;
  readonly title = "Invalid default transition";
}

// ---------------------------------------------------------------------------
// 409 — DB-level partial unique index violation: two concurrent writes raced
//       to set isDefault=true for the same user. Client may retry.
// ---------------------------------------------------------------------------

export class AddressDefaultConflictError extends AppError {
  readonly code = "ADDRESS_DEFAULT_CONFLICT" as const;
  readonly status = 409;
  readonly title = "Address default conflict";
}
