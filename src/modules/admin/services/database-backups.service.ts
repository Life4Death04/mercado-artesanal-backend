/**
 * Admin database backups service — `create()` acceptance path and the
 * in-process asynchronous CREATE runner (DUMPING → HASHING → PUBLISHING).
 *
 * All exports are NAMED FUNCTIONS (not a class, not a default export),
 * matching the rest of the codebase (e.g. `images.service.ts`).
 *
 * Scope: backup creation acceptance, its async runner, restart reconciliation,
 * startup readiness, and safe operation receipt polling. Delete, restore, and
 * listing are intentionally not implemented here.
 *
 * Data flow (design "Data Flow"):
 *   `validate → acquire lease → persist ACCEPTED receipt → return`
 *   `setImmediate runner → RUNNING → adapters → SUCCEEDED|FAILED → release lease`
 *
 * The ACCEPTED receipt is durably persisted and the safe `OperationView` is
 * built and returned BEFORE `setImmediate` is even called — scheduling the
 * runner is the last thing `create()` does. The runner body only executes
 * on a later event-loop turn, after `create()`'s promise has already
 * resolved (spec "Global operation serialization": "receipt persistence
 * MUST precede `202 Accepted`").
 *
 * Stage mapping onto the existing artifact-store adapters (documented
 * interpretation — no new adapter functions were added to keep this PR
 * scoped to `database-backups.service.ts`):
 *   - DUMPING:    `dumpDatabase()` writes the custom-format dump to a
 *                 same-filesystem temp path under `.tmp/`.
 *   - HASHING:    `publishArchive()` computes the SHA-256 checksum from the
 *                 temp file's actual bytes and finalizes it into
 *                 `archives/<id>.dump` (chmod 0600 + rename). The checksum
 *                 computation is the semantically significant part of this
 *                 stage; `publishArchive` couples it with the atomic
 *                 finalize rename (design threat matrix: "checksum
 *                 binding", "atomic publish order").
 *   - PUBLISHING: `publishManifest()` writes the catalog-authoritative
 *                 manifest — literally "publishing" the backup's identity.
 *
 * Deadline enforcement propagates an AbortSignal into the postgres-tools
 * adapter. That adapter terminates the child and waits for `close` before
 * rejecting, so `finally` cannot release the lease while pg_dump is alive.
 *
 * PII/redaction safety: `failureReason` is NEVER built from a raw
 * `Error.message` — only from a thrown `AppError`'s already-sanitized
 * `.detail`, or a generic fallback. Temp/archive/manifest paths are never
 * put in the receipt, the `OperationView`, or any log call.
 *
 * Spec: admin-database-backups — "Backup creation and identity",
 *   "Atomic, private, redacted artifacts", "Global operation serialization".
 * Design: "Data Flow", "Storage and Safety", "Interfaces / Contracts".
 */
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "fs/promises";
import { join } from "path";

import { z } from "zod";

import {
  archivePath,
  ensureArtifactStore,
  generateArtifactId,
  manifestPath,
  operationPath,
  publishArchive,
  publishManifest,
  resolveArtifactRoot,
  writeTempFile,
} from "@/shared/database-backups/artifact-store";
import {
  BACKUP_MANIFEST_VERSION,
  type BackupManifestV1,
  type BackupOperationReceipt,
  type BackupOperationStage,
  type BackupOperationStatus,
  type OperationView,
} from "@/shared/database-backups/contracts";
import {
  acquireLease,
  reclaimDeadLease,
  type LeaseHandle,
} from "@/shared/database-backups/operation-lease";
import {
  assertTrustedExecutable,
  dumpDatabase,
  parsePostgresUrl,
} from "@/shared/database-backups/postgres-tools";
import { AppError } from "@/shared/errors/AppError";
import {
  BackupOperationFailedError,
  BackupOperationNotFoundError,
  ValidationFailedError,
} from "@/shared/errors/errors";
import { env } from "@/shared/utils/env";
import { logger } from "@/shared/utils/logger";

// ---------------------------------------------------------------------------
// create() — validate, acquire lease, persist ACCEPTED, schedule, return.
// ---------------------------------------------------------------------------

export interface CreateBackupInput {
  readonly label?: string | null;
}

const MAX_LABEL_LENGTH = 200;

// Mirrors postgres-tools.ts's (unexported) REQUIRED_MAJOR_VERSION. Only the
// major version is recorded — full `--version` output is not captured here
// to avoid adding a new return value to an already-complete PR1 adapter.
const BACKUP_TOOL_VERSION = "16";
const OPERATION_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

const BackupOperationReceiptSchema = z
  .object({
    operationId: z.string(),
    type: z.enum(["CREATE", "DELETE", "RESTORE_PREPARATION"]),
    backupId: z.string(),
    status: z.enum(["ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED"]),
    stage: z
      .enum([
        "DUMPING",
        "HASHING",
        "PUBLISHING",
        "TOMBSTONING",
        "TARGET_CREATED",
        "RESTORING",
        "VERIFYING",
      ])
      .nullable(),
    ownerPid: z.number().int().positive(),
    bootId: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    failureReason: z.string().nullable(),
    result: z.record(z.unknown()).nullable(),
  })
  .strict();

const BackupManifestSchema = z
  .object({
    version: z.literal(BACKUP_MANIFEST_VERSION),
    id: z.string(),
    label: z.string().nullable(),
    actorId: z.string(),
    createdAt: z.string().datetime(),
    sourceFingerprint: z.string(),
    toolVersion: z.string(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    status: z.literal("AVAILABLE"),
    components: z.tuple([z.object({ kind: z.literal("postgres") }).strict()]),
  })
  .strict();

const RESTART_FAILURE_REASON = "Backup operation was interrupted by an application restart";

/**
 * Validates and normalizes the optional label: trims whitespace, treats an
 * empty/whitespace-only string as "no label" (`null`), and rejects labels
 * over `MAX_LABEL_LENGTH`. The HTTP DTO enforces the same limit; this keeps
 * direct service calls safe as well.
 */
function normalizeLabel(rawLabel: string | null | undefined): string | null {
  if (rawLabel === undefined || rawLabel === null) {
    return null;
  }
  const trimmed = rawLabel.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new ValidationFailedError(
      [{ path: "label", message: `Must be at most ${MAX_LABEL_LENGTH} characters` }],
      "Invalid label",
    );
  }
  return trimmed;
}

function toOperationView(receipt: BackupOperationReceipt): OperationView {
  return {
    id: receipt.operationId,
    type: receipt.type,
    status: receipt.status,
    stage: receipt.stage,
    backupId: receipt.backupId,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    failureReason: receipt.failureReason,
    result: receipt.result,
    links: { self: `/api/v1/admin/database-backup-operations/${receipt.operationId}` },
  };
}

export async function prepareDatabaseBackups(): Promise<void> {
  await mkdir(env.BACKUP_ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  const root = await resolveArtifactRoot(env.BACKUP_ARTIFACT_DIR);
  await ensureArtifactStore(root);
  await assertTrustedExecutable(env.PG_DUMP_PATH, "pg_dump");
  await reconcileBackupOperations(root);
}

async function reconcileBackupOperations(root: string): Promise<void> {
  await reclaimDeadLease(root);
  const lease = await acquireLease(root, `startup-${generateArtifactId()}`);

  try {
    const operationFiles = (await readdir(join(root, "operations")))
      .filter((name) => name.endsWith(".json"))
      .sort();

    for (const fileName of operationFiles) {
      const operationId = fileName.slice(0, -".json".length);
      if (!OPERATION_ID_PATTERN.test(operationId)) {
        continue;
      }

      const receipt = await readReceiptForReconciliation(root, operationId);
      if (!receipt || receipt.status === "SUCCEEDED" || receipt.status === "FAILED") {
        continue;
      }

      const completedManifest =
        receipt.type === "CREATE" ? await readCompletedManifest(root, receipt.backupId) : null;
      const now = new Date().toISOString();
      const reconciled: BackupOperationReceipt = completedManifest
        ? {
            ...receipt,
            status: "SUCCEEDED",
            stage: "PUBLISHING",
            updatedAt: now,
            failureReason: null,
            result: {
              checksumSha256: completedManifest.checksumSha256,
              bytes: completedManifest.bytes,
            },
          }
        : {
            ...receipt,
            status: "FAILED",
            updatedAt: now,
            failureReason: RESTART_FAILURE_REASON,
          };
      await persistReceipt(root, reconciled);
    }

    for (const entry of await readdir(join(root, ".tmp"))) {
      await rm(join(root, ".tmp", entry), { recursive: true, force: true });
    }
  } finally {
    await lease.release();
  }
}

async function readReceiptForReconciliation(
  root: string,
  operationId: string,
): Promise<BackupOperationReceipt | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(operationPath(root, operationId), "utf8"));
  } catch {
    return null;
  }

  const receipt = BackupOperationReceiptSchema.safeParse(parsed);
  if (!receipt.success || receipt.data.operationId !== operationId) {
    return null;
  }
  return receipt.data;
}

async function readCompletedManifest(
  root: string,
  backupId: string,
): Promise<BackupManifestV1 | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath(root, backupId), "utf8"));
  } catch (err) {
    if (
      err instanceof SyntaxError ||
      (err instanceof Error && "code" in err && err.code === "ENOENT")
    ) {
      return null;
    }
    throw err;
  }

  const manifest = BackupManifestSchema.safeParse(parsed);
  if (!manifest.success || manifest.data.id !== backupId) {
    return null;
  }

  try {
    const [checksumSha256, archiveStats] = await Promise.all([
      sha256File(archivePath(root, backupId)),
      stat(archivePath(root, backupId)),
    ]);
    if (
      checksumSha256 !== manifest.data.checksumSha256 ||
      archiveStats.size !== manifest.data.bytes
    ) {
      return null;
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  return manifest.data;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export async function getOperation(operationId: string): Promise<OperationView> {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new BackupOperationNotFoundError("Backup operation not found");
  }

  const root = await resolveArtifactRoot(env.BACKUP_ARTIFACT_DIR);
  let raw: string;
  try {
    raw = await readFile(operationPath(root, operationId), "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new BackupOperationNotFoundError("Backup operation not found");
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BackupOperationNotFoundError("Backup operation not found");
  }

  const receipt = BackupOperationReceiptSchema.safeParse(parsed);
  if (!receipt.success || receipt.data.operationId !== operationId) {
    throw new BackupOperationNotFoundError("Backup operation not found");
  }
  return toOperationView(receipt.data);
}

/**
 * Accepts a backup creation request: validates the label, acquires the
 * single global operation lease, durably persists an `ACCEPTED` receipt,
 * schedules the async runner, and returns immediately with a safe
 * `OperationView` — mirroring the eventual `202 Accepted` contract (spec
 * "Global operation serialization": "Lease acquisition and receipt
 * persistence MUST precede `202 Accepted`").
 *
 * Lease contention surfaces as `BackupOperationConflictError` (409) directly
 * from `acquireLease` — no receipt is written and no runner is scheduled
 * (spec "Mutation not accepted"). A receipt-persistence failure releases the
 * lease and starts no runner (design "Storage and Safety").
 */
export async function create(
  actorId: string,
  input: CreateBackupInput = {},
): Promise<OperationView> {
  if (!actorId) {
    throw new ValidationFailedError([{ path: "actorId", message: "Required" }], "Invalid actor");
  }
  const label = normalizeLabel(input.label);

  const root = await resolveArtifactRoot(env.BACKUP_ARTIFACT_DIR);
  await ensureArtifactStore(root);

  const operationId = generateArtifactId();
  const backupId = generateArtifactId();
  const lease = await acquireLease(root, operationId);

  const now = new Date().toISOString();
  const receipt: BackupOperationReceipt = {
    operationId,
    type: "CREATE",
    backupId,
    status: "ACCEPTED",
    stage: null,
    ownerPid: lease.ownerPid,
    bootId: lease.bootId,
    createdAt: now,
    updatedAt: now,
    failureReason: null,
    result: null,
  };

  try {
    await persistReceipt(root, receipt);
  } catch (err) {
    await lease.release();
    throw err;
  }

  // Scheduling happens LAST — after the receipt is durably persisted. The
  // runner body only executes on a later event-loop turn, strictly after
  // this function's promise has already resolved to its caller.
  setImmediate(() => {
    void runCreateRunner(root, lease, receipt, label, actorId).catch((err: unknown) => {
      logger.error(
        {
          operationId,
          status: "FAILED",
          stage: "RUNNER_FINALIZATION",
          reason: safeLogReason(err),
        },
        "database-backups: unhandled runner error",
      );
    });
  });

  return toOperationView(receipt);
}

// ---------------------------------------------------------------------------
// Async runner — DUMPING → HASHING → PUBLISHING, deadline-bounded,
// lease-released-in-finally.
// ---------------------------------------------------------------------------

interface RunnerState {
  receipt: BackupOperationReceipt;
  /** Set once DUMPING allocates a temp path and cleared after publish. */
  tempDumpPath: string | null;
}

async function runCreateRunner(
  root: string,
  lease: LeaseHandle,
  initialReceipt: BackupOperationReceipt,
  label: string | null,
  actorId: string,
): Promise<void> {
  const state: RunnerState = { receipt: initialReceipt, tempDumpPath: null };
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort(
      new BackupOperationFailedError("Backup operation exceeded the configured timeout"),
    );
  }, env.BACKUP_OPERATION_TIMEOUT_MS);

  try {
    await executeCreatePipeline(root, state, label, actorId, abortController.signal);
  } catch (err) {
    await failCreateOperation(root, state, err);
  } finally {
    clearTimeout(timeoutHandle);
    if (state.tempDumpPath) {
      await rm(state.tempDumpPath, { force: true }).catch(() => {
        /* best-effort — startup reconciliation removes any surviving orphan */
      });
    }
    await lease.release();
  }
}

async function executeCreatePipeline(
  root: string,
  state: RunnerState,
  label: string | null,
  actorId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await transitionStage(root, state, "RUNNING", "DUMPING");

  const connection = parsePostgresUrl(env.DATABASE_URL, env.BACKUP_DATABASE_HOST_ALLOWLIST);
  await assertTrustedExecutable(env.PG_DUMP_PATH, "pg_dump");

  state.tempDumpPath = join(root, ".tmp", `${randomUUID()}.dump.tmp`);
  await dumpDatabase(env.PG_DUMP_PATH, connection, state.tempDumpPath, signal);

  signal.throwIfAborted();
  await transitionStage(root, state, "RUNNING", "HASHING");
  const published = await publishArchive(root, state.tempDumpPath, state.receipt.backupId);
  // publishArchive renamed the temp file away — nothing left to clean up.
  state.tempDumpPath = null;

  signal.throwIfAborted();
  await transitionStage(root, state, "RUNNING", "PUBLISHING");
  const manifest: BackupManifestV1 = {
    version: BACKUP_MANIFEST_VERSION,
    id: state.receipt.backupId,
    label,
    actorId,
    createdAt: state.receipt.createdAt,
    // Redacted — host/db name only, never a raw connection string.
    sourceFingerprint: `${connection.host}/${connection.database}`,
    toolVersion: BACKUP_TOOL_VERSION,
    checksumSha256: published.checksumSha256,
    bytes: published.bytes,
    status: "AVAILABLE",
    components: [{ kind: "postgres" }],
  };
  await publishManifest(root, manifest);

  await transitionStage(root, state, "SUCCEEDED", "PUBLISHING", {
    checksumSha256: published.checksumSha256,
    bytes: published.bytes,
  });
}

async function transitionStage(
  root: string,
  state: RunnerState,
  status: BackupOperationStatus,
  stage: BackupOperationStage,
  result: Record<string, unknown> | null = null,
): Promise<void> {
  const updated: BackupOperationReceipt = {
    ...state.receipt,
    status,
    stage,
    updatedAt: new Date().toISOString(),
    result: result ?? state.receipt.result,
  };
  await persistReceipt(root, updated);
  state.receipt = updated;
}

async function failCreateOperation(root: string, state: RunnerState, err: unknown): Promise<void> {
  const failureReason = safeFailureReason(err);
  const failed: BackupOperationReceipt = {
    ...state.receipt,
    status: "FAILED",
    failureReason,
    updatedAt: new Date().toISOString(),
  };
  try {
    await persistReceipt(root, failed);
    state.receipt = failed;
  } catch (persistErr: unknown) {
    logger.error(
      {
        operationId: state.receipt.operationId,
        status: "FAILED",
        stage: state.receipt.stage,
        reason: safeLogReason(persistErr),
      },
      "database-backups: failed to persist FAILED receipt",
    );
  }
  logger.error(
    {
      operationId: state.receipt.operationId,
      status: "FAILED",
      stage: state.receipt.stage,
      reason: safeLogReason(err),
    },
    "database-backups: create operation failed",
  );
}

const SAFE_FILESYSTEM_ERROR_CODES = new Set(["EACCES", "EIO", "ENOENT", "ENOSPC", "EROFS"]);

function safeLogReason(err: unknown): string {
  if (err instanceof AppError) {
    return err.code;
  }
  if (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    SAFE_FILESYSTEM_ERROR_CODES.has(err.code)
  ) {
    return "FILESYSTEM_ERROR";
  }
  return "INTERNAL_ERROR";
}

/**
 * Maps any thrown value to a safe, non-sensitive failure summary. Only an
 * `AppError`'s already-sanitized `.detail` is ever used (every AppError
 * subclass thrown by the tool/artifact adapters is already redaction-safe —
 * see `postgres-tools.ts` / `target-database.ts`). Any other error (raw
 * filesystem `Error`s, etc.) maps to a generic fallback so a stack trace or
 * path can never leak into the receipt (design "Storage and Safety": "Never
 * log args/env/paths/stderr/URLs").
 */
function safeFailureReason(err: unknown): string {
  if (err instanceof AppError) {
    return err.detail;
  }
  return "Backup operation failed due to an internal error";
}

/**
 * Atomically persists a receipt to `operations/<operationId>.json`: same
 * write-temp-then-rename pattern as `artifact-store.ts`'s
 * `publishManifest`/`publishTombstone`, reusing its exported `writeTempFile`
 * + `operationPath` (no new artifact-store export needed).
 */
async function persistReceipt(root: string, receipt: BackupOperationReceipt): Promise<void> {
  const tempPath = await writeTempFile(root, Buffer.from(JSON.stringify(receipt), "utf8"));
  await chmod(tempPath, 0o600);
  await rename(tempPath, operationPath(root, receipt.operationId));
}
