/**
 * Unit tests — create-admin CLI guardrails (PR#5, task 5.2)
 *
 * Strategy: import `runCreateAdmin` (the injectable core function) and
 * provide a stub `CreateAdminDeps` so no real DB, process.exit, or
 * filesystem access is needed.
 *
 * Scenarios covered (spec: admin-bootstrap §"create-admin CLI script"):
 *   [CA1] Missing --email exits 1 with stderr identifying --email as required
 *         (openspec/specs/admin-bootstrap/spec.md:30-35)
 *   [CA2] Second bootstrap refused: exits 2 when active admin already exists,
 *         no new user is created, stderr references docs/admin-recovery.md
 *         (openspec/specs/admin-bootstrap/spec.md:44-50)
 *
 * Note on deps.exit: in the real CLI, `exit` is `process.exit` which throws
 * a "process.exit called" TypeError in Node (never returns). In tests we stub
 * it as a vi.fn() that throws a sentinel so execution stops at the call site,
 * matching the `never` return type contract without actually killing the process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateAdminDeps } from "../../scripts/create-admin";
import { runCreateAdmin } from "../../scripts/create-admin";

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

/**
 * Build a stub deps object.
 * `exit` throws a sentinel error to stop execution, matching `process.exit` semantics.
 */
function makeStubDeps(overrides: Partial<CreateAdminDeps> = {}): CreateAdminDeps {
  const exitFn = vi.fn((code: number): never => {
    throw new Error(`process.exit(${String(code)})`);
  });

  return {
    countAdmins: vi.fn().mockResolvedValue(0),
    createUser: vi.fn().mockResolvedValue({ id: "admin_test_id" }),
    stderr: vi.fn(),
    stdout: vi.fn(),
    exit: exitFn as unknown as (code: number) => never,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// [CA1] Missing --email exits 1 with stderr identifying --email as required
// Spec: admin-bootstrap §"Missing --email exits non-zero" (spec.md:30-35)
// ---------------------------------------------------------------------------

describe("create-admin CLI — [CA1] missing --email exits 1", () => {
  it("exits 1 when --email is not provided, stderr identifies --email as required", async () => {
    const deps = makeStubDeps();

    // Provide --auth0-sub but omit --email (the only required flag missing)
    await expect(
      runCreateAdmin(["--auth0-sub", "auth0|abc"], deps),
    ).rejects.toThrow("process.exit(1)");

    expect(deps.exit).toHaveBeenCalledWith(1);

    // stderr MUST contain a message identifying --email as required
    const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderrCalls).toContain("--email");

    // countAdmins and createUser MUST NOT be called (Zod guard runs before DB)
    expect(deps.countAdmins).not.toHaveBeenCalled();
    expect(deps.createUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [CA2] Second bootstrap refused — exits 2 when active admin exists
// Spec: admin-bootstrap §"Second bootstrap refused" (spec.md:44-50)
// ---------------------------------------------------------------------------

describe("create-admin CLI — [CA2] second bootstrap refused exits 2", () => {
  it("exits 2 when an active admin already exists and does NOT create a new user", async () => {
    const deps = makeStubDeps({
      countAdmins: vi.fn().mockResolvedValue(1), // active admin exists
    });

    await expect(
      runCreateAdmin(
        ["--email", "new@example.com", "--auth0-sub", "auth0|new"],
        deps,
      ),
    ).rejects.toThrow("process.exit(2)");

    expect(deps.exit).toHaveBeenCalledWith(2);

    // stderr MUST reference docs/admin-recovery.md
    const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderrCalls).toContain("docs/admin-recovery.md");

    // No new user MUST be created
    expect(deps.createUser).not.toHaveBeenCalled();
  });
});
