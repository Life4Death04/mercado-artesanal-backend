import { Prisma, type AdminInvitation, type PrismaClient } from "@prisma/client";

import { Auth0AdminError, type Auth0AdminClient } from "@/shared/auth0/admin-client";
import { normalizeEmail } from "@/shared/utils/normalize-email";

export type AdminInvitationProvider = Pick<
  Auth0AdminClient,
  "createAdminIdentity" | "findOwnedIdentity" | "deleteOwnedIdentity" | "requestPasswordSetupEmail"
>;
export interface AcceptAdminInvitationInput {
  requestKey: string;
  createdById: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}
export class InvitationInputConflictError extends Error {
  readonly code = "INVITATION_REQUEST_CONFLICT";
}

const BACKOFF_MS = [1_000, 5_000, 30_000] as const;
const MAX_ATTEMPTS = 4;
const DEFAULT_LEASE_MS = 30_000;

export async function runAdminInvitationWorkerOnce(
  db: PrismaClient,
  provider: AdminInvitationProvider,
  clock: () => Date = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const now = clock();
  const lease = new Date(now.getTime() + leaseMs);
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id FROM admin_invitations
        WHERE (status = 'PROCESSING'
               OR (status = 'PENDING' AND next_attempt_at <= ${now})
               OR (status = 'COMPENSATING'
                   AND (next_attempt_at <= ${now} OR lease_expires_at <= ${now})))
          AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
        ORDER BY next_attempt_at, created_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE admin_invitations AS operation
      SET status = CASE WHEN operation.status = 'COMPENSATING'
                        THEN operation.status ELSE 'PROCESSING' END,
          attempt_count = operation.attempt_count + 1,
          lease_expires_at = ${lease}, updated_at = ${now}
      FROM candidate WHERE operation.id = candidate.id
      RETURNING operation.id
    `;
    return rows[0] ? tx.adminInvitation.findUniqueOrThrow({ where: { id: rows[0].id } }) : null;
  });
  if (!claimed) return false;
  await new AdminInvitationService(db, provider, clock).advance(
    claimed.id,
    claimed.leaseExpiresAt!,
  );
  return true;
}

class LeaseLostError extends Error {}

export class AdminInvitationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly provider: AdminInvitationProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async accept(input: AcceptAdminInvitationInput): Promise<AdminInvitation> {
    const payload = {
      requestKey: input.requestKey,
      createdById: input.createdById,
      email: normalizeEmail(input.email.trim()),
      firstName: cleanName(input.firstName),
      lastName: cleanName(input.lastName),
    };
    try {
      return await this.db.adminInvitation.create({ data: payload });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.db.adminInvitation.findUnique({
        where: { requestKey: payload.requestKey },
      });
      if (
        existing?.createdById === payload.createdById &&
        existing.email === payload.email &&
        existing.firstName === payload.firstName &&
        existing.lastName === payload.lastName
      )
        return existing;
      throw new InvitationInputConflictError();
    }
  }

  async advance(id: string, fence?: Date): Promise<AdminInvitation> {
    const operation = await this.db.adminInvitation.findUniqueOrThrow({ where: { id } });
    if (
      ["SUCCEEDED", "FAILED", "COMPENSATED"].includes(operation.status) ||
      (!fence && operation.nextAttemptAt > this.clock())
    )
      return operation;
    if (operation.status === "COMPENSATING") return this.compensate(operation, fence);
    if (operation.step === "CREATE_IDENTITY") return this.createIdentity(operation, fence);
    if (operation.step === "CREATE_LOCAL_USER") return this.createLocalUser(operation, fence);
    if (operation.step === "SEND_INVITATION") return this.sendInvitation(operation, fence);
    return operation;
  }

  private async createIdentity(operation: AdminInvitation, fence?: Date): Promise<AdminInvitation> {
    let identity;
    try {
      identity = await this.provider.createAdminIdentity({
        email: operation.email,
        operationId: operation.id,
        givenName: operation.firstName ?? undefined,
        familyName: operation.lastName ?? undefined,
      });
    } catch (error) {
      if (!(error instanceof Auth0AdminError) || !["ambiguous", "conflict"].includes(error.kind))
        return this.finish(operation, "FAILED", "IDENTITY_REJECTED", undefined, fence);
      try {
        identity = await this.provider.findOwnedIdentity(operation.email, operation.id);
      } catch {
        return this.retry(operation, "IDENTITY_AMBIGUOUS", "PENDING", fence);
      }
      if (!identity)
        return error.kind === "ambiguous"
          ? this.retry(operation, "IDENTITY_AMBIGUOUS", "PENDING", fence)
          : this.finish(operation, "FAILED", "IDENTITY_CONFLICT", undefined, fence);
    }
    if (identity.email !== operation.email) {
      return this.checkpoint(operation, fence, {
        auth0Sub: identity.userId,
        status: "COMPENSATING",
        lastError: "IDENTITY_EMAIL_MISMATCH",
      });
    }
    return this.checkpoint(operation, fence, {
      auth0Sub: identity.userId,
      status: "PENDING",
      step: "CREATE_LOCAL_USER",
      attemptCount: 0,
      lastError: null,
      leaseExpiresAt: null,
    });
  }

  private async createLocalUser(
    operation: AdminInvitation,
    fence?: Date,
  ): Promise<AdminInvitation> {
    if (!operation.auth0Sub)
      return this.finish(operation, "FAILED", "IDENTITY_MISSING", undefined, fence);
    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            auth0Sub: operation.auth0Sub!,
            email: operation.email,
            firstName: operation.firstName,
            lastName: operation.lastName,
            role: "ADMIN",
          },
        });
        const data = {
          invitedUserId: user.id,
          status: "PENDING",
          step: "SEND_INVITATION",
          attemptCount: 0,
          lastError: null,
          leaseExpiresAt: null,
        } as const;
        if (!fence) return tx.adminInvitation.update({ where: { id: operation.id }, data });
        const updated = await tx.adminInvitation.updateMany({
          where: this.fenceWhere(operation, fence),
          data,
        });
        if (!updated.count) throw new LeaseLostError();
        return tx.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } });
      });
    } catch (error) {
      if (error instanceof LeaseLostError)
        return this.db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } });
      if (!isUniqueConflict(error))
        return this.retry(operation, "LOCAL_PERSISTENCE", "PENDING", fence);
      return this.checkpoint(operation, fence, {
        status: "COMPENSATING",
        lastError: "LOCAL_PERSISTENCE",
      });
    }
  }

  private async sendInvitation(operation: AdminInvitation, fence?: Date): Promise<AdminInvitation> {
    if (!operation.auth0Sub || !operation.invitedUserId)
      return this.finish(operation, "FAILED", "DELIVERY_CHECKPOINT_MISSING", undefined, fence);
    const admin = await this.db.user.findUnique({ where: { id: operation.invitedUserId } });
    if (
      !admin ||
      admin.auth0Sub !== operation.auth0Sub ||
      admin.email !== operation.email ||
      admin.role !== "ADMIN"
    )
      return this.finish(operation, "FAILED", "DELIVERY_CHECKPOINT_MISSING", undefined, fence);
    try {
      await this.provider.requestPasswordSetupEmail(operation.email);
      return this.finish(operation, "SUCCEEDED", null, undefined, fence);
    } catch (error) {
      if (error instanceof Auth0AdminError && error.kind === "ambiguous")
        return this.retry(operation, "DELIVERY_AMBIGUOUS", "PENDING", fence);
      return this.finish(
        operation,
        "FAILED",
        error instanceof Auth0AdminError && error.kind === "conflict"
          ? "DELIVERY_CONFLICT"
          : "DELIVERY_REJECTED",
        undefined,
        fence,
      );
    }
  }

  private async compensate(operation: AdminInvitation, fence?: Date): Promise<AdminInvitation> {
    if (!operation.auth0Sub)
      return this.finish(operation, "FAILED", "IDENTITY_MISSING", undefined, fence);
    try {
      const deleted = await this.provider.deleteOwnedIdentity(operation.auth0Sub, operation.id);
      return this.finish(
        operation,
        deleted ? "COMPENSATED" : "FAILED",
        deleted ? null : "COMPENSATION_REFUSED",
        undefined,
        fence,
      );
    } catch (error) {
      return error instanceof Auth0AdminError && error.kind === "ambiguous"
        ? this.retry(operation, "COMPENSATION_AMBIGUOUS", "COMPENSATING", fence)
        : this.finish(operation, "FAILED", "COMPENSATION_REJECTED", undefined, fence);
    }
  }

  private retry(
    operation: AdminInvitation,
    code: string,
    status: "PENDING" | "COMPENSATING" = "PENDING",
    fence?: Date,
  ) {
    const attemptCount = fence ? operation.attemptCount : operation.attemptCount + 1;
    if (attemptCount >= MAX_ATTEMPTS)
      return this.finish(operation, "FAILED", code, attemptCount, fence);
    return this.checkpoint(operation, fence, {
      status,
      attemptCount,
      lastError: code,
      nextAttemptAt: new Date(this.clock().getTime() + BACKOFF_MS[attemptCount - 1]!),
      leaseExpiresAt: null,
    });
  }

  private finish(
    operation: AdminInvitation,
    status: "SUCCEEDED" | "FAILED" | "COMPENSATED",
    lastError: string | null,
    attemptCount = operation.attemptCount,
    fence?: Date,
  ) {
    const completedAt = this.clock();
    return this.checkpoint(operation, fence, {
      status,
      step: status === "SUCCEEDED" ? "COMPLETE" : operation.step,
      lastError,
      attemptCount,
      completedAt,
      nextAttemptAt: completedAt,
      leaseExpiresAt: null,
    });
  }

  private async checkpoint(
    operation: AdminInvitation,
    fence: Date | undefined,
    data: Prisma.AdminInvitationUncheckedUpdateManyInput,
  ): Promise<AdminInvitation> {
    if (!fence) return this.db.adminInvitation.update({ where: { id: operation.id }, data });
    await this.db.adminInvitation.updateMany({
      where: this.fenceWhere(operation, fence),
      data,
    });
    return this.db.adminInvitation.findUniqueOrThrow({ where: { id: operation.id } });
  }

  private fenceWhere(operation: AdminInvitation, leaseExpiresAt: Date) {
    return {
      id: operation.id,
      status: operation.status,
      step: operation.step,
      leaseExpiresAt,
    } as const;
  }
}

function cleanName(value: string | null): string | null {
  return value === null ? null : value.trim();
}
function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002"
  );
}
