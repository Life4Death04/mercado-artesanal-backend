/**
 * Unit tests — database-backups.service.ts `create()` and its async runner.
 *
 * SCOPE (tasks 3.1 + 3.2 only): covers ONLY the CREATE acceptance path and
 * the DUMPING → HASHING → PUBLISHING runner. This is a deliberate SUBSET of
 * the eventual task 3.8 RED suite (which also covers delete/restore/restart
 * reconciliation, tasks 3.3–3.7) — later work units EXTEND this same file;
 * task 3.8 stays unchecked until that full coverage lands.
 *
 * Runtime harness: a REAL per-test temp directory (`mkdtemp`) stands in for
 * the artifact root — `ensureArtifactStore`, `writeTempFile`, `chmod`,
 * `rename`, and the REAL `operation-lease.ts` (`mkdir`-based lock) all run
 * for real against it, so receipt persistence and lease acquire/release are
 * genuinely exercised on disk. Only the two modules that would otherwise
 * touch a real PostgreSQL host process are faked, per instruction ("fake
 * adapters ... no real pg_dump required"):
 *   - `postgres-tools.ts`: `assertTrustedExecutable` / `dumpDatabase` mocked
 *     (`parsePostgresUrl` stays REAL — pure URL parsing, no process).
 *   - `artifact-store.ts`: `resolveArtifactRoot` (redirected to the mkdtemp
 *     root instead of `env.BACKUP_ARTIFACT_DIR`), `publishArchive`, and
 *     `publishManifest` are mocked (`writeTempFile` stays REAL, wrapped so
 *     every receipt write is also recorded for stage-ordering assertions).
 *
 * Spec: admin-database-backups — "Backup creation and identity",
 *   "Trusted PostgreSQL runtime", "Atomic, private, redacted artifacts",
 *   "Global operation serialization".
 * Design: "Data Flow", "Storage and Safety".
 */
import { existsSync, writeFileSync } from "fs";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create, getOperation } from "@/modules/admin/services/database-backups.service";
import {
  ensureArtifactStore,
  operationPath,
  publishArchive,
  publishManifest,
  resolveArtifactRoot,
  writeTempFile,
} from "@/shared/database-backups/artifact-store";
import type { BackupManifestV1 } from "@/shared/database-backups/contracts";
import { acquireLease } from "@/shared/database-backups/operation-lease";
import { assertTrustedExecutable, dumpDatabase } from "@/shared/database-backups/postgres-tools";
import {
  BackupOperationConflictError,
  BackupOperationFailedError,
  BackupOperationNotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { env } from "@/shared/utils/env";
import { logger } from "@/shared/utils/logger";

vi.mock("@/shared/database-backups/artifact-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/database-backups/artifact-store")>();
  return {
    ...actual,
    resolveArtifactRoot: vi.fn(),
    // Wraps (not replaces) the real implementation: receipts are genuinely
    // written to disk AND every call is recorded for ordering assertions.
    writeTempFile: vi.fn(actual.writeTempFile),
    publishArchive: vi.fn(),
    publishManifest: vi.fn(),
  };
});

vi.mock("@/shared/database-backups/postgres-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/database-backups/postgres-tools")>();
  return {
    ...actual,
    assertTrustedExecutable: vi.fn(),
    dumpDatabase: vi.fn(),
  };
});

vi.mock("@/shared/database-backups/operation-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/database-backups/operation-lease")>();
  return {
    ...actual,
    acquireLease: vi.fn(actual.acquireLease),
  };
});

vi.mock("@/shared/utils/logger", () => ({
  logger: { error: vi.fn() },
}));

// Shrinks the deadline to 20ms (from the real 300000ms) so the "runner:
// deadline enforcement" suite below can exercise a genuine real-time race
// with REAL timers — no fake-timer/real-fs-I/O interleaving to reason
// about. Every other field (DATABASE_URL, PG_DUMP_PATH, ...) stays REAL,
// so every other test's assertions are unaffected.
vi.mock("@/shared/utils/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/utils/env")>();
  return {
    ...actual,
    env: { ...actual.env, BACKUP_OPERATION_TIMEOUT_MS: 20 },
  };
});

interface ReceiptSnapshot {
  readonly operationId: string;
  readonly backupId: string;
  readonly status: string;
  readonly stage: string | null;
  readonly failureReason: string | null;
}

/** Decodes every receipt body ever passed to `writeTempFile`, in call order. */
function receiptSnapshots(): ReceiptSnapshot[] {
  return vi.mocked(writeTempFile).mock.calls.map(([, data]) => {
    const buf = data;
    return JSON.parse(buf.toString("utf8")) as ReceiptSnapshot;
  });
}

function hostileError(): Error {
  const err = new Error(
    "HOSTILE_MESSAGE /secret/archive.dump --file argv-secret PGPASSWORD=env-secret https://user:pass@db.example/private stderr-secret database-name",
  );
  err.stack = "HOSTILE_STACK /secret/stack-path database-name";
  return err;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "database-backups-service-test-"));
  // Real layout, matching what create() itself provisions on first call —
  // set up upfront so tests that acquire a lease directly (bypassing
  // create()) don't race the service's own ensureArtifactStore() call.
  await ensureArtifactStore(root);

  vi.mocked(resolveArtifactRoot).mockResolvedValue(root);
  vi.mocked(assertTrustedExecutable).mockResolvedValue(undefined);
  vi.mocked(dumpDatabase).mockImplementation(async () => {
    /* default: succeeds without writing anything — overridden per-test */
  });
  vi.mocked(publishArchive).mockResolvedValue({
    archivePath: join(root, "archives", "fake.dump"),
    checksumSha256: "a".repeat(64),
    bytes: 1024,
  });
  vi.mocked(publishManifest).mockResolvedValue(join(root, "manifests", "fake.v1.json"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// create(): label validation
// ---------------------------------------------------------------------------

describe("create(): label validation", () => {
  it("rejects a label longer than 200 characters without acquiring a lease or writing anything", async () => {
    const tooLong = "x".repeat(201);

    await expect(create("actor-1", { label: tooLong })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(vi.mocked(writeTempFile)).not.toHaveBeenCalled();
  });

  it("normalizes a whitespace-only label to null and still accepts the request", async () => {
    const view = await create("actor-1", { label: "   " });
    expect(view.status).toBe("ACCEPTED");

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("SUCCEEDED");
    });

    const manifest = vi.mocked(publishManifest).mock.calls[0]?.[1];
    expect(manifest?.label).toBeNull();
  });

  it("trims a valid label before it reaches the manifest", async () => {
    await create("actor-1", { label: "  nightly  " });

    await vi.waitFor(() => {
      expect(vi.mocked(publishManifest)).toHaveBeenCalledTimes(1);
    });

    const manifest = vi.mocked(publishManifest).mock.calls[0]?.[1];
    expect(manifest?.label).toBe("nightly");
  });
});

// ---------------------------------------------------------------------------
// create(): lease acquisition
// ---------------------------------------------------------------------------

describe("create(): lease acquisition", () => {
  it("surfaces BackupOperationConflictError synchronously when another operation holds the lease, without writing a receipt", async () => {
    const held = await acquireLease(root, "already-running");

    await expect(create("actor-1", {})).rejects.toBeInstanceOf(BackupOperationConflictError);
    expect(vi.mocked(writeTempFile)).not.toHaveBeenCalled();

    await held.release();
  });
});

// ---------------------------------------------------------------------------
// create(): receipt-before-schedule/return ordering
// ---------------------------------------------------------------------------

describe("create(): receipt persistence precedes scheduling and return", () => {
  it("persists the ACCEPTED receipt before setImmediate is called, and before the promise resolves", async () => {
    const originalSetImmediate = global.setImmediate;
    let snapshotAtScheduleTime: ReceiptSnapshot[] = [];

    const setImmediateSpy = vi
      .spyOn(global, "setImmediate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((cb: (...args: unknown[]) => void, ...args: unknown[]) => {
        // Captured synchronously, BEFORE the real setImmediate ever runs the
        // runner body — proves persistence happened before scheduling.
        snapshotAtScheduleTime = receiptSnapshots();
        return originalSetImmediate(cb, ...args);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);

    const view = await create("actor-1", { label: "nightly" });

    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(snapshotAtScheduleTime).toHaveLength(1);
    expect(snapshotAtScheduleTime[0]?.status).toBe("ACCEPTED");
    expect(snapshotAtScheduleTime[0]?.stage).toBeNull();

    // The promise resolved with a safe ACCEPTED view — the runner has not
    // advanced any further at this point (still exactly 1 receipt write).
    expect(view.status).toBe("ACCEPTED");
    expect(view.stage).toBeNull();
    expect(receiptSnapshots()).toHaveLength(1);

    setImmediateSpy.mockRestore();

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("SUCCEEDED");
    });
  });

  it("returns a safe OperationView with no paths, args, or diagnostics", async () => {
    const view = await create("actor-1", {});

    expect(Object.keys(view).sort()).toEqual(
      [
        "backupId",
        "createdAt",
        "failureReason",
        "id",
        "links",
        "result",
        "status",
        "stage",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toMatch(/\.tmp\/|archives\/|manifests\//);

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("SUCCEEDED");
    });
  });
});

describe("getOperation(): persisted receipt projection", () => {
  it("returns only the safe OperationView with the public API self link", async () => {
    const accepted = await create("actor-1", {});
    const operation = await getOperation(accepted.id);

    expect(operation).toEqual(accepted);
    expect(operation.links.self).toBe(`/api/v1/admin/database-backup-operations/${accepted.id}`);
    expect(JSON.stringify(operation)).not.toMatch(/ownerPid|bootId|\.tmp\/|stderr/);

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("SUCCEEDED");
    });
  });

  it("maps missing, invalid, and malformed receipts to the typed 404", async () => {
    await expect(getOperation("missing-operation")).rejects.toBeInstanceOf(
      BackupOperationNotFoundError,
    );
    await expect(getOperation("../escape")).rejects.toBeInstanceOf(BackupOperationNotFoundError);

    writeFileSync(operationPath(root, "malformed"), "{/secret/internal/path");
    await expect(getOperation("malformed")).rejects.toBeInstanceOf(BackupOperationNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// runner: stage ordering
// ---------------------------------------------------------------------------

describe("runner: stage ordering", () => {
  it("advances the receipt through DUMPING → HASHING → PUBLISHING → SUCCEEDED, in order", async () => {
    const view = await create("actor-1", {});

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("SUCCEEDED");
    });

    const stages = receiptSnapshots().map((r) => `${r.status}:${r.stage ?? "null"}`);
    expect(stages).toEqual([
      "ACCEPTED:null",
      "RUNNING:DUMPING",
      "RUNNING:HASHING",
      "RUNNING:PUBLISHING",
      "SUCCEEDED:PUBLISHING",
    ]);

    for (const snap of receiptSnapshots()) {
      expect(snap.operationId).toBe(view.id);
      expect(snap.backupId).toBe(view.backupId);
    }

    expect(vi.mocked(assertTrustedExecutable)).toHaveBeenCalledWith(env.PG_DUMP_PATH, "pg_dump");
    expect(vi.mocked(dumpDatabase)).toHaveBeenCalledTimes(1);
    const [pgDumpPath, connection] = vi.mocked(dumpDatabase).mock.calls[0]!;
    expect(pgDumpPath).toBe(env.PG_DUMP_PATH);
    expect(connection).toMatchObject({ host: "localhost", database: "mercado_test" });
    expect(vi.mocked(publishArchive)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishManifest)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runner: manifest fields (redaction safety)
// ---------------------------------------------------------------------------

describe("runner: manifest fields", () => {
  it("publishes a manifest with safe fields and a host/db-only source fingerprint", async () => {
    await create("actor-42", { label: "weekly" });

    await vi.waitFor(() => {
      expect(vi.mocked(publishManifest)).toHaveBeenCalledTimes(1);
    });

    const manifest = vi.mocked(publishManifest).mock.calls[0]?.[1] as BackupManifestV1;
    expect(manifest).toMatchObject({
      version: 1,
      label: "weekly",
      actorId: "actor-42",
      toolVersion: "16",
      status: "AVAILABLE",
      components: [{ kind: "postgres" }],
      checksumSha256: "a".repeat(64),
      bytes: 1024,
    });
    expect(manifest.sourceFingerprint).toBe("localhost/mercado_test");
    expect(manifest.sourceFingerprint).not.toContain("postgres:postgres");
    expect(JSON.stringify(manifest)).not.toMatch(/PGPASSWORD|PGPASSFILE|\.tmp\//);
  });
});

// ---------------------------------------------------------------------------
// runner: failure handling, cleanup, and lease release
// ---------------------------------------------------------------------------

describe("runner: failure handling, cleanup, and lease release", () => {
  it("marks FAILED with the AppError's sanitized detail, cleans the temp dump, and releases the lease", async () => {
    vi.mocked(dumpDatabase).mockImplementation(async (_pgDumpPath, _connection, outputPath) => {
      writeFileSync(outputPath, "fake-dump-bytes");
    });
    vi.mocked(publishArchive).mockRejectedValueOnce(
      new BackupOperationFailedError("pg_dump failed"),
    );

    await create("actor-1", {});

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("FAILED");
    });

    const failed = receiptSnapshots().at(-1);
    expect(failed?.failureReason).toBe("pg_dump failed");
    expect(failed?.stage).toBe("HASHING");

    const outputPath = vi.mocked(dumpDatabase).mock.calls[0]?.[2] as string;
    expect(outputPath).toContain(join(root, ".tmp"));
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });

    // Lease released — a fresh acquire on the same root now succeeds.
    const handle = await acquireLease(root, "after-failure");
    await handle.release();
  });

  it("never leaks a raw non-AppError message into failureReason", async () => {
    vi.mocked(publishArchive).mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory, open '/secret/internal/path'"),
    );

    await create("actor-1", {});

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("FAILED");
    });

    const failed = receiptSnapshots().at(-1);
    expect(failed?.failureReason).toBe("Backup operation failed due to an internal error");
    expect(failed?.failureReason).not.toMatch(/secret|ENOENT|\//);
  });

  it("logs a bounded classification without hostile runner error content", async () => {
    vi.mocked(publishArchive).mockRejectedValueOnce(hostileError());

    const view = await create("actor-1", {});

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("FAILED");
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      {
        operationId: view.id,
        status: "FAILED",
        stage: "HASHING",
        reason: "INTERNAL_ERROR",
      },
      "database-backups: create operation failed",
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(
      /HOSTILE|secret|archive\.dump|PGPASSWORD|https:|database-name/,
    );
  });

  it("logs a bounded classification when persisting the failed runner receipt rejects", async () => {
    const realWriteTempFile = vi.mocked(writeTempFile).getMockImplementation();
    expect(realWriteTempFile).toBeDefined();
    vi.mocked(writeTempFile).mockImplementation(async (...args) => {
      const receipt = JSON.parse(args[1].toString("utf8")) as ReceiptSnapshot;
      if (receipt.status === "FAILED") {
        throw hostileError();
      }
      return realWriteTempFile!(...args);
    });
    vi.mocked(publishArchive).mockRejectedValueOnce(new BackupOperationFailedError("dump failed"));

    const view = await create("actor-1", {});

    await vi.waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        {
          operationId: view.id,
          status: "FAILED",
          stage: "HASHING",
          reason: "INTERNAL_ERROR",
        },
        "database-backups: failed to persist FAILED receipt",
      );
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(
      /HOSTILE|secret|archive\.dump|PGPASSWORD|https:|database-name/,
    );
  });

  it("logs a bounded classification without hostile scheduled-runner rejection content", async () => {
    const realAcquireLease = vi.mocked(acquireLease).getMockImplementation();
    expect(realAcquireLease).toBeDefined();
    vi.mocked(acquireLease).mockImplementationOnce(async (...args) => {
      const lease = await realAcquireLease!(...args);
      return {
        ...lease,
        release: vi.fn().mockRejectedValue(hostileError()),
      };
    });

    const view = await create("actor-1", {});

    await vi.waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        {
          operationId: view.id,
          status: "FAILED",
          stage: "RUNNER_FINALIZATION",
          reason: "INTERNAL_ERROR",
        },
        "database-backups: unhandled runner error",
      );
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toMatch(
      /HOSTILE|secret|archive\.dump|PGPASSWORD|https:|database-name/,
    );
  });
});

// ---------------------------------------------------------------------------
// runner: deadline enforcement
// ---------------------------------------------------------------------------

describe("runner: deadline enforcement", () => {
  it("keeps the lease until the aborted dump adapter confirms process termination", async () => {
    let capturedOutputPath = "";
    let abortObserved = false;
    let adapterTerminated = false;
    vi.mocked(dumpDatabase).mockImplementation((_pgDumpPath, _connection, outputPath, signal) => {
      capturedOutputPath = outputPath;
      writeFileSync(outputPath, "partial-dump");
      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            setTimeout(() => {
              adapterTerminated = true;
              reject(signal.reason);
            }, 40);
          },
          { once: true },
        );
      });
    });

    await create("actor-1", {});

    await vi.waitFor(() => expect(abortObserved).toBe(true));
    await expect(acquireLease(root, "too-early")).rejects.toBeInstanceOf(
      BackupOperationConflictError,
    );
    expect(adapterTerminated).toBe(false);

    await vi.waitFor(() => {
      expect(receiptSnapshots().at(-1)?.status).toBe("FAILED");
    });

    expect(adapterTerminated).toBe(true);
    const failed = receiptSnapshots().at(-1);
    expect(failed?.failureReason).toBe("Backup operation exceeded the configured timeout");

    expect(capturedOutputPath).toContain(join(root, ".tmp"));
    await vi.waitFor(() => {
      expect(existsSync(capturedOutputPath)).toBe(false);
    });

    const handle = await acquireLease(root, "after-timeout");
    await handle.release();
  });
});
