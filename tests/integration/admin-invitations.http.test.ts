import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvitationInputConflictError } from "@/modules/admin/services/admin-invitations.service";
import { AdminInvitationOperationNotFoundError } from "@/shared/errors/errors";

vi.mock("express-oauth2-jwt-bearer", () => ({
  auth:
    () =>
    (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const sub = req.headers["x-test-auth"];
      if (typeof sub !== "string") return next({ status: 401, name: "UnauthorizedError" });
      req.auth = { payload: { sub } as never, header: {}, token: "test-token" };
      next();
    },
}));

const mocks = vi.hoisted(() => ({
  acceptOperation: vi.fn(),
  findUser: vi.fn(),
  getOperation: vi.fn(),
}));
vi.mock("@/shared/utils/prisma", () => ({ prisma: { user: { findUnique: mocks.findUser } } }));
vi.mock("@/modules/admin/services/admin-invitation-recovery.service", () => ({
  adminInvitationService: {
    acceptOperation: mocks.acceptOperation,
    getOperation: mocks.getOperation,
  },
}));

import { adminRouter } from "@/modules/admin/routes/admin.routes";
import { errorMiddleware } from "@/shared/middleware/errorMiddleware";

const operation = {
  id: "invitation-1",
  email: "invited@example.test",
  firstName: "Ada",
  lastName: null,
  status: "PENDING" as const,
  createdAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:00:00.000Z",
  completedAt: null,
  links: { self: "/api/v1/admin/admin-invitation-operations/invitation-1" },
};
const body = {
  requestKey: "request-1",
  email: "invited@example.test",
  firstName: "Ada",
  lastName: null,
};
const forbidden =
  /requestKey|createdById|invitedUserId|auth0Sub|attemptCount|nextAttemptAt|leaseExpiresAt|lastError|step|diagnostic|credential|password|token/i;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = "admin-invitation-http-test";
  next();
});
app.use("/api/v1", adminRouter);
app.use(errorMiddleware);
const request = supertest(app);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUser.mockResolvedValue({
    id: "admin-1",
    role: "ADMIN",
    email: "admin@example.test",
    deletedAt: null,
    deactivatedAt: null,
    producer: null,
  });
  mocks.acceptOperation.mockResolvedValue(operation);
  mocks.getOperation.mockResolvedValue(operation);
});

describe("ADMIN invitation HTTP surface", () => {
  it("returns 401 without authentication", async () => {
    const response = await request.post("/api/v1/admin/admins").send(body);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for an authenticated non-ADMIN", async () => {
    mocks.findUser.mockResolvedValueOnce({
      id: "consumer-1",
      role: "CONSUMER",
      email: "consumer@example.test",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });
    const response = await request
      .post("/api/v1/admin/admins")
      .set("x-test-auth", "consumer-sub")
      .send(body);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("accepts creation with polling headers, the authenticated actor, and an exact safe body", async () => {
    const response = await request
      .post("/api/v1/admin/admins")
      .set("x-test-auth", "admin-sub")
      .send({ ...body, email: " invited@example.test ", firstName: " Ada " });
    expect(response.status).toBe(202);
    expect(response.headers.location).toBe(operation.links.self);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body).toEqual(operation);
    expect(JSON.stringify(response.body)).not.toMatch(forbidden);
    expect(mocks.acceptOperation).toHaveBeenCalledWith({ ...body, createdById: "admin-1" });
  });

  it("rejects unknown and secret-bearing fields before service invocation", async () => {
    for (const extra of [{ role: "ADMIN" }, { password: "not-accepted" }]) {
      const response = await request
        .post("/api/v1/admin/admins")
        .set("x-test-auth", "admin-sub")
        .send({ ...body, ...extra });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("VALIDATION_FAILED");
    }
    expect(mocks.acceptOperation).not.toHaveBeenCalled();
  });

  it("returns the same operation contract for an idempotent replay", async () => {
    const first = await request
      .post("/api/v1/admin/admins")
      .set("x-test-auth", "admin-sub")
      .send(body);
    const replay = await request
      .post("/api/v1/admin/admins")
      .set("x-test-auth", "admin-sub")
      .send(body);
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(mocks.acceptOperation).toHaveBeenCalledTimes(2);
  });

  it("maps conflicting request-key input to a stable, redacted 409", async () => {
    mocks.acceptOperation.mockRejectedValueOnce(new InvitationInputConflictError());
    const response = await request
      .post("/api/v1/admin/admins")
      .set("x-test-auth", "admin-sub")
      .send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ADMIN_INVITATION_REQUEST_CONFLICT");
    expect(JSON.stringify(response.body)).not.toMatch(/request-1|invited@example|provider|secret/i);
  });

  it("polls with no-store and the exact safe operation shape", async () => {
    const response = await request
      .get("/api/v1/admin/admin-invitation-operations/invitation-1")
      .set("x-test-auth", "admin-sub");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(operation);
    expect(JSON.stringify(response.body)).not.toMatch(forbidden);
    expect(mocks.getOperation).toHaveBeenCalledWith("invitation-1");
  });

  it("maps a missing operation to a stable, redacted 404", async () => {
    mocks.getOperation.mockRejectedValueOnce(
      new AdminInvitationOperationNotFoundError("Admin invitation operation not found"),
    );
    const response = await request
      .get("/api/v1/admin/admin-invitation-operations/missing")
      .set("x-test-auth", "admin-sub");
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ADMIN_INVITATION_OPERATION_NOT_FOUND");
    expect(JSON.stringify(response.body)).not.toMatch(/provider|credential|secret|token/i);
  });
});
