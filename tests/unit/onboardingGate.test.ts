/**
 * Unit tests — rbac spec: onboarding gate allow-list behavior.
 *
 * Scenarios covered (per rbac spec §"Onboarding gate middleware"):
 *   1. PENDING_ROLE user on allow-listed route → next() called without error.
 *   2. PENDING_ROLE user on non-allow-listed route → OnboardingRequiredError (403).
 *   3. Non-PENDING role (CONSUMER, PRODUCER, ADMIN) → always passes through.
 *   4. null user (no DB record) on allow-listed route → passes through.
 *   5. null user on non-allow-listed route → OnboardingRequiredError.
 *   6. undefined user (loadUser not run) → UnauthorizedError.
 *   7. All four allow-listed paths are accepted for PENDING_ROLE.
 *
 * No HTTP layer / Express involved — we mock req, res, next as plain objects.
 */
import { describe, expect, it, vi } from "vitest";

import { OnboardingRequiredError, UnauthorizedError } from "@/shared/errors/errors";
import { ONBOARDING_ALLOW_LIST, onboardingGate } from "@/shared/middleware/onboardingGate";

// ---------------------------------------------------------------------------
// Mock builder
// ---------------------------------------------------------------------------

function buildReq(overrides: { method?: string; path?: string; user?: unknown }) {
  return {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/v1/some/path",
    user: overrides.user,
  };
}

const resMock = {};

// ---------------------------------------------------------------------------
// Scenario 1 & 7: PENDING_ROLE on allow-listed routes → next() without error
// ---------------------------------------------------------------------------

describe("Scenario 1 & 7 — PENDING_ROLE user on allow-listed routes passes through", () => {
  it.each(ONBOARDING_ALLOW_LIST.map((e) => [e.method, e.path] as [string, string]))(
    "%s %s allows PENDING_ROLE",
    (method: string, path: string) => {
      const next = vi.fn();
      const req = buildReq({
        method,
        path,
        user: { id: "u1", role: "PENDING_ROLE", email: "a@b.com" },
      });

      onboardingGate(req as never, resMock as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith(); // no error argument
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: PENDING_ROLE on non-allow-listed route → OnboardingRequiredError
// ---------------------------------------------------------------------------

describe("Scenario 2 — PENDING_ROLE user on non-allow-listed route is blocked", () => {
  it("GET /api/v1/users/me/addresses → OnboardingRequiredError (403)", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "GET",
      path: "/api/v1/users/me/addresses",
      user: { id: "u1", role: "PENDING_ROLE", email: "a@b.com" },
    });

    onboardingGate(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(OnboardingRequiredError);
    expect((err as OnboardingRequiredError).code).toBe("ONBOARDING_REQUIRED");
    expect((err as OnboardingRequiredError).status).toBe(403);
  });

  it("POST /api/v1/addresses → OnboardingRequiredError", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "POST",
      path: "/api/v1/addresses",
      user: { id: "u1", role: "PENDING_ROLE", email: "a@b.com" },
    });

    onboardingGate(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(OnboardingRequiredError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Non-PENDING roles pass through unconditionally
// ---------------------------------------------------------------------------

describe("Scenario 3 — Non-PENDING roles always pass through", () => {
  it.each(["CONSUMER", "PRODUCER", "ADMIN"])("%s role passes any route", (role: string) => {
    const next = vi.fn();
    const req = buildReq({
      method: "GET",
      path: "/api/v1/users/me/addresses",
      user: { id: "u1", role, email: "a@b.com" },
    });

    onboardingGate(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: null user on allow-listed route → passes through
// ---------------------------------------------------------------------------

describe("Scenario 4 — null user (no DB record) on allow-listed route passes through", () => {
  it("POST /api/v1/auth/sync with null user → next() without error", () => {
    const next = vi.fn();
    const req = buildReq({ method: "POST", path: "/api/v1/auth/sync", user: null });

    onboardingGate(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: null user on non-allow-listed route → OnboardingRequiredError
// ---------------------------------------------------------------------------

describe("Scenario 5 — null user on non-allow-listed route is blocked", () => {
  it("DELETE /api/v1/users/me/addresses/123 with null user → OnboardingRequiredError", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "DELETE",
      path: "/api/v1/users/me/addresses/123",
      user: null,
    });

    onboardingGate(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(OnboardingRequiredError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: undefined user (loadUser not run) → UnauthorizedError
// ---------------------------------------------------------------------------

describe("Scenario 6 — undefined user (loadUser not run) → UnauthorizedError", () => {
  it("undefined req.user → UnauthorizedError (401)", () => {
    const next = vi.fn();
    // user is omitted → buildReq sets it to `undefined` via the default spread
    const req = { method: "GET", path: "/api/v1/auth/sync" }; // no user property

    onboardingGate(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).status).toBe(401);
  });
});
