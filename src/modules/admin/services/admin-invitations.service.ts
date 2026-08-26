import type { AdminInvitation, PrismaClient } from "@prisma/client";

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

export class AdminInvitationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly provider: AdminInvitationProvider,
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

  async advance(id: string): Promise<AdminInvitation> {
    const operation = await this.db.adminInvitation.findUniqueOrThrow({ where: { id } });
    if (
      ["SUCCEEDED", "FAILED", "COMPENSATED"].includes(operation.status) ||
      operation.nextAttemptAt > new Date()
    )
      return operation;
    if (operation.status === "COMPENSATING") return this.compensate(operation);
    if (operation.step === "CREATE_IDENTITY") return this.createIdentity(operation);
    if (operation.step === "CREATE_LOCAL_USER") return this.createLocalUser(operation);
    if (operation.step === "SEND_INVITATION") return this.sendInvitation(operation);
    return operation;
  }

  private async createIdentity(operation: AdminInvitation): Promise<AdminInvitation> {
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
        return this.finish(operation, "FAILED", "IDENTITY_REJECTED");
      try {
        identity = await this.provider.findOwnedIdentity(operation.email, operation.id);
      } catch {
        return this.retry(operation, "IDENTITY_AMBIGUOUS");
      }
      if (!identity)
        return error.kind === "ambiguous"
          ? this.retry(operation, "IDENTITY_AMBIGUOUS")
          : this.finish(operation, "FAILED", "IDENTITY_CONFLICT");
    }
    if (identity.email !== operation.email) {
      return this.db.adminInvitation.update({
        where: { id: operation.id },
        data: {
          auth0Sub: identity.userId,
          status: "COMPENSATING",
          lastError: "IDENTITY_EMAIL_MISMATCH",
        },
      });
    }
    return this.db.adminInvitation.update({
      where: { id: operation.id },
      data: {
        auth0Sub: identity.userId,
        step: "CREATE_LOCAL_USER",
        attemptCount: 0,
        lastError: null,
      },
    });
  }

  private async createLocalUser(operation: AdminInvitation): Promise<AdminInvitation> {
    if (!operation.auth0Sub) return this.finish(operation, "FAILED", "IDENTITY_MISSING");
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
        return tx.adminInvitation.update({
          where: { id: operation.id },
          data: {
            invitedUserId: user.id,
            status: "PENDING",
            step: "SEND_INVITATION",
            attemptCount: 0,
            lastError: null,
          },
        });
      });
    } catch (error) {
      if (!isUniqueConflict(error)) return this.retry(operation, "LOCAL_PERSISTENCE");
      return this.db.adminInvitation.update({
        where: { id: operation.id },
        data: { status: "COMPENSATING", lastError: "LOCAL_PERSISTENCE" },
      });
    }
  }

  private async sendInvitation(operation: AdminInvitation): Promise<AdminInvitation> {
    if (!operation.auth0Sub || !operation.invitedUserId)
      return this.finish(operation, "FAILED", "DELIVERY_CHECKPOINT_MISSING");
    const admin = await this.db.user.findUnique({ where: { id: operation.invitedUserId } });
    if (
      !admin ||
      admin.auth0Sub !== operation.auth0Sub ||
      admin.email !== operation.email ||
      admin.role !== "ADMIN"
    )
      return this.finish(operation, "FAILED", "DELIVERY_CHECKPOINT_MISSING");
    try {
      await this.provider.requestPasswordSetupEmail(operation.email);
      return this.finish(operation, "SUCCEEDED", null);
    } catch (error) {
      if (error instanceof Auth0AdminError && error.kind === "ambiguous")
        return this.retry(operation, "DELIVERY_AMBIGUOUS");
      return this.finish(
        operation,
        "FAILED",
        error instanceof Auth0AdminError && error.kind === "conflict"
          ? "DELIVERY_CONFLICT"
          : "DELIVERY_REJECTED",
      );
    }
  }

  private async compensate(operation: AdminInvitation): Promise<AdminInvitation> {
    if (!operation.auth0Sub) return this.finish(operation, "FAILED", "IDENTITY_MISSING");
    try {
      const deleted = await this.provider.deleteOwnedIdentity(operation.auth0Sub, operation.id);
      return this.finish(
        operation,
        deleted ? "COMPENSATED" : "FAILED",
        deleted ? null : "COMPENSATION_REFUSED",
      );
    } catch (error) {
      return error instanceof Auth0AdminError && error.kind === "ambiguous"
        ? this.retry(operation, "COMPENSATION_AMBIGUOUS", "COMPENSATING")
        : this.finish(operation, "FAILED", "COMPENSATION_REJECTED");
    }
  }

  private retry(
    operation: AdminInvitation,
    code: string,
    status: "PENDING" | "COMPENSATING" = "PENDING",
  ) {
    const attemptCount = operation.attemptCount + 1;
    if (attemptCount >= MAX_ATTEMPTS) return this.finish(operation, "FAILED", code, attemptCount);
    return this.db.adminInvitation.update({
      where: { id: operation.id },
      data: {
        status,
        attemptCount,
        lastError: code,
        nextAttemptAt: new Date(Date.now() + BACKOFF_MS[attemptCount - 1]!),
      },
    });
  }

  private finish(
    operation: AdminInvitation,
    status: "SUCCEEDED" | "FAILED" | "COMPENSATED",
    lastError: string | null,
    attemptCount = operation.attemptCount,
  ) {
    const completedAt = new Date();
    return this.db.adminInvitation.update({
      where: { id: operation.id },
      data: {
        status,
        step: status === "SUCCEEDED" ? "COMPLETE" : operation.step,
        lastError,
        attemptCount,
        completedAt,
        nextAttemptAt: completedAt,
        leaseExpiresAt: null,
      },
    });
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
