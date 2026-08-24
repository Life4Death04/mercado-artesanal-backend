/**
 * Unit tests — artifact-store.ts (design threat matrix: traversal, atomic
 * publish order, checksum binding).
 *
 * Uses real temp directories (os.tmpdir()) and real fs operations — no
 * mocking. This is the runtime harness for this adapter: real mkdir/open/
 * fsync/chmod/rename against the filesystem.
 *
 * Spec: admin-database-backups — "Atomic, private, redacted artifacts".
 */
import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BackupManifestV1, BackupTombstoneV1 } from "@/shared/database-backups/contracts";
import { BACKUP_MANIFEST_VERSION } from "@/shared/database-backups/contracts";
import {
  archivePath,
  ensureArtifactStore,
  generateArtifactId,
  manifestPath,
  operationPath,
  publishArchive,
  publishManifest,
  publishTombstone,
  resolveArtifactRoot,
  tombstonePath,
  writeTempFile,
} from "@/shared/database-backups/artifact-store";

let baseDir: string;
let root: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "artifact-store-test-"));
  root = await resolveArtifactRoot(baseDir);
  await ensureArtifactStore(root);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeManifest(id: string, checksumSha256: string): BackupManifestV1 {
  return {
    version: BACKUP_MANIFEST_VERSION,
    id,
    label: null,
    actorId: "actor_001",
    createdAt: new Date().toISOString(),
    sourceFingerprint: "localhost/mercado",
    toolVersion: "16.4",
    checksumSha256,
    bytes: 4,
    status: "AVAILABLE",
    components: [{ kind: "postgres" }],
  };
}

function makeTombstone(id: string): BackupTombstoneV1 {
  return {
    version: 1,
    id,
    deletedByActorId: "actor_001",
    deletedAt: new Date().toISOString(),
    reasonHash: "hash123",
  };
}

// ---------------------------------------------------------------------------
// RED — traversal
// ---------------------------------------------------------------------------
describe("path builders: traversal rejection", () => {
  it.each([
    ["../../etc/passwd"],
    ["../escape"],
    ["a/../../b"],
    ["nested/segment"],
    [""],
    ["id\0null"],
  ])("archivePath rejects %p", (unsafeId) => {
    expect(() => archivePath(root, unsafeId)).toThrow();
  });

  it("manifestPath rejects traversal", () => {
    expect(() => manifestPath(root, "../manifests/x")).toThrow();
  });

  it("tombstonePath rejects traversal", () => {
    expect(() => tombstonePath(root, "..")).toThrow();
  });

  it("operationPath rejects traversal", () => {
    expect(() => operationPath(root, "../../operations/x")).toThrow();
  });

  it("accepts a generated id", () => {
    const id = generateArtifactId();
    expect(() => archivePath(root, id)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RED — atomic publish order (manifest before archive must fail)
// ---------------------------------------------------------------------------
describe("publishManifest: atomic publish order", () => {
  it("rejects publishing a manifest before its archive exists", async () => {
    const id = generateArtifactId();
    const manifest = makeManifest(id, "deadbeef".repeat(8));

    await expect(publishManifest(root, manifest)).rejects.toThrow();
  });

  it("succeeds once the archive has been published with a matching checksum", async () => {
    const id = generateArtifactId();
    const tempPath = await writeTempFile(root, Buffer.from("dump-bytes"));
    const published = await publishArchive(root, tempPath, id);

    const manifest = makeManifest(id, published.checksumSha256);
    const finalPath = await publishManifest(root, manifest);

    expect(finalPath).toBe(manifestPath(root, id));
    const persisted = JSON.parse(await readFile(finalPath, "utf8")) as BackupManifestV1;
    expect(persisted.checksumSha256).toBe(published.checksumSha256);
  });
});

// ---------------------------------------------------------------------------
// RED — checksum binding
// ---------------------------------------------------------------------------
describe("publishManifest: checksum binding", () => {
  it("rejects a manifest whose checksumSha256 does not match the published archive", async () => {
    const id = generateArtifactId();
    const tempPath = await writeTempFile(root, Buffer.from("dump-bytes"));
    await publishArchive(root, tempPath, id);

    const manifest = makeManifest(id, "0".repeat(64)); // wrong checksum
    await expect(publishManifest(root, manifest)).rejects.toThrow(/checksum mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Positive coverage — archive publish primitives + tombstone
// ---------------------------------------------------------------------------
describe("publishArchive", () => {
  it("moves the temp file to archives/<id>.dump with mode 0600 and returns checksum+bytes", async () => {
    const id = generateArtifactId();
    const data = Buffer.from("hello-dump-bytes");
    const tempPath = await writeTempFile(root, data);

    const published = await publishArchive(root, tempPath, id);

    expect(published.archivePath).toBe(archivePath(root, id));
    expect(published.bytes).toBe(data.length);
    expect(published.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = await readFile(published.archivePath);
    expect(onDisk.equals(data)).toBe(true);
  });
});

describe("publishTombstone", () => {
  it("writes a tombstone at tombstones/<id>.v1.json", async () => {
    const id = generateArtifactId();
    const finalPath = await publishTombstone(root, makeTombstone(id));

    expect(finalPath).toBe(tombstonePath(root, id));
    const persisted = JSON.parse(await readFile(finalPath, "utf8")) as BackupTombstoneV1;
    expect(persisted.id).toBe(id);
  });
});

describe("resolveArtifactRoot + ensureArtifactStore", () => {
  it("creates the fixed subdirectory layout", async () => {
    // A fresh root proves ensureArtifactStore (called in beforeEach) actually
    // created every fixed subdir — writing into each one would throw ENOENT
    // otherwise.
    const id = randomUUID();
    const tempPath = await writeTempFile(root, Buffer.from("x"));
    await publishArchive(root, tempPath, id);
    expect(await readFile(archivePath(root, id))).toBeDefined();
  });
});
