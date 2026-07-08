/**
 * Unit tests — rbac spec: requireRole factory behavior.
 *
 * Scenarios covered (per rbac spec §"requireRole middleware"):
 *   1. req.user.role is in the allowed list → next() without error.
 *   2. req.user.role is NOT in the allowed list → ForbiddenError (403).
 *   3. req.user is null → UnauthorizedError (401).
 *   4. req.user is undefined → UnauthorizedError (401).
 *   5. Multiple allowed roles — at least one match → passes.
 *   6. Multiple allowed roles — no match → ForbiddenError.
 *
 * No HTTP layer — we mock req, res, next as plain objects.
 */
import { describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/shared/errors/errors";
import { requireRole } from "@/shared/middleware/requireRole";

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function buildReq(role?: string | null) {
  if (role === undefined) return {}; // no user property
  if (role === null) return { user: null }; // null user
  return { user: { id: "u1", role, email: "a@b.com" } };
}

const resMock = {};

// ---------------------------------------------------------------------------
// Scenario 1: Matching role → passes
// ---------------------------------------------------------------------------

describe("Scenario 1 — matching role passes", () => {
  it("CONSUMER role with requireRole('CONSUMER') → next() without error", () => {
    const next = vi.fn();
    const req = buildReq("CONSUMER");

    requireRole("CONSUMER")(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error argument
  });

  it("ADMIN role with requireRole('ADMIN') → next() without error", () => {
    const next = vi.fn();
    const req = buildReq("ADMIN");

    requireRole("ADMIN")(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("PRODUCER role with requireRole('PRODUCER') → next() without error", () => {
    const next = vi.fn();
    const req = buildReq("PRODUCER");

    requireRole("PRODUCER")(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Non-matching role → ForbiddenError (403)
// ---------------------------------------------------------------------------

describe("Scenario 2 — non-matching role is rejected with 403 FORBIDDEN", () => {
  it("CONSUMER role with requireRole('ADMIN') → ForbiddenError", () => {
    const next = vi.fn();
    const req = buildReq("CONSUMER");

    requireRole("ADMIN")(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).code).toBe("FORBIDDEN");
    expect((err as ForbiddenError).status).toBe(403);
  });

  it("PRODUCER role with requireRole('CONSUMER') → ForbiddenError", () => {
    const next = vi.fn();
    const req = buildReq("PRODUCER");

    requireRole("CONSUMER")(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: null user → UnauthorizedError (401)
// ---------------------------------------------------------------------------

describe("Scenario 3 — null req.user → UnauthorizedError (401)", () => {
  it("null user → UnauthorizedError", () => {
    const next = vi.fn();
    const req = buildReq(null);

    requireRole("CONSUMER")(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: undefined user → UnauthorizedError (401)
// ---------------------------------------------------------------------------

describe("Scenario 4 — undefined req.user → UnauthorizedError (401)", () => {
  it("no user property on req → UnauthorizedError", () => {
    const next = vi.fn();
    const req = buildReq(undefined); // returns {} — no user property

    requireRole("CONSUMER")(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Multiple allowed roles — any match passes
// ---------------------------------------------------------------------------

describe("Scenario 5 — multiple allowed roles: match on any passes", () => {
  it("requireRole('CONSUMER', 'PRODUCER') allows CONSUMER", () => {
    const next = vi.fn();
    requireRole("CONSUMER", "PRODUCER")(buildReq("CONSUMER") as never, resMock as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("requireRole('CONSUMER', 'PRODUCER') allows PRODUCER", () => {
    const next = vi.fn();
    requireRole("CONSUMER", "PRODUCER")(buildReq("PRODUCER") as never, resMock as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("requireRole('CONSUMER', 'PRODUCER', 'ADMIN') allows ADMIN", () => {
    const next = vi.fn();
    requireRole("CONSUMER", "PRODUCER", "ADMIN")(
      buildReq("ADMIN") as never,
      resMock as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Multiple allowed roles — no match → ForbiddenError
// ---------------------------------------------------------------------------

describe("Scenario 6 — multiple allowed roles: no match rejects with 403", () => {
  it("requireRole('CONSUMER', 'PRODUCER') rejects ADMIN", () => {
    const next = vi.fn();
    requireRole("CONSUMER", "PRODUCER")(buildReq("ADMIN") as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("requireRole('ADMIN') rejects PENDING_ROLE", () => {
    const next = vi.fn();
    requireRole("ADMIN")(buildReq("PENDING_ROLE") as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});
