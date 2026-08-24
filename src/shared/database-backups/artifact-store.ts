/**
 * Private artifact filesystem store — realpath'd root, atomic
 * write-temp-then-publish, and CUID-style opaque IDs.
 *
 * Fixed layout under the resolved root (design "Storage and Safety"):
 *   archives/<id>.dump           — pg_dump custom-format output (0600)
 *   manifests/<id>.v1.json       — BackupManifestV1 (0600)
 *   tombstones/<id>.v1.json      — BackupTombstoneV1 (0600)
 *   operations/<operationId>.json — reserved for the phase-3 runner
 *   .tmp/                        — same-filesystem staging area
 *   .lease/                      — reserved for operation-lease.ts
 *
 * ID note: design calls these "CUID paths". This module generates opaque
 * ids with `crypto.randomUUID()` — the same opaque-id pattern already used
 * for storage keys in src/modules/images/services/images.service.ts. What
 * the threat matrix actually requires (traversal-safe, filesystem-safe,
 * collision-resistant path segments) is satisfied by UUIDv4; no `cuid`
 * dependency is added for this narrow adapter. Flagged as a documented
 * interpretation in the apply-progress artifact, not a silent deviation.
 *
 * Safety invariants enforced here (design threat matrix — traversal, atomic
 * publish order, checksum binding):
 *   - Every id/operationId is validated against an allowlist charset before
 *     it is ever joined into a path — rejects `..`, `/`, and any other
 *     traversal payload structurally, not by blocklist.
 *   - `publishArchive` writes to `.tmp/`, fsyncs, chmods 0600, then renames
 *     into `archives/` — same filesystem by construction (temp dir is a
 *     child of the same root).
 *   - `publishManifest` recomputes the archive's SHA-256 from the file that
 *     is ALREADY at its final path and rejects a mismatch against the
 *     manifest's `checksumSha256`. Because it reads the final archive path,
 *     it also structurally enforces "archive before manifest" — publishing
 *     a manifest before its archive exists fails with ENOENT.
 *
 * Spec: admin-database-backups — "Atomic, private, redacted artifacts".
 * Design: "Storage and Safety".
 */
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { chmod, mkdir, open, realpath, rename, stat } from "fs/promises";
import { join } from "path";

import type { BackupManifestV1, BackupTombstoneV1 } from "./contracts";

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * Realpath's `rawDir` (resolving symlinks) so every later path join operates
 * on a canonical absolute root. Throws if the directory does not exist —
 * callers create it out-of-band (deployment provisioning, design "Migration
 * / Rollout": "Provision ... storage ... boot fails closed").
 */
export async function resolveArtifactRoot(rawDir: string): Promise<string> {
  return realpath(rawDir);
}

const SUBDIRS = ["archives", "manifests", "tombstones", "operations", ".tmp", ".lease"] as const;

/** Creates the fixed subdirectory layout (idempotent, mode 0700). */
export async function ensureArtifactStore(root: string): Promise<void> {
  for (const sub of SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// ID generation and path safety
// ---------------------------------------------------------------------------

/** Opaque, path-safe, collision-resistant id (see file header ID note). */
export function generateArtifactId(): string {
  return randomUUID();
}

// Allowlist-only: rejects `..`, `/`, `\0`, and everything else that is not a
// plain filename-safe token. This is the single traversal defense point —
// every path builder below routes through it before joining any path.
const SAFE_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`artifact-store: unsafe ${label} rejected (traversal or invalid characters)`);
  }
}

export function archivePath(root: string, id: string): string {
  assertSafeId(id, "backup id");
  return join(root, "archives", `${id}.dump`);
}

export function manifestPath(root: string, id: string): string {
  assertSafeId(id, "backup id");
  return join(root, "manifests", `${id}.v1.json`);
}

export function tombstonePath(root: string, id: string): string {
  assertSafeId(id, "backup id");
  return join(root, "tombstones", `${id}.v1.json`);
}

export function operationPath(root: string, operationId: string): string {
  assertSafeId(operationId, "operation id");
  return join(root, "operations", `${operationId}.json`);
}

// ---------------------------------------------------------------------------
// Temp staging + checksum
// ---------------------------------------------------------------------------

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Writes `data` into `.tmp/<uuid>.tmp` under `root`, fsync'ing before
 * returning so the bytes are durable ahead of any later rename (design
 * "Write same-filesystem temps, fsync, chmod, then rename").
 */
export async function writeTempFile(root: string, data: Buffer): Promise<string> {
  const tempPath = join(root, ".tmp", `${randomUUID()}.tmp`);
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tempPath;
}

/** Same staging helper for JSON documents (manifest/tombstone). */
async function writeTempJson(root: string, value: unknown): Promise<string> {
  return writeTempFile(root, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
}

// ---------------------------------------------------------------------------
// Atomic publish
// ---------------------------------------------------------------------------

export interface PublishedArchive {
  readonly archivePath: string;
  readonly checksumSha256: string;
  readonly bytes: number;
}

/**
 * Publishes a staged temp file as the archive for `id`: fsync (already done
 * by `writeTempFile`), chmod 0600, rename into `archives/<id>.dump`. Returns
 * the checksum/size computed from the temp file's actual bytes so the caller
 * cannot construct a manifest with a checksum that was never verified.
 */
export async function publishArchive(
  root: string,
  tempPath: string,
  id: string,
): Promise<PublishedArchive> {
  const finalPath = archivePath(root, id);
  const [checksumSha256, { size: bytes }] = await Promise.all([
    sha256File(tempPath),
    stat(tempPath),
  ]);
  await chmod(tempPath, 0o600);
  await rename(tempPath, finalPath);
  return { archivePath: finalPath, checksumSha256, bytes };
}

/**
 * Publishes a manifest. Structurally enforces "archive before manifest" and
 * checksum binding: it recomputes SHA-256 from the archive already at its
 * final path (throws ENOENT if that archive was never published) and
 * rejects a mismatch against `manifest.checksumSha256` before writing
 * anything (design threat matrix: "atomic publish order", "checksum
 * binding").
 */
export async function publishManifest(root: string, manifest: BackupManifestV1): Promise<string> {
  const finalArchivePath = archivePath(root, manifest.id);
  const actualChecksum = await sha256File(finalArchivePath);
  if (actualChecksum !== manifest.checksumSha256) {
    throw new Error(
      `artifact-store: checksum mismatch publishing manifest id=${manifest.id} — refusing to publish`,
    );
  }
  const tempPath = await writeTempJson(root, manifest);
  await chmod(tempPath, 0o600);
  const finalPath = manifestPath(root, manifest.id);
  await rename(tempPath, finalPath);
  return finalPath;
}

/** Publishes a tombstone (no archive-existence coupling — deletion may follow). */
export async function publishTombstone(root: string, tombstone: BackupTombstoneV1): Promise<string> {
  const tempPath = await writeTempJson(root, tombstone);
  await chmod(tempPath, 0o600);
  const finalPath = tombstonePath(root, tombstone.id);
  await rename(tempPath, finalPath);
  return finalPath;
}
