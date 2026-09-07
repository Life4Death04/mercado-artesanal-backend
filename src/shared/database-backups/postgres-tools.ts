/**
 * Host PostgreSQL Client 16 tool adapter — trusted executable validation and
 * fixed-vector `spawn(shell:false)` wrappers for `pg_dump`/`pg_restore`.
 *
 * Design "Trusted PostgreSQL runtime": absolute executables from host
 * Client 16 only; PATH lookup, other majors, shells, Docker, and untrusted
 * arguments MUST be rejected.
 *
 * `assertTrustedExecutable` rejects a non-absolute path BEFORE any spawn
 * call — `spawn(shell:false)` with a relative/bare command resolves through
 * PATH, which absolute-only input makes structurally unreachable. Every
 * fixed-vector wrapper below only ever passes internally-constructed paths
 * and a validated allow-listed connection as argv; `shell:false` means any
 * metacharacter those values contain reaches `execve()` literally, never a
 * shell.
 *
 * Spec: admin-database-backups — "Trusted PostgreSQL runtime".
 * Design: "Storage and Safety".
 */
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { lstat, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";

import { BackupOperationFailedError, BackupRuntimeUnavailableError } from "../errors/errors";

const REQUIRED_MAJOR_VERSION = 16;

// ---------------------------------------------------------------------------
// Process boundary — single spawn(shell:false) primitive shared by every
// fixed-vector wrapper and the version probe below.
// ---------------------------------------------------------------------------

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  execPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(execPath, args, { shell: false, env });
    let stdout = "";
    let stderr = "";
    let spawnError: unknown;
    let forceKillHandle: NodeJS.Timeout | undefined;
    let abortStarted = false;

    const abort = (): void => {
      if (abortStarted) return;
      abortStarted = true;
      child.kill("SIGTERM");
      forceKillHandle = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKillHandle.unref();
    };

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (forceKillHandle) clearTimeout(forceKillHandle);

      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Process aborted"));
      } else if (spawnError) {
        reject(spawnError instanceof Error ? spawnError : new Error("Process failed to start"));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Executable trust validation — boot-time gate (design: "boot fails closed").
// ---------------------------------------------------------------------------

/**
 * Rejects any executable that is not absolute, regular, non-symlink,
 * executable, and reporting PostgreSQL major 16 via `--version`. Throws
 * `BackupRuntimeUnavailableError` (503) on any failure — callers MUST treat
 * this as "operations remain unavailable without tool execution" for the
 * dump/restore work itself (spec "Invalid tool").
 */
export async function assertTrustedExecutable(execPath: string, label: string): Promise<void> {
  if (!isAbsolute(execPath)) {
    throw new BackupRuntimeUnavailableError(
      `${label}: relative or PATH-resolved executables are not trusted`,
    );
  }

  let stats;
  try {
    stats = await lstat(execPath);
  } catch {
    throw new BackupRuntimeUnavailableError(`${label}: executable not found`);
  }

  if (stats.isSymbolicLink()) {
    throw new BackupRuntimeUnavailableError(`${label}: symlinked executables are not trusted`);
  }
  if (!stats.isFile()) {
    throw new BackupRuntimeUnavailableError(`${label}: not a regular file`);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new BackupRuntimeUnavailableError(`${label}: not executable`);
  }

  const major = await probeMajorVersion(execPath, label);
  if (major !== REQUIRED_MAJOR_VERSION) {
    throw new BackupRuntimeUnavailableError(
      `${label}: unsupported PostgreSQL major version (expected ${REQUIRED_MAJOR_VERSION})`,
    );
  }
}

async function probeMajorVersion(execPath: string, label: string): Promise<number> {
  const result = await runProcess(execPath, ["--version"]);
  if (result.code !== 0) {
    throw new BackupRuntimeUnavailableError(`${label}: version check failed`);
  }
  const match = /\)\s+(\d+)(?:\.\d+)*/.exec(result.stdout);
  return match ? Number(match[1]) : NaN;
}

// ---------------------------------------------------------------------------
// Allow-listed connection URL parsing — shared by dump/restore env
// construction here and by target-database.ts's maintenance URL builder.
// ---------------------------------------------------------------------------

export interface LoopbackConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Parses a PostgreSQL URL, allowing loopback plus explicitly supplied hosts. */
export function parsePostgresUrl(
  rawUrl: string,
  additionalAllowedHosts: readonly string[] = [],
): LoopbackConnection {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BackupRuntimeUnavailableError("Invalid PostgreSQL connection URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new BackupRuntimeUnavailableError("Unsupported PostgreSQL connection URL scheme");
  }

  // IPv6 hostnames come back bracketed (e.g. "[::1]") from the WHATWG URL parser.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...additionalAllowedHosts.map((host) => host.toLowerCase())]);
  if (!allowedHosts.has(hostname)) {
    throw new BackupRuntimeUnavailableError("PostgreSQL connection host is not allow-listed");
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) {
    throw new BackupRuntimeUnavailableError("PostgreSQL connection URL is missing a database name");
  }

  return {
    host: hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

// ---------------------------------------------------------------------------
// Temporary PGPASSFILE — never PGPASSWORD in env (design: "temporary 0600
// PGPASSFILE").
// ---------------------------------------------------------------------------

async function withPassfile<T>(
  password: string,
  fn: (passfilePath: string) => Promise<T>,
): Promise<T> {
  const passfilePath = join(tmpdir(), `pgpass-${randomBytes(8).toString("hex")}`);
  await writeFile(passfilePath, `*:*:*:*:${password}\n`, { mode: 0o600 });
  try {
    return await fn(passfilePath);
  } finally {
    await rm(passfilePath, { force: true });
  }
}

function buildPgEnv(source: LoopbackConnection, passfilePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: source.host,
    PGPORT: String(source.port),
    PGUSER: source.user,
    PGDATABASE: source.database,
    PGPASSFILE: passfilePath,
  };
}

// ---------------------------------------------------------------------------
// Fixed-vector spawn wrappers (design "Storage and Safety").
// ---------------------------------------------------------------------------

/** `pg_dump --format=custom --no-owner --no-privileges --file <outputPath>` */
export async function dumpDatabase(
  pgDumpPath: string,
  source: LoopbackConnection,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await withPassfile(source.password, async (passfilePath) => {
    const result = await runProcess(
      pgDumpPath,
      ["--format=custom", "--no-owner", "--no-privileges", "--file", outputPath],
      buildPgEnv(source, passfilePath),
      signal,
    );
    if (result.code !== 0) {
      throw new BackupOperationFailedError("pg_dump failed");
    }
  });
}

/** `pg_restore --list <archivePath>` — no connection required. */
export async function listArchiveContents(
  pgRestorePath: string,
  archivePath: string,
): Promise<string> {
  const result = await runProcess(pgRestorePath, ["--list", archivePath]);
  if (result.code !== 0) {
    throw new BackupOperationFailedError("pg_restore --list failed");
  }
  return result.stdout;
}

/** `pg_restore --exit-on-error --no-owner --no-privileges --dbname <target> <archivePath>` */
export async function restoreArchive(
  pgRestorePath: string,
  target: LoopbackConnection,
  archivePath: string,
): Promise<void> {
  await withPassfile(target.password, async (passfilePath) => {
    const result = await runProcess(
      pgRestorePath,
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        target.database,
        archivePath,
      ],
      buildPgEnv(target, passfilePath),
    );
    if (result.code !== 0) {
      throw new BackupOperationFailedError("pg_restore failed");
    }
  });
}
