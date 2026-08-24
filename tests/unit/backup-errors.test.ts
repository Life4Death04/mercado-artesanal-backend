/**
 * Unit tests — admin-database-backups AppError subclasses.
 *
 * Spec: admin-database-backups — typed error contract (design "Interfaces /
 * Contracts": 404 BACKUP_NOT_FOUND|BACKUP_OPERATION_NOT_FOUND, 409
 * BACKUP_NOT_RESTORABLE|BACKUP_OPERATION_CONFLICT, 503
 * BACKUP_RUNTIME_UNAVAILABLE, 500 BACKUP_OPERATION_FAILED).
 */
import { describe, expect, it } from "vitest";

import {
  BackupNotFoundError,
  BackupNotRestorableError,
  BackupOperationConflictError,
  BackupOperationFailedError,
  BackupOperationNotFoundError,
  BackupRuntimeUnavailableError,
} from "@/shared/errors/errors";

describe("admin-database-backups error subclasses", () => {
  it.each([
    [BackupNotFoundError, "BACKUP_NOT_FOUND", 404, "/errors/backup-not-found"],
    [
      BackupOperationNotFoundError,
      "BACKUP_OPERATION_NOT_FOUND",
      404,
      "/errors/backup-operation-not-found",
    ],
    [BackupNotRestorableError, "BACKUP_NOT_RESTORABLE", 409, "/errors/backup-not-restorable"],
    [
      BackupOperationConflictError,
      "BACKUP_OPERATION_CONFLICT",
      409,
      "/errors/backup-operation-conflict",
    ],
    [
      BackupRuntimeUnavailableError,
      "BACKUP_RUNTIME_UNAVAILABLE",
      503,
      "/errors/backup-runtime-unavailable",
    ],
    [BackupOperationFailedError, "BACKUP_OPERATION_FAILED", 500, "/errors/backup-operation-failed"],
  ] as const)("%s carries code %s, status %i, typeSlug %s", (ErrorClass, code, status, typeSlug) => {
    const err = new ErrorClass("detail");

    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.typeSlug).toBe(typeSlug);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ErrorClass);
  });
});
