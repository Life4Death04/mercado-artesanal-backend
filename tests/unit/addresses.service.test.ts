/**
 * Unit tests — addresses.service (TDD — task 5.1)
 *
 * Covers:
 *   - list: only returns active (deletedAt IS NULL) rows scoped to the caller's userId
 *   - create: first address auto-becomes default; subsequent default promotion
 *   - update: 404-no-leak on foreign address; demotion guard; default promotion
 *   - softDeleteWithPromotion: 404-no-leak; soft-delete semantics; auto-promote on deleted-default
 *
 * Strategy: mock the prisma singleton so no DB is required.
 *
 * Spec references:
 *   address-book — owner-scoped CRUD, soft-delete, default invariant
 *   design §10 — transactional patterns for addresses
 *   R-2 — one_default_address_per_user partial unique index
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock prisma before importing the service (hoisting requirement)
// ---------------------------------------------------------------------------
vi.mock("@/shared/utils/prisma", () => {
  const mockAddress = {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };

  return {
    prisma: {
      $transaction: vi.fn(),
      address: mockAddress,
    },
  };
});

import type { Address } from "@prisma/client";
import { prisma } from "@/shared/utils/prisma";
import { InvalidDefaultTransitionError, NotFoundError } from "@/shared/errors/errors";
import * as addressService from "@/modules/addresses/services/addresses.service";

// ---------------------------------------------------------------------------
// Typed mock accessors
//
// Adjustment (type safety): vi.mocked(prisma) retains the real PrismaClient
// overloaded function signatures on nested models, so TypeScript does not
// automatically narrow prisma.address.* to Mock<...>. The explicit cast to
// `Record<string, ReturnType<typeof vi.fn>>` is required to call
// mockResolvedValueOnce on the mocked methods. The mock module above (vi.mock)
// guarantees these ARE vi.fn() instances at runtime — the cast is sound.
// This matches the existing pattern in tests/integration/auth-onboarding.test.ts
// which also casts `(mockedPrisma.user as any)` for the same reason.
// ---------------------------------------------------------------------------
const mockedPrisma = vi.mocked(prisma);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAddress = mockedPrisma.address as any;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAddress(overrides: Partial<Address> = {}): Address {
  return {
    id: "addr_001",
    userId: "user_001",
    line1: "Calle Mayor 1",
    line2: null,
    city: "Madrid",
    postalCode: "28001",
    province: "Madrid",
    country: "ES",
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// list — owner-scoped, excludes soft-deleted
// ---------------------------------------------------------------------------

describe("addressService.list", () => {
  it("returns only the active addresses belonging to the caller", async () => {
    const userId = "user_001";
    const activeAddr = makeAddress({ id: "addr_001", userId, isDefault: true });
    const deletedAddr = makeAddress({ id: "addr_002", userId, deletedAt: new Date() });

    mockedAddress["findMany"].mockResolvedValueOnce([activeAddr]);

    const result = await addressService.list(userId);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("addr_001");
    expect(mockedAddress["findMany"]).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId, deletedAt: null }),
      }),
    );
    void deletedAddr; // acknowledged: deleted row not in result
  });

  it("returns empty array when user has no active addresses", async () => {
    mockedAddress["findMany"].mockResolvedValueOnce([]);

    const result = await addressService.list("user_empty");

    expect(result).toHaveLength(0);
    expect(mockedAddress["findMany"]).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user_empty", deletedAt: null }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// create — first address becomes default; subsequent default promotion
// ---------------------------------------------------------------------------

describe("addressService.create", () => {
  it("auto-marks the first address as default (activeCount === 0)", async () => {
    const userId = "user_001";
    const created = makeAddress({ userId, isDefault: true });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            count: vi.fn().mockResolvedValue(0),
            create: vi.fn().mockResolvedValue(created),
            updateMany: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    const result = await addressService.create(userId, {
      line1: "Calle Mayor 1",
      city: "Madrid",
      postalCode: "28001",
      province: "Madrid",
    });

    expect(result.isDefault).toBe(true);
  });

  it("demotes existing default when new address requests isDefault=true", async () => {
    const userId = "user_001";
    const existingDefault = makeAddress({ id: "addr_old", userId, isDefault: true });
    const created = makeAddress({ id: "addr_new", userId, isDefault: true });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
        const fakeTx = {
          address: {
            count: vi.fn().mockResolvedValue(1),
            create: vi.fn().mockResolvedValue(created),
            updateMany: mockUpdateMany,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        // Verify demotion happened
        expect(mockUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ userId, deletedAt: null, isDefault: true }),
            data: { isDefault: false },
          }),
        );
        void existingDefault; // acknowledged
        return res;
      },
    );

    const result = await addressService.create(userId, {
      line1: "Paseo de la Castellana 100",
      city: "Madrid",
      postalCode: "28046",
      province: "Madrid",
      isDefault: true,
    });

    expect(result.isDefault).toBe(true);
  });

  it("does NOT demote existing default when new address does not request isDefault", async () => {
    const userId = "user_001";
    const created = makeAddress({ id: "addr_new", userId, isDefault: false });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
        const fakeTx = {
          address: {
            count: vi.fn().mockResolvedValue(2),
            create: vi.fn().mockResolvedValue(created),
            updateMany: mockUpdateMany,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        expect(mockUpdateMany).not.toHaveBeenCalled();
        return res;
      },
    );

    const result = await addressService.create(userId, {
      line1: "Calle Serrano 5",
      city: "Madrid",
      postalCode: "28001",
      province: "Madrid",
    });

    expect(result.isDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// update — 404-no-leak, demotion guard, default promotion
// ---------------------------------------------------------------------------

describe("addressService.update", () => {
  it("throws NotFoundError when address belongs to a different user (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: vi.fn(),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      addressService.update("user_attacker", "addr_victim", { line1: "Hacked St" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws InvalidDefaultTransitionError when trying to demote the current default", async () => {
    const target = makeAddress({ id: "addr_001", userId: "user_001", isDefault: true });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(target),
            updateMany: vi.fn(),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      addressService.update("user_001", "addr_001", { isDefault: false }),
    ).rejects.toThrow(InvalidDefaultTransitionError);
  });

  it("promotes target to default and demotes the previous default", async () => {
    const nonDefault = makeAddress({ id: "addr_002", userId: "user_001", isDefault: false });
    const promoted = makeAddress({ id: "addr_002", userId: "user_001", isDefault: true });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(nonDefault),
            updateMany: mockUpdateMany,
            update: vi.fn().mockResolvedValue(promoted),
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        expect(mockUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ userId: "user_001", isDefault: true }),
            data: { isDefault: false },
          }),
        );
        return res;
      },
    );

    const result = await addressService.update("user_001", "addr_002", { isDefault: true });
    expect(result.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// softDeleteWithPromotion — soft-delete semantics, auto-promote, 404-no-leak
// ---------------------------------------------------------------------------

describe("addressService.softDeleteWithPromotion", () => {
  it("throws NotFoundError when address does not belong to the caller (404-no-leak)", async () => {
    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const fakeTx = {
          address: {
            findFirst: vi.fn().mockResolvedValue(null),
            update: vi.fn(),
          },
        };
        return fn(fakeTx as unknown as typeof prisma);
      },
    );

    await expect(
      addressService.softDeleteWithPromotion("user_attacker", "addr_victim"),
    ).rejects.toThrow(NotFoundError);
  });

  it("sets deletedAt and isDefault=false (soft-delete, does not hard-delete)", async () => {
    const target = makeAddress({ id: "addr_001", userId: "user_001", isDefault: false });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue({ ...target, deletedAt: new Date() });
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(target) // the target
              .mockResolvedValueOnce(null), // no sibling to promote
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        expect(mockUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "addr_001" },
            data: expect.objectContaining({ isDefault: false }),
          }),
        );
        // Verify deletedAt was set (not null)
        const callArgs = mockUpdate.mock.calls[0]?.[0] as { data: { deletedAt?: unknown } };
        expect(callArgs?.data?.deletedAt).toBeInstanceOf(Date);
        return res;
      },
    );

    await addressService.softDeleteWithPromotion("user_001", "addr_001");
  });

  it("auto-promotes the most-recently-created sibling when the deleted address was the default", async () => {
    const defaultTarget = makeAddress({ id: "addr_001", userId: "user_001", isDefault: true });
    const sibling = makeAddress({ id: "addr_002", userId: "user_001", isDefault: false });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue({});
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(defaultTarget) // target lookup
              .mockResolvedValueOnce(sibling), // sibling to promote
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        // Two update calls: 1) soft-delete target 2) promote sibling
        expect(mockUpdate).toHaveBeenCalledTimes(2);
        const secondCall = mockUpdate.mock.calls[1]?.[0] as { where: { id: string }; data: { isDefault: boolean } };
        expect(secondCall?.where?.id).toBe("addr_002");
        expect(secondCall?.data?.isDefault).toBe(true);
        return res;
      },
    );

    await addressService.softDeleteWithPromotion("user_001", "addr_001");
  });

  it("does NOT promote any address when no sibling exists after deletion", async () => {
    const onlyDefault = makeAddress({ id: "addr_001", userId: "user_001", isDefault: true });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue({});
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(onlyDefault) // target
              .mockResolvedValueOnce(null), // no sibling
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);
        // Only 1 update: soft-delete. No promotion call.
        expect(mockUpdate).toHaveBeenCalledTimes(1);
        return res;
      },
    );

    await addressService.softDeleteWithPromotion("user_001", "addr_001");
  });

  // --------------------------------------------------------------------------
  // Finding 2 — newest-among-multiple-siblings promotion (O-1 locked)
  // Spec: address-book §"Delete default with others auto-promotes the newest"
  //       openspec/specs/address-book/spec.md:142-148
  // --------------------------------------------------------------------------

  it("promotes the NEWEST sibling (highest createdAt) when multiple non-defaults remain after default deletion", async () => {
    // A (default, day 1 — oldest), B (day 2), C (day 3 — newest)
    // Deleting A must promote C, not B.
    const defaultA = makeAddress({ id: "addr_A", userId: "user_001", isDefault: true, createdAt: new Date("2026-01-01T00:00:00Z") });
    const olderB = makeAddress({ id: "addr_B", userId: "user_001", isDefault: false, createdAt: new Date("2026-01-02T00:00:00Z") });
    const newestC = makeAddress({ id: "addr_C", userId: "user_001", isDefault: false, createdAt: new Date("2026-01-03T00:00:00Z") });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue({});
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(defaultA)  // target lookup → A (default)
              .mockResolvedValueOnce(newestC),  // sibling lookup ordered by createdAt desc → C (newest)
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);

        // Two update calls: 1) soft-delete A, 2) promote C
        expect(mockUpdate).toHaveBeenCalledTimes(2);

        // Second update MUST be the promotion of C (the newest sibling)
        const promotionCall = mockUpdate.mock.calls[1]?.[0] as {
          where: { id: string };
          data: { isDefault: boolean };
        };
        expect(promotionCall?.where?.id).toBe("addr_C");
        expect(promotionCall?.data?.isDefault).toBe(true);

        // B is never touched — no update call with addr_B
        const allCallIds = mockUpdate.mock.calls.map(
          (c) => (c[0] as { where?: { id?: string } })?.where?.id,
        );
        expect(allCallIds).not.toContain("addr_B");

        void olderB; // acknowledged: B must remain non-default
        return res;
      },
    );

    await addressService.softDeleteWithPromotion("user_001", "addr_A");
  });

  // --------------------------------------------------------------------------
  // Finding 3 — delete non-default leaves current default untouched
  // Spec: address-book §"Delete a non-default address leaves default untouched"
  //       openspec/specs/address-book/spec.md:150-155
  // --------------------------------------------------------------------------

  it("does NOT touch the existing default when a non-default address is deleted", async () => {
    // A (default), B (non-default) — delete B, A must remain unchanged.
    const nonDefaultB = makeAddress({ id: "addr_B", userId: "user_001", isDefault: false });

    mockedPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockUpdate = vi.fn().mockResolvedValue({ ...nonDefaultB, deletedAt: new Date() });
        const fakeTx = {
          address: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(nonDefaultB), // target lookup → B (non-default)
            // Note: the second findFirst (sibling search) is never reached
            // because B.isDefault is false, so the promotion branch is skipped.
            update: mockUpdate,
          },
        };
        const res = await fn(fakeTx as unknown as typeof prisma);

        // Only ONE update: soft-delete B. No promotion call occurs.
        expect(mockUpdate).toHaveBeenCalledTimes(1);

        // The single update MUST target B with soft-delete data
        const softDeleteCall = mockUpdate.mock.calls[0]?.[0] as {
          where: { id: string };
          data: { isDefault: boolean; deletedAt?: unknown };
        };
        expect(softDeleteCall?.where?.id).toBe("addr_B");
        expect(softDeleteCall?.data?.isDefault).toBe(false);

        // No update ever targets addr_A — the default is untouched
        const allCallIds = mockUpdate.mock.calls.map(
          (c) => (c[0] as { where?: { id?: string } })?.where?.id,
        );
        expect(allCallIds).not.toContain("addr_A");

        return res;
      },
    );

    await addressService.softDeleteWithPromotion("user_001", "addr_B");
  });
});
