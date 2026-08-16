/**
 * Unit tests — account-lifecycle shared helpers (admin-user-management WU1).
 *
 * Pure functions — zero Prisma mocks needed.
 *
 * Spec: account-lifecycle §"Derived lifecycle state"
 * Design: Architecture Decisions, "Boolean vs timestamps"
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVE_USER_WHERE,
  deriveAccountState,
  isAccountActive,
} from "@/shared/account-lifecycle";

describe("deriveAccountState", () => {
  it("returns ACTIVE when neither timestamp is set", () => {
    expect(deriveAccountState({ deletedAt: null, deactivatedAt: null })).toBe("ACTIVE");
  });

  it("returns DEACTIVATED when only deactivatedAt is set", () => {
    expect(
      deriveAccountState({ deletedAt: null, deactivatedAt: new Date("2026-01-01") }),
    ).toBe("DEACTIVATED");
  });

  it("returns DELETED when only deletedAt is set", () => {
    expect(
      deriveAccountState({ deletedAt: new Date("2026-01-01"), deactivatedAt: null }),
    ).toBe("DELETED");
  });

  it("[deleted precedence] returns DELETED when BOTH timestamps are set — deleted always wins", () => {
    expect(
      deriveAccountState({
        deletedAt: new Date("2026-01-02"),
        deactivatedAt: new Date("2026-01-01"),
      }),
    ).toBe("DELETED");
  });
});

describe("isAccountActive", () => {
  it("is true only for ACTIVE", () => {
    expect(isAccountActive({ deletedAt: null, deactivatedAt: null })).toBe(true);
  });

  it("is false for DEACTIVATED", () => {
    expect(isAccountActive({ deletedAt: null, deactivatedAt: new Date() })).toBe(false);
  });

  it("is false for DELETED", () => {
    expect(isAccountActive({ deletedAt: new Date(), deactivatedAt: null })).toBe(false);
  });

  it("[deleted precedence] is false when both timestamps are set", () => {
    expect(isAccountActive({ deletedAt: new Date(), deactivatedAt: new Date() })).toBe(false);
  });
});

describe("ACTIVE_USER_WHERE", () => {
  it("is the frozen { deletedAt: null, deactivatedAt: null } predicate", () => {
    expect(ACTIVE_USER_WHERE).toEqual({ deletedAt: null, deactivatedAt: null });
  });
});
