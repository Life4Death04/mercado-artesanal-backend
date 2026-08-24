import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackupOperationNotFoundError } from "@/shared/errors/errors";

vi.mock("express-oauth2-jwt-bearer", () => ({
  auth:
    () =>
    (
      req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ): void => {
      const sub = req.headers["x-test-auth"];
      if (typeof sub !== "string") {
        next({ status: 401, name: "UnauthorizedError" });
        return;
      }
      req.auth = { payload: { sub } as never, header: {}, token: "test-token" };
      next();
    },
}));

const { findUser } = vi.hoisted(() => ({ findUser: vi.fn() }));
vi.mock("@/shared/utils/prisma", () => ({
  prisma: { user: { findUnique: findUser } },
}));

vi.mock("@/modules/admin/services/database-backups.service", () => ({
  create: vi.fn(),
  getOperation: vi.fn(),
  prepareDatabaseBackups: vi.fn(),
}));

import { adminRouter } from "@/modules/admin/routes/admin.routes";
import * as databaseBackupsService from "@/modules/admin/services/database-backups.service";
import { errorMiddleware } from "@/shared/middleware/errorMiddleware";

const operation = {
  id: "operation-1",
  type: "CREATE" as const,
  status: "ACCEPTED" as const,
  stage: null,
  backupId: "backup-1",
  createdAt: "2026-08-18T08:00:00.000Z",
  updatedAt: "2026-08-18T08:00:00.000Z",
  failureReason: null,
  result: null,
  links: { self: "/api/v1/admin/database-backup-operations/operation-1" },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = "backup-http-test";
  next();
});
app.use("/api/v1", adminRouter);
app.use(errorMiddleware);
const request = supertest(app);

beforeEach(() => {
  vi.clearAllMocks();
  findUser.mockResolvedValue({
    id: "admin-1",
    role: "ADMIN",
    email: "admin@example.test",
    deletedAt: null,
    deactivatedAt: null,
    producer: null,
  });
  vi.mocked(databaseBackupsService.create).mockResolvedValue(operation);
  vi.mocked(databaseBackupsService.getOperation).mockResolvedValue(operation);
});

describe("ADMIN database backup HTTP surface", () => {
  it("returns 401 without authentication", async () => {
    const response = await request.post("/api/v1/admin/database-backups").send({});

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for an authenticated non-ADMIN", async () => {
    findUser.mockResolvedValueOnce({
      id: "consumer-1",
      role: "CONSUMER",
      email: "consumer@example.test",
      deletedAt: null,
      deactivatedAt: null,
      producer: null,
    });

    const response = await request
      .post("/api/v1/admin/database-backups")
      .set("x-test-auth", "consumer-sub")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  it("returns 202 with polling headers and a safe operation body", async () => {
    const response = await request
      .post("/api/v1/admin/database-backups")
      .set("x-test-auth", "admin-sub")
      .send({ label: " nightly " });

    expect(response.status).toBe(202);
    expect(response.headers.location).toBe(operation.links.self);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.body).toEqual(operation);
    expect(databaseBackupsService.create).toHaveBeenCalledWith("admin-1", {
      label: "nightly",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/ownerPid|bootId|stderr|\/var\/|\.tmp/);
  });

  it("rejects unknown request keys before invoking the service", async () => {
    const response = await request
      .post("/api/v1/admin/database-backups")
      .set("x-test-auth", "admin-sub")
      .send({ label: "nightly", outputPath: "/secret/internal.dump" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(databaseBackupsService.create).not.toHaveBeenCalled();
  });

  it("polls successfully with no-store and the public self link", async () => {
    const response = await request
      .get("/api/v1/admin/database-backup-operations/operation-1")
      .set("x-test-auth", "admin-sub");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(operation);
    expect(databaseBackupsService.getOperation).toHaveBeenCalledWith("operation-1");
  });

  it("maps a missing poll receipt to the typed 404 without leaking diagnostics", async () => {
    vi.mocked(databaseBackupsService.getOperation).mockRejectedValueOnce(
      new BackupOperationNotFoundError("Backup operation not found"),
    );

    const response = await request
      .get("/api/v1/admin/database-backup-operations/missing")
      .set("x-test-auth", "admin-sub");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("BACKUP_OPERATION_NOT_FOUND");
    expect(JSON.stringify(response.body)).not.toMatch(/stderr|\/secret|\.tmp/);
  });
});
