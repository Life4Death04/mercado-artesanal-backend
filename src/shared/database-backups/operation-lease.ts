/**
 * Global operation lease — single-host mutual exclusion for backup
 * create/delete/restore-preparation mutations via an atomic `mkdir` lock
 * directory (design "Atomic local lease vs Redis/queue": "`mkdir` lease
 * serializes mutations without new infrastructure").
 *
 * `fs.mkdir` on a non-recursive, previously-nonexistent path is atomic at
 * the filesystem level: exactly one caller's `mkdir` wins when two
 * processes race the same path, and the loser observes `EEXIST` — that
 * race outcome IS the lock (spec "Global operation serialization").
 *
 * Reclaim: only startup calls `reclaimDeadLease` (design: "only startup may
 * break a stale, dead-PID lease"). A held lease whose `ownerPid` is still
 * alive is NEVER reclaimed, even across a boot-id change — the spec is
 * explicit ("ownership MUST be released only for a confirmed-dead owner").
 *
 * Spec: admin-database-backups — "Global operation serialization".
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";

import { BackupOperationConflictError } from "../errors/errors";

// Generated once per process start. A lease recorded under a DIFFERENT
// bootId is provably from an earlier process invocation of this same host.
const PROCESS_BOOT_ID = randomUUID();

const LEASE_LOCK_DIR = "global.lock";
const LEASE_INFO_FILE = "info.json";

interface LeaseInfo {
  readonly operationId: string;
  readonly ownerPid: number;
  readonly bootId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export interface LeaseHandle {
  readonly operationId: string;
  readonly ownerPid: number;
  readonly bootId: string;
  release(): Promise<void>;
}

function lockDirPath(root: string): string {
  return join(root, ".lease", LEASE_LOCK_DIR);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs no action but still validates whether the process
    // exists and is signalable — the standard liveness check.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process → confirmed dead. Any other errno (e.g. EPERM,
    // process exists but is owned by another user) is treated conservatively
    // as alive — never reclaim on ambiguous evidence.
    return isNodeError(err) ? err.code !== "ESRCH" : true;
  }
}

/**
 * Acquires the single global lease via atomic `mkdir`. Throws
 * `BackupOperationConflictError` (409) when another mutation already holds
 * it (spec "Mutation not accepted": "lease contention MUST return a
 * deterministic conflict").
 */
export async function acquireLease(root: string, operationId: string): Promise<LeaseHandle> {
  const lockPath = lockDirPath(root);
  try {
    await mkdir(lockPath);
  } catch (err) {
    if (isNodeError(err) && err.code === "EEXIST") {
      throw new BackupOperationConflictError("Another backup operation is already in progress");
    }
    throw err;
  }

  const now = new Date().toISOString();
  const info: LeaseInfo = {
    operationId,
    ownerPid: process.pid,
    bootId: PROCESS_BOOT_ID,
    acquiredAt: now,
    heartbeatAt: now,
  };
  await writeFile(join(lockPath, LEASE_INFO_FILE), JSON.stringify(info), { mode: 0o600 });

  let released = false;
  return {
    operationId,
    ownerPid: info.ownerPid,
    bootId: info.bootId,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

/** Rewrites `heartbeatAt` for the currently-held lease (runner keep-alive). */
export async function touchHeartbeat(root: string): Promise<void> {
  const lockPath = lockDirPath(root);
  const infoPath = join(lockPath, LEASE_INFO_FILE);
  const raw = await readFile(infoPath, "utf8");
  const info = JSON.parse(raw) as LeaseInfo;
  const updated: LeaseInfo = { ...info, heartbeatAt: new Date().toISOString() };
  await writeFile(infoPath, JSON.stringify(updated), { mode: 0o600 });
}

/**
 * Startup-only reclaim: if a lease exists and its `ownerPid` is confirmed
 * dead, removes the lock directory and returns `true`. A live owner's lease
 * is left untouched and this returns `false` — as does the "no lease held"
 * case (design "Restart reconciliation": "reclaim dead-PID lease").
 */
export async function reclaimDeadLease(root: string): Promise<boolean> {
  const lockPath = lockDirPath(root);
  const infoPath = join(lockPath, LEASE_INFO_FILE);

  let info: LeaseInfo;
  try {
    const raw = await readFile(infoPath, "utf8");
    info = JSON.parse(raw) as LeaseInfo;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }

  if (isPidAlive(info.ownerPid)) {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
}
