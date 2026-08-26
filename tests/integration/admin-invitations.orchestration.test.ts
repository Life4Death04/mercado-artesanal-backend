import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminInvitationService,
  InvitationInputConflictError,
  runAdminInvitationWorkerOnce,
  type AdminInvitationProvider,
} from "@/modules/admin/services/admin-invitations.service";
import { Auth0AdminError, type AdminIdentity } from "@/shared/auth0/admin-client";

const db = new PrismaClient();
let reachable = false;
let creatorId = "";

class Provider implements AdminInvitationProvider {
  calls: string[] = [];
  identity: AdminIdentity = { userId: "auth0|invited", email: "invited@test.local" };
  createError?: unknown;
  sendErrors: unknown[] = [];
  beforeSend?: () => Promise<void>;
  owned: AdminIdentity | null = null;
  deleteResult = true;
  beforeCreate?: () => Promise<void>;
  async createAdminIdentity(): Promise<AdminIdentity> {
    this.calls.push("create");
    await this.beforeCreate?.();
    if (this.createError) throw this.createError;
    return this.identity;
  }
  async findOwnedIdentity(): Promise<AdminIdentity | null> {
    this.calls.push("find");
    return this.owned;
  }
  async deleteOwnedIdentity(): Promise<boolean> {
    this.calls.push("delete");
    return this.deleteResult;
  }
  async requestPasswordSetupEmail(): Promise<void> {
    this.calls.push("send");
    await this.beforeSend?.();
    const error = this.sendErrors.shift();
    if (error) throw error;
  }
}

function input(requestKey: string, email: string) {
  return { requestKey, createdById: creatorId, email, firstName: null, lastName: null };
}

beforeAll(async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    reachable = true;
    const creator = await db.user.upsert({
      where: { auth0Sub: "auth0|invitation-orchestrator" },
      create: {
        auth0Sub: "auth0|invitation-orchestrator",
        email: "orchestrator@test.local",
        role: "ADMIN",
      },
      update: {},
    });
    creatorId = creator.id;
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await db.adminInvitation.deleteMany({ where: { createdById: creatorId } });
  await db.user.deleteMany({ where: { auth0Sub: { startsWith: "auth0|invited" } } });
});
afterAll(async () => db.$disconnect());

async function provision(service: AdminInvitationService, requestKey: string, email: string) {
  const operation = await service.accept(input(requestKey, email));
  await service.advance(operation.id);
  await service.advance(operation.id);
  return operation;
}

async function makeDue(id: string) {
  await db.adminInvitation.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
}

describe("admin invitation durable saga", () => {
  it("canonicalizes and idempotently persists the complete request", async (ctx) => {
    if (!reachable) return ctx.skip();
    const service = new AdminInvitationService(db, new Provider());
    const input = {
      requestKey: "request-1",
      createdById: creatorId,
      email: " Invited@Test.Local ",
      firstName: " Ada ",
      lastName: null,
    };
    const first = await service.accept(input);
    const replay = await service.accept(input);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({ email: "invited@test.local", firstName: "Ada", lastName: null });
    await expect(service.accept({ ...input, firstName: "Grace" })).rejects.toBeInstanceOf(
      InvitationInputConflictError,
    );
  });

  it("sends only after the local ADMIN checkpoint commits, then completes", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    const operation = await provision(service, "request-2", provider.identity.email);
    provider.beforeSend = async () => {
      expect(
        await db.user.findUnique({ where: { auth0Sub: provider.identity.userId } }),
      ).toMatchObject({ role: "ADMIN" });
      expect(
        await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
      ).toMatchObject({
        status: "PENDING",
        step: "SEND_INVITATION",
        invitedUserId: expect.any(String),
      });
    };
    await service.advance(operation.id);
    expect(
      await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      status: "SUCCEEDED",
      step: "COMPLETE",
      invitedUserId: expect.any(String),
      completedAt: expect.any(Date),
      lastError: null,
      leaseExpiresAt: null,
    });
    expect(provider.calls).toEqual(["create", "send"]);
  });

  it("retries an ambiguous send after 1s and permits a later duplicate send", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    provider.sendErrors.push(new Auth0AdminError("ambiguous", "raw provider response"));
    const service = new AdminInvitationService(db, provider);
    const operation = await provision(service, "request-send-retry", provider.identity.email);
    const before = Date.now();
    const retry = await service.advance(operation.id);
    expect(retry).toMatchObject({
      status: "PENDING",
      attemptCount: 1,
      lastError: "DELIVERY_AMBIGUOUS",
    });
    expect(retry.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 900);
    await makeDue(operation.id);
    const completed = await service.advance(operation.id);
    expect(completed).toMatchObject({
      status: "SUCCEEDED",
      step: "COMPLETE",
      attemptCount: 1,
      lastError: null,
    });
    expect(provider.calls).toEqual(["create", "send", "send"]);
  });

  it("fails after four ambiguous sends without removing local authorization", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    provider.sendErrors = Array.from(
      { length: 4 },
      () => new Auth0AdminError("ambiguous", "https://provider.invalid secret body"),
    );
    const service = new AdminInvitationService(db, provider);
    const operation = await provision(service, "request-send-exhausted", provider.identity.email);
    const backoff = [1_000, 5_000, 30_000];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await makeDue(operation.id);
      const before = Date.now();
      const result = await service.advance(operation.id);
      if (attempt < backoff.length)
        expect(result.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
          before + backoff[attempt]! - 100,
        );
    }
    const failed = await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(failed).toMatchObject({
      status: "FAILED",
      attemptCount: 4,
      lastError: "DELIVERY_AMBIGUOUS",
      completedAt: expect.any(Date),
      leaseExpiresAt: null,
    });
    expect(failed.lastError).not.toMatch(/provider|secret|body|https/i);
    expect(
      await db.user.findUnique({ where: { auth0Sub: provider.identity.userId } }),
    ).toMatchObject({
      role: "ADMIN",
    });
  });

  for (const kind of ["rejected", "conflict"] as const) {
    it(`makes a deterministic ${kind} terminal, safe, and inert while preserving ADMIN`, async (ctx) => {
      if (!reachable) return ctx.skip();
      const provider = new Provider();
      provider.sendErrors.push(new Auth0AdminError(kind, "credential token response URL"));
      const service = new AdminInvitationService(db, provider);
      const operation = await provision(service, `request-send-${kind}`, provider.identity.email);
      await db.adminInvitation.update({
        where: { id: operation.id },
        data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      const failed = await service.advance(operation.id);
      expect(failed).toMatchObject({
        status: "FAILED",
        attemptCount: 0,
        lastError: kind === "conflict" ? "DELIVERY_CONFLICT" : "DELIVERY_REJECTED",
        completedAt: expect.any(Date),
        leaseExpiresAt: null,
      });
      const calls = [...provider.calls];
      await service.advance(operation.id);
      expect(provider.calls).toEqual(calls);
      expect(failed.lastError).not.toMatch(/credential|token|response|URL/i);
      expect(
        await db.user.findUnique({ where: { auth0Sub: provider.identity.userId } }),
      ).toMatchObject({
        role: "ADMIN",
      });
    });
  }

  it("rejects an incomplete delivery checkpoint without a provider effect", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    const operation = await service.accept(
      input("request-send-incomplete", provider.identity.email),
    );
    await db.adminInvitation.update({
      where: { id: operation.id },
      data: { step: "SEND_INVITATION" },
    });
    const failed = await service.advance(operation.id);
    expect(failed).toMatchObject({ status: "FAILED", lastError: "DELIVERY_CHECKPOINT_MISSING" });
    expect(provider.calls).toEqual([]);
  });

  it("reconciles an ambiguous create only to the operation-owned identity", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    provider.createError = new Auth0AdminError("ambiguous", "create user");
    provider.owned = provider.identity;
    const service = new AdminInvitationService(db, provider);
    const operation = await service.accept(input("request-3", provider.identity.email));
    await service.advance(operation.id);
    expect(
      await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      step: "CREATE_LOCAL_USER",
      auth0Sub: provider.identity.userId,
      attemptCount: 0,
    });
    expect(provider.calls).toEqual(["create", "find"]);
  });

  it("compensates a local conflict, but fails when identity ownership is refused", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    await db.user.create({
      data: { auth0Sub: "auth0|invited-existing", email: provider.identity.email },
    });
    const operation = await service.accept(input("request-4", provider.identity.email));
    await service.advance(operation.id);
    await service.advance(operation.id);
    expect(
      (await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } })).status,
    ).toBe("COMPENSATING");
    provider.deleteResult = false;
    await service.advance(operation.id);
    expect(
      await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({ status: "FAILED", lastError: "COMPENSATION_REFUSED" });

    provider.identity = { userId: "auth0|invited-compensated", email: provider.identity.email };
    provider.deleteResult = true;
    const owned = await service.accept(input("request-4-owned", provider.identity.email));
    await service.advance(owned.id);
    await service.advance(owned.id);
    await service.advance(owned.id);
    expect((await db.adminInvitation.findUniqueOrThrow({ where: { id: owned.id } })).status).toBe(
      "COMPENSATED",
    );
  });

  it("atomically gives concurrent workers one due operation", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const operation = await new AdminInvitationService(db, provider).accept(
      input("worker-concurrent", provider.identity.email),
    );
    const now = new Date("2026-01-01T00:00:00Z");
    await db.adminInvitation.update({ where: { id: operation.id }, data: { nextAttemptAt: now } });
    const work = () => runAdminInvitationWorkerOnce(db, provider, () => now);
    await Promise.all([work(), work()]);
    expect(provider.calls).toEqual(["create"]);
  });

  it("does not steal a live lease and returns false without due work", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const operation = await new AdminInvitationService(db, provider).accept(
      input("worker-live-lease", provider.identity.email),
    );
    const now = new Date("2026-01-01T00:00:00Z");
    await db.adminInvitation.update({
      where: { id: operation.id },
      data: {
        status: "PROCESSING",
        nextAttemptAt: now,
        leaseExpiresAt: new Date(now.getTime() + 1),
      },
    });
    expect(await runAdminInvitationWorkerOnce(db, provider, () => now)).toBe(false);
    expect(provider.calls).toEqual([]);
  });

  it("resumes the persisted step of an expired PROCESSING lease", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    const operation = await provision(service, "worker-expired", provider.identity.email);
    provider.calls = [];
    const now = new Date("2026-01-01T00:00:00Z");
    await db.adminInvitation.update({
      where: { id: operation.id },
      data: {
        status: "PROCESSING",
        nextAttemptAt: new Date(now.getTime() + 60_000),
        leaseExpiresAt: new Date(now.getTime() - 1),
      },
    });
    expect(await runAdminInvitationWorkerOnce(db, provider, () => now)).toBe(true);
    expect(provider.calls).toEqual(["send"]);
    expect(
      await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      status: "SUCCEEDED",
      step: "COMPLETE",
      attemptCount: 1,
    });
  });

  it("resumes due PENDING and expired COMPENSATING work", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    const pending = await service.accept(input("worker-pending", provider.identity.email));
    const compensation = await service.accept(input("worker-compensating", "other@test.local"));
    const now = new Date("2026-01-01T00:00:00Z");
    await db.adminInvitation.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(now.getTime() - 2) },
    });
    await db.adminInvitation.update({
      where: { id: compensation.id },
      data: {
        status: "COMPENSATING",
        auth0Sub: "auth0|worker-compensating",
        nextAttemptAt: new Date(now.getTime() + 60_000),
        leaseExpiresAt: new Date(now.getTime() - 1),
      },
    });
    expect(await runAdminInvitationWorkerOnce(db, provider, () => now)).toBe(true);
    await db.adminInvitation.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(now.getTime() + 1) },
    });
    expect(await runAdminInvitationWorkerOnce(db, provider, () => now)).toBe(true);
    expect(provider.calls).toEqual(["create", "delete"]);
    expect(
      (await db.adminInvitation.findUniqueOrThrow({ where: { id: compensation.id } })).status,
    ).toBe("COMPENSATED");
  });

  it("fences a stale provider result after a later claim", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const operation = await new AdminInvitationService(db, provider).accept(
      input("worker-fencing", provider.identity.email),
    );
    const firstNow = new Date("2026-01-01T00:00:00Z");
    await db.adminInvitation.update({
      where: { id: operation.id },
      data: { nextAttemptAt: firstNow },
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    provider.beforeCreate = async () => {
      if (provider.calls.length === 1) {
        started();
        await releasePromise;
      }
    };
    const stale = runAdminInvitationWorkerOnce(db, provider, () => firstNow, 1_000);
    await startedPromise;
    await runAdminInvitationWorkerOnce(
      db,
      provider,
      () => new Date(firstNow.getTime() + 1_001),
      1_000,
    );
    const afterNewClaim = await db.adminInvitation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    release();
    await stale;
    expect(await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } })).toEqual(
      afterNewClaim,
    );
    expect(afterNewClaim).toMatchObject({ step: "CREATE_LOCAL_USER", attemptCount: 0 });
  });
});
