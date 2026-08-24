/**
 * Shared type contracts for the admin database backups feature.
 *
 * These are pure types/interfaces consumed by later phases (artifact store,
 * postgres tool adapters, service/runner, controller). No runtime logic
 * lives here — validation happens where each contract is produced/consumed.
 *
 * Spec: admin-database-backups — "Backup creation and identity",
 *   "Atomic, private, redacted artifacts", "Audited deletion",
 *   "Global operation serialization".
 * Design: "Storage and Safety", "Data Flow", "Interfaces / Contracts".
 */

// ---------------------------------------------------------------------------
// Manifest v1 — external, authoritative source of truth for a backup.
// Unknown `version` values MUST be treated as non-restorable by consumers
// (design "Storage and Safety": "Unknown versions are non-restorable").
// ---------------------------------------------------------------------------

export const BACKUP_MANIFEST_VERSION = 1 as const;

/** Only PostgreSQL is registered today (design "Component boundary"). */
export type BackupComponentKind = "postgres";

export interface BackupManifestV1 {
  readonly version: typeof BACKUP_MANIFEST_VERSION;
  readonly id: string;
  readonly label: string | null;
  readonly actorId: string;
  readonly createdAt: string;
  /** Redacted — host/db name only, never a raw connection string. */
  readonly sourceFingerprint: string;
  readonly toolVersion: string;
  readonly checksumSha256: string;
  readonly bytes: number;
  readonly status: "AVAILABLE";
  readonly components: readonly [{ readonly kind: BackupComponentKind }];
}

// ---------------------------------------------------------------------------
// Tombstone — non-sensitive audit record kept after a backup archive is
// deleted. Suppresses manifest reconciliation and blocks ID reuse
// (spec "Audited deletion").
// ---------------------------------------------------------------------------

export interface BackupTombstoneV1 {
  readonly version: 1;
  readonly id: string;
  readonly deletedByActorId: string;
  readonly deletedAt: string;
  readonly reasonHash: string;
}

// ---------------------------------------------------------------------------
// Operation receipt — durable state for create/delete/restore-preparation.
// Persisted BEFORE 202 Accepted; rewritten atomically per stage
// (design "Data Flow", spec "Global operation serialization").
// ---------------------------------------------------------------------------

export type BackupOperationType = "CREATE" | "DELETE" | "RESTORE_PREPARATION";

export type BackupOperationStatus = "ACCEPTED" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type BackupOperationStage =
  | "DUMPING"
  | "HASHING"
  | "PUBLISHING"
  | "TOMBSTONING"
  | "TARGET_CREATED"
  | "RESTORING"
  | "VERIFYING";

export interface BackupOperationReceipt {
  readonly operationId: string;
  readonly type: BackupOperationType;
  readonly backupId: string;
  readonly status: BackupOperationStatus;
  readonly stage: BackupOperationStage | null;
  readonly ownerPid: number;
  readonly bootId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Safe, non-sensitive failure summary — never a raw stack/args/paths. */
  readonly failureReason: string | null;
  readonly result: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// OperationView — API-safe projection of a receipt. Never exposes paths,
// diagnostics, args, env, or connection strings (design "Interfaces").
// ---------------------------------------------------------------------------

export interface OperationView {
  readonly id: string;
  readonly type: BackupOperationType;
  readonly status: BackupOperationStatus;
  readonly stage: BackupOperationStage | null;
  readonly backupId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureReason: string | null;
  readonly result: Record<string, unknown> | null;
  readonly links: { readonly self: string; readonly backup?: string };
}
