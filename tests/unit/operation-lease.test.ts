/**
 * Unit tests — operation-lease.ts (design threat matrix: concurrent
 * acquire → conflict; live lease never reclaimed).
 *
 * Runtime harness: real `fs.mkdir` atomic locking, real `process.kill(pid,
 * 0)` liveness checks, and a real spawned+exited child process to obtain a
 * guaranteed-dead PID for the reclaim test — no mocking.
 *
 * Spec: admin-database-backups — "Global operation serialization".
 */
import { spawn } from "child_process";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BackupOperationConflictError } from "@/shared/errors/errors";
import {
  acquireLease,
  reclaimDeadLease,
  touchHeartbeat,
} from "@/shared/database-backups/operation-lease";

let baseDir: string;
let root: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "operation-lease-test-"));
  root = baseDir;
  await mkdir(join(root, ".lease"), { recursive: true });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

/** Spawns a short-lived child process and resolves once it has fully exited. */
async function spawnAndWaitForExit(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("true", [], { shell: false });
    const pid = child.pid;
    if (!pid) {
      reject(new Error("failed to spawn child process"));
      return;
    }
    child.on("close", () => resolve(pid));
    child.on("error", reject);
  });
}

describe("acquireLease: concurrent acquire → conflict", () => {
  it("throws BackupOperationConflictError on a second concurrent acquire", async () => {
    const handle = await acquireLease(root, "op_001");
    expect(handle.operationId).toBe("op_001");
    expect(handle.ownerPid).toBe(process.pid);

    await expect(acquireLease(root, "op_002")).rejects.toBeInstanceOf(
      BackupOperationConflictError,
    );

    await handle.release();
  });

  it("allows a new acquire after release", async () => {
    const first = await acquireLease(root, "op_001");
    await first.release();

    const second = await acquireLease(root, "op_002");
    expect(second.operationId).toBe("op_002");
    await second.release();
  });

  it("release() is idempotent", async () => {
    const handle = await acquireLease(root, "op_001");
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe("reclaimDeadLease: live lease never reclaimed", () => {
  it("returns false and leaves the lease intact when ownerPid is the current (live) process", async () => {
    const handle = await acquireLease(root, "op_live");

    const reclaimed = await reclaimDeadLease(root);

    expect(reclaimed).toBe(false);
    const infoPath = join(root, ".lease", "global.lock", "info.json");
    const info = JSON.parse(await readFile(infoPath, "utf8")) as { ownerPid: number };
    expect(info.ownerPid).toBe(process.pid);

    await handle.release();
  });

  it("returns false when no lease is held", async () => {
    await expect(reclaimDeadLease(root)).resolves.toBe(false);
  });
});

describe("reclaimDeadLease: dead-PID reclaim (real spawned+exited process)", () => {
  it("reclaims a lease whose ownerPid belongs to a real, confirmed-exited process", async () => {
    const deadPid = await spawnAndWaitForExit();

    const lockDir = join(root, ".lease", "global.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "info.json"),
      JSON.stringify({
        operationId: "op_stale",
        ownerPid: deadPid,
        bootId: "previous-boot-id",
        acquiredAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );

    const reclaimed = await reclaimDeadLease(root);
    expect(reclaimed).toBe(true);

    // A fresh acquire must now succeed — proves the lock directory is gone.
    const handle = await acquireLease(root, "op_new");
    expect(handle.operationId).toBe("op_new");
    await handle.release();
  });
});

describe("touchHeartbeat", () => {
  it("rewrites heartbeatAt for the held lease", async () => {
    const handle = await acquireLease(root, "op_hb");
    const infoPath = join(root, ".lease", "global.lock", "info.json");
    const before = JSON.parse(await readFile(infoPath, "utf8")) as { heartbeatAt: string };

    await new Promise((r) => setTimeout(r, 5));
    await touchHeartbeat(root);

    const after = JSON.parse(await readFile(infoPath, "utf8")) as { heartbeatAt: string };
    expect(new Date(after.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.heartbeatAt).getTime(),
    );

    await handle.release();
  });
});
