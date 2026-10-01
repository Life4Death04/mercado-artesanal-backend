/**
 * Unit tests — demo-guest-environment WU2: demo policy guard mutation
 * allow-list behavior.
 *
 * Scenarios covered (per demo-guest-environment plan v2, WU2):
 *   1. Demo user on every allow-listed method+path → next() without error.
 *   2. Demo user on a non-allow-listed mutating path → DemoReadOnlyError (403).
 *   3. Demo user on an allow-listed path but wrong method → DemoReadOnlyError.
 *   4. Demo user on an allow-listed prefix with an extra segment → DemoReadOnlyError.
 *   5. Demo user on an allow-listed prefix with an empty param segment → DemoReadOnlyError.
 *   6. Demo user on GET/HEAD (allow-listed or not) → always passes through.
 *   7. Non-demo user (isDemo: false) on a non-allow-listed mutation → always passes through.
 *   8. undefined req.user (loadUser not run) → passes through.
 *   9. null req.user (no DB record) → passes through.
 *
 * No HTTP layer / Express involved — we mock req, res, next as plain objects.
 */
import { describe, expect, it, vi } from "vitest";

import { DEMO_MUTATION_ALLOW_LIST, demoPolicyGuard } from "@/shared/demo-policy";
import { DemoReadOnlyError } from "@/shared/errors/errors";

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

/**
 * Substitutes a concrete value for any ":param" segment in an allow-list
 * pattern so tests exercise a realistic request path.
 */
function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "item-1" : segment))
    .join("/");
}

// ---------------------------------------------------------------------------
// Scenario 1: Demo user on every allow-listed route → next() without error
// ---------------------------------------------------------------------------

describe("Scenario 1 — demo user on allow-listed routes passes through", () => {
  it.each(
    DEMO_MUTATION_ALLOW_LIST.map((e) => [e.method, concretePath(e.path)] as [string, string]),
  )("%s %s allows a demo user", (method: string, path: string) => {
    const next = vi.fn();
    const req = buildReq({
      method,
      path,
      user: { id: "u1", role: "CONSUMER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // no error argument
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Demo user on non-allow-listed mutation → DemoReadOnlyError
// ---------------------------------------------------------------------------

describe("Scenario 2 — demo user on a non-allow-listed mutation is blocked", () => {
  it("DELETE /api/v1/producers/me → DemoReadOnlyError (403)", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "DELETE",
      path: "/api/v1/producers/me",
      user: { id: "u1", role: "PRODUCER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(DemoReadOnlyError);
    expect((err as DemoReadOnlyError).code).toBe("DEMO_READ_ONLY");
    expect((err as DemoReadOnlyError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Demo user on allow-listed path but wrong method → DemoReadOnlyError
// ---------------------------------------------------------------------------

describe("Scenario 3 — demo user on an allow-listed path with the wrong method is blocked", () => {
  it("DELETE /api/v1/auth/sync (only allow-listed for POST) → DemoReadOnlyError", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "DELETE",
      path: "/api/v1/auth/sync",
      user: { id: "u1", role: "CONSUMER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(DemoReadOnlyError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Extra path segment beyond a :param entry → DemoReadOnlyError
// ---------------------------------------------------------------------------

describe("Scenario 4 — mismatched segment count against a :param entry is blocked", () => {
  it("PATCH /api/v1/carrito/items/item-1/extra → DemoReadOnlyError", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "PATCH",
      path: "/api/v1/carrito/items/item-1/extra",
      user: { id: "u1", role: "CONSUMER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(DemoReadOnlyError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Empty :param segment via trailing slash → DemoReadOnlyError
// ---------------------------------------------------------------------------

describe("Scenario 5 — empty :param segment is blocked", () => {
  it("PATCH /api/v1/carrito/items/ (empty itemId segment) → DemoReadOnlyError", () => {
    const next = vi.fn();
    const req = buildReq({
      method: "PATCH",
      path: "/api/v1/carrito/items/",
      user: { id: "u1", role: "CONSUMER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    const [err] = next.mock.calls[0] as [unknown];
    expect(err).toBeInstanceOf(DemoReadOnlyError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Demo user on GET/HEAD always passes through — reads unrestricted
// ---------------------------------------------------------------------------

describe("Scenario 6 — demo user on reads (GET/HEAD) always passes through", () => {
  it.each([
    ["GET", "/api/v1/users/me"],
    ["GET", "/api/v1/producers/me"],
    ["HEAD", "/api/v1/producers/me"],
  ])("%s %s allows a demo user", (method: string, path: string) => {
    const next = vi.fn();
    const req = buildReq({
      method,
      path,
      user: { id: "u1", role: "CONSUMER", email: "demo@b.com", isDemo: true },
    });

    demoPolicyGuard(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Non-demo users always pass through unconditionally
// ---------------------------------------------------------------------------

describe("Scenario 7 — non-demo users always pass through", () => {
  it.each(["CONSUMER", "PRODUCER", "ADMIN"])(
    "%s role (isDemo: false) on a non-allow-listed mutation passes through",
    (role: string) => {
      const next = vi.fn();
      const req = buildReq({
        method: "DELETE",
        path: "/api/v1/producers/me",
        user: { id: "u1", role, email: "a@b.com", isDemo: false },
      });

      demoPolicyGuard(req as never, resMock as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith(); // no error
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 8: undefined req.user (loadUser not run) → passes through
// ---------------------------------------------------------------------------

describe("Scenario 8 — undefined req.user passes through", () => {
  it("undefined req.user on a mutating non-allow-listed path → next() without error", () => {
    const next = vi.fn();
    const req = { method: "DELETE", path: "/api/v1/producers/me" }; // no user property

    demoPolicyGuard(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: null req.user (no DB record) → passes through
// ---------------------------------------------------------------------------

describe("Scenario 9 — null req.user passes through", () => {
  it("null req.user on a mutating non-allow-listed path → next() without error", () => {
    const next = vi.fn();
    const req = buildReq({ method: "DELETE", path: "/api/v1/producers/me", user: null });

    demoPolicyGuard(req as never, resMock as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});
