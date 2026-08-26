import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminInvitationService,
  InvitationInputConflictError,
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
  owned: AdminIdentity | null = null;
  deleteResult = true;
  async createAdminIdentity(): Promise<AdminIdentity> {
    this.calls.push("create");
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

describe("admin invitation durable saga 3a", () => {
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

  it("checkpoints after local ADMIN authorization without requesting the email", async (ctx) => {
    if (!reachable) return ctx.skip();
    const provider = new Provider();
    const service = new AdminInvitationService(db, provider);
    const operation = await service.accept(input("request-2", provider.identity.email));
    await service.advance(operation.id);
    await service.advance(operation.id);
    expect(
      await db.user.findUnique({ where: { auth0Sub: provider.identity.userId } }),
    ).toMatchObject({ role: "ADMIN" });
    await service.advance(operation.id);
    expect(
      await db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).toMatchObject({
      status: "PENDING",
      step: "SEND_INVITATION",
      invitedUserId: expect.any(String),
    });
    expect(provider.calls).toEqual(["create"]);
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
});
